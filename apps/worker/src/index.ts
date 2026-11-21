import {
  attachmentsDir,
  graphWebhookBaseUrl,
  loadEncryptionKey,
  loadGoogleOAuthConfig,
  loadMicrosoftOAuthConfig,
  loadWebPushConfig,
  sweepAttachments,
} from "@mail/core";
import { createDb } from "@mail/db";
import { AccountManager } from "./account-manager.js";
import { PushSender, webPushTransport } from "./new-mail.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL が設定されていません。");
}
const encryptionKey = loadEncryptionKey(process.env.CREDENTIALS_ENCRYPTION_KEY);

const webPush = loadWebPushConfig(process.env);

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
  // 新着メールの通知 (Web Push)。VAPID の鍵が無ければ送らない。
  webPush && new PushSender(db, webPushTransport(webPush)),
);
await manager.start();
console.log(
  `同期ワーカーを起動しました (同期中のアカウント: ${manager.count} 件)`,
);
if (!webPush) {
  console.log(
    "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY が未設定のため、Web Push の通知は送りません。",
  );
}

// 既読や移動などの操作とメールの送信 (送信待ちキュー) は、各アカウントの同期が処理する。

// 送信用に受け取った添付ファイルは、7 日たったら消す (送信済みのものも、送らなかったものも)。
const ATTACHMENT_KEEP_MS = 7 * 24 * 60 * 60_000;
const sweep = () =>
  sweepAttachments(attachmentsDir(), ATTACHMENT_KEEP_MS).catch((error) => {
    console.error("古い添付ファイルを消せませんでした。", error);
  });
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
