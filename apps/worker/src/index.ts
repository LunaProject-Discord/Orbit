import { loadEncryptionKey, loadMicrosoftOAuthConfig } from "@mail/core";
import { createDb } from "@mail/db";
import { AccountManager } from "./account-manager.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL が設定されていません。");
}
const encryptionKey = loadEncryptionKey(process.env.CREDENTIALS_ENCRYPTION_KEY);

const { db, pool } = createDb(databaseUrl);
const manager = new AccountManager(
  db,
  databaseUrl,
  encryptionKey,
  loadMicrosoftOAuthConfig(process.env),
);
await manager.start();
console.log(
  `同期ワーカーを起動しました (同期中のアカウント: ${manager.count} 件)`,
);

// 送信キュー (outbox) の処理は今後ここに追加する。

async function shutdown() {
  await manager.stop();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
