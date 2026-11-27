import {
  attachmentKey,
  attachmentsDir,
  FcmClient,
  graphWebhookBaseUrl,
  loadEncryptionKey,
  loadFcmConfig,
  loadGoogleOAuthConfig,
  loadMicrosoftOAuthConfig,
  loadWebPushConfig,
  notificationActionUrl,
  type SendPayload,
  sweepAttachments,
} from "@orbit/core";
import { createDb, drafts, outbox } from "@orbit/db";
import { and, eq, inArray } from "drizzle-orm";
import { AccountManager } from "./account-manager.js";
import { CalendarSyncManager } from "./calendar/manager.js";
import {
  refreshDueSubscriptions,
  SUBSCRIPTION_BATCH,
} from "./calendar-subscriptions.js";
import { buildChangesIndex } from "./changes-index.js";
import {
  combineSenders,
  DevicePushSender,
  PushSender,
  webPushTransport,
} from "./new-mail.js";
import { buildSearchIndex } from "./search-index.js";
import { failStaleImipSends } from "./send.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL が設定されていません。");
}
const encryptionKey = loadEncryptionKey(process.env.CREDENTIALS_ENCRYPTION_KEY);

const webPush = loadWebPushConfig(process.env);
const fcm = loadFcmConfig(process.env);

// 通知のボタンを押したときの送り先 (API)。URL が分からなければ、ボタンを付けない。
const actionUrl = notificationActionUrl(process.env.API_PUBLIC_URL);
const pushActions = actionUrl ? { key: encryptionKey, url: actionUrl } : null;

const { db, pool } = createDb(databaseUrl);
const microsoftOAuth = loadMicrosoftOAuthConfig(process.env);
const googleOAuth = loadGoogleOAuthConfig(process.env);
const manager = new AccountManager(
  db,
  databaseUrl,
  encryptionKey,
  microsoftOAuth,
  // API が公開された HTTPS の URL で動いていれば、Microsoft Graph の変更通知を使う。
  graphWebhookBaseUrl(process.env.API_PUBLIC_URL),
  // 開発用のローカルサーバーを登録できる設定のときは、TLS の無い SMTP も許す。
  process.env.ALLOW_PRIVATE_MAIL_HOSTS === "true",
  googleOAuth,
  // 新着メールの通知。ブラウザーへは Web Push (VAPID の鍵が無ければ送らない)、
  // スマホアプリへは FCM (FCM_SERVICE_ACCOUNT が無ければ送らない)。
  combineSenders([
    webPush &&
      new PushSender(db, webPushTransport(webPush), console.warn, pushActions),
    fcm &&
      new DevicePushSender(db, new FcmClient(fcm), console.warn, pushActions),
  ]),
);
await manager.start();
// カレンダーの同期は、メールの同期とは別に、カレンダーを使うアカウントごとに動かす。
const calendarManager = new CalendarSyncManager(db, databaseUrl, {
  encryptionKey,
  google: googleOAuth,
  microsoft: microsoftOAuth,
  webhookBaseUrl: graphWebhookBaseUrl(process.env.API_PUBLIC_URL),
  allowPrivateHosts: process.env.ALLOW_PRIVATE_MAIL_HOSTS === "true",
});
await calendarManager.start();
console.log(
  `同期ワーカーを起動しました (同期中のアカウント: ${manager.count} 件、カレンダー: ${calendarManager.count} 件)`,
);
if (!fcm) {
  console.log(
    "FCM_SERVICE_ACCOUNT が未設定のため、スマホアプリへの通知は送りません。",
  );
}
if (!webPush) {
  console.log(
    "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY が未設定のため、Web Push の通知は送りません。",
  );
}

// 取り込み済みのメールの検索用の文字列と、検索の索引を裏で作る (そろっていれば確かめるだけ)。
let stopping = false;
void buildSearchIndex(pool, { stopped: () => stopping }).catch((error) => {
  console.error("検索の索引を作れませんでした。", error);
});
// 変更履歴 (changes) の削除の部分索引も、表を止めないよう裏で作る (あれば確かめるだけ)。
void buildChangesIndex(pool, { stopped: () => stopping }).catch((error) => {
  console.error("変更履歴の索引を作れませんでした。", error);
});

// 既読や移動などの操作とメールの送信 (送信待ちキュー) は、各アカウントの同期が処理する。

// 置き場の添付ファイルは、7 日たったら消す (送信用に受け取ったものも、受信メールから
// 取得した写しも)。受信メールの添付は、次に開いたときにメールサーバーから取得し直す。
// 下書きに付いているファイルは、下書きがある間は残す。
const ATTACHMENT_KEEP_MS = 7 * 24 * 60 * 60_000;
const sweep = async () => {
  try {
    const rows = await db
      .select({ userId: drafts.userId, attachments: drafts.attachments })
      .from(drafts);
    const keep = new Set(
      rows.flatMap((row) =>
        row.attachments.map((file) => attachmentKey(row.userId, file.id)),
      ),
    );
    // 送信待ち (予約送信を含む) と失敗したメールの添付も、送り直せるように残す。
    const sends = await db
      .select({ payload: outbox.payload })
      .from(outbox)
      .where(
        and(
          eq(outbox.kind, "send"),
          inArray(outbox.status, ["pending", "processing", "failed"]),
        ),
      );
    for (const { payload } of sends) {
      const { message } = payload as unknown as SendPayload;
      for (const file of message?.attachments ?? []) {
        if (file.storageKey) keep.add(file.storageKey);
      }
    }
    await sweepAttachments(
      attachmentsDir(),
      ATTACHMENT_KEEP_MS,
      Date.now(),
      keep,
    );
  } catch (error) {
    console.error("古い添付ファイルを消せませんでした。", error);
  }
};
void sweep();
const sweepTimer = setInterval(sweep, 60 * 60_000);

// 送信元のアカウントの同期が止まっていて (再ログイン待ちなど) 送れない招待メールは、
// 1 時間たったら失敗として利用者に知らせる (imip レビュー M8)。10 分ごとに確かめる。
const staleInvites = async () => {
  try {
    const count = await failStaleImipSends(db);
    if (count > 0)
      console.log(`送れていない招待メール ${count} 通を失敗にしました。`);
  } catch (error) {
    console.error("送れていない招待メールを確かめられませんでした。", error);
  }
};
void staleInvites();
const staleInviteTimer = setInterval(staleInvites, 10 * 60_000);

// ICS の購読を、カレンダーごとの間隔 (既定 1 時間) で取得し直す。1 分ごとに時期を確かめる。
let refreshing = false;
const refreshSubscriptions = async () => {
  if (refreshing || stopping) return;
  refreshing = true;
  try {
    // 一度に確かめる数を超えて溜まっていれば、続けて確かめる。
    while (!stopping) {
      const count = await refreshDueSubscriptions(db, {
        allowPrivate: process.env.ALLOW_PRIVATE_MAIL_HOSTS === "true",
      });
      if (count < SUBSCRIPTION_BATCH) break;
    }
  } catch (error) {
    console.error("カレンダーの購読を確かめられませんでした。", error);
  } finally {
    refreshing = false;
  }
};
void refreshSubscriptions();
const subscriptionTimer = setInterval(refreshSubscriptions, 60_000);

async function shutdown() {
  stopping = true;
  clearInterval(sweepTimer);
  clearInterval(staleInviteTimer);
  clearInterval(subscriptionTimer);
  await calendarManager.stop();
  await manager.stop();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
