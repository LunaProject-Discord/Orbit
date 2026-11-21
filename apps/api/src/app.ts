import type { Database } from "@mail/db";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Auth } from "./auth.js";
import { type AppEnv, type RouteDeps, requireUser } from "./context.js";
import type { EventsHub } from "./lib/events-hub.js";
import { accountRoutes } from "./routes/accounts.js";
import { attachmentRoutes } from "./routes/attachments.js";
import { messageRoutes } from "./routes/messages.js";
import { sendRoutes } from "./routes/send.js";
import { syncRoutes } from "./routes/sync.js";

export type AppOptions = {
  db: Database;
  auth: Auth;
  hub: EventsHub;
  /** CORS を許可するオリジン (Web、Tauri、Capacitor)。 */
  allowedOrigins: string[];
  encryptionKey: Buffer;
  allowPrivateMailHosts: boolean;
  microsoft: RouteDeps["microsoft"];
};

export function createApp({
  db,
  auth,
  hub,
  allowedOrigins,
  encryptionKey,
  allowPrivateMailHosts,
  microsoft,
}: AppOptions) {
  const app = new Hono();

  app.use(logger());
  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization", "X-Filename"],
      // ログイン時に Better Auth が返すセッショントークンをブラウザから読めるようにする。
      exposeHeaders: ["set-auth-token"],
    }),
  );

  app.get("/healthz", async (c) => {
    try {
      await db.execute(sql`select 1`);
      return c.json({ status: "ok" });
    } catch {
      return c.json({ status: "error", reason: "database" }, 503);
    }
  });

  const v1 = new Hono<AppEnv>();
  v1.get("/", (c) => c.json({ name: "mail-api", version: 1 }));

  // ログイン、ログアウト、セッション取得は Better Auth が処理する。
  v1.on(["GET", "POST"], "/auth/*", (c) => auth.handler(c.req.raw));

  const authed = new Hono<AppEnv>();
  authed.use(requireUser(auth));
  authed.get("/me", (c) => c.json({ user: c.var.user }));
  const deps = { db, encryptionKey, allowPrivateMailHosts, microsoft };
  authed.route("/accounts", accountRoutes(deps));
  authed.route("/attachments", attachmentRoutes());
  // /messages/:id より先に、送信 (/messages/send、/messages/outgoing) を登録する。
  authed.route("/messages", sendRoutes(deps));
  authed.route("/messages", messageRoutes(deps));
  authed.route("/", syncRoutes({ db, hub }));
  v1.route("/", authed);

  app.route("/v1", v1);

  return app;
}
