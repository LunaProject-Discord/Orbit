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
  sweepAttachments,
} from "@orbit/core";
import { createDb, drafts } from "@orbit/db";
import { AccountManager } from "./account-manager.js";
import {
  combineSenders,
  DevicePushSender,
  PushSender,
  webPushTransport,
} from "./new-mail.js";

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
const manager = new AccountManager(
  db,
  databaseUrl,
  encryptionKey,
  loadMicrosoftOAuthConfig(process.env),
  // API が公開された HTTPS の URL で動いていれば、Microsoft Graph の変更通知を使う。
  graphWebhookBaseUrl(process.env.API_PUBLIC_URL),
  // 開発用のローカルサーバーを登録できる設定のときは、TLS の無い SMTP も許す。
  process.env.ALLOW_PRIVATE_MAIL_HOSTS === "true",
  loadGoogleOAuthConfig(process.env),
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
console.log(
  `同期ワーカーを起動しました (同期中のアカウント: ${manager.count} 件)`,
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

async function shutdown() {
  clearInterval(sweepTimer);
  await manager.stop();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
