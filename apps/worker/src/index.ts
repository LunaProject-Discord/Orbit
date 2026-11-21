import { createDb, mailAccounts } from "@mail/db";
import { count } from "drizzle-orm";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL が設定されていません。");
}

const { db, pool } = createDb(databaseUrl);

// IMAP の常時接続と送信キューの処理はここに追加していく。
// 現時点では DB に接続できることだけを確認して待機する。
const [row] = await db.select({ accounts: count() }).from(mailAccounts);
console.log(
  `同期ワーカーを起動しました (登録アカウント: ${row?.accounts ?? 0} 件)`,
);

const keepAlive = setInterval(() => {}, 60_000);

async function shutdown() {
  clearInterval(keepAlive);
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
