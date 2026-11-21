import { serve } from "@hono/node-server";
import { createDb } from "@mail/db";
import { createApp } from "./app.js";
import { createAuth } from "./auth.js";
import { loadEnv } from "./env.js";
import { EventsHub } from "./lib/events-hub.js";

const env = loadEnv();
const { db, pool } = createDb(env.databaseUrl);
const auth = createAuth({
  db,
  secret: env.authSecret,
  baseURL: env.publicUrl,
  trustedOrigins: env.allowedOrigins,
});
const hub = new EventsHub(env.databaseUrl);
await hub.start();

const app = createApp({
  db,
  auth,
  hub,
  allowedOrigins: env.allowedOrigins,
  encryptionKey: env.encryptionKey,
  allowPrivateMailHosts: env.allowPrivateMailHosts,
  microsoft: env.microsoft,
});

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`API サーバーを起動しました: http://localhost:${info.port}`);
});

async function shutdown() {
  server.close();
  await hub.stop();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
