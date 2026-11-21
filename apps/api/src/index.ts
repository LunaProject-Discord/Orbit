import { serve } from "@hono/node-server";
import { createDb } from "@mail/db";
import { createApp } from "./app.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL が設定されていません。");
}

const port = Number(process.env.API_PORT ?? 8787);
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const { db, pool } = createDb(databaseUrl);
const app = createApp({ db, allowedOrigins });

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API サーバーを起動しました: http://localhost:${info.port}`);
});

async function shutdown() {
  server.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
