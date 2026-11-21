import type { Database } from "@mail/db";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Auth } from "./auth.js";
import { type AppEnv, requireUser } from "./context.js";
import type { EventsHub } from "./lib/events-hub.js";
import { accountRoutes } from "./routes/accounts.js";
import { messageRoutes } from "./routes/messages.js";
import { syncRoutes } from "./routes/sync.js";

export type AppOptions = {
  db: Database;
  auth: Auth;
  hub: EventsHub;
  /** CORS を許可するオリジン (Web、Tauri、Capacitor)。 */
  allowedOrigins: string[];
  encryptionKey: Buffer;
  allowPrivateMailHosts: boolean;
};

export function createApp({
  db,
  auth,
  hub,
  allowedOrigins,
  encryptionKey,
  allowPrivateMailHosts,
}: AppOptions) {
  const app = new Hono();

  app.use(logger());
  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization"],
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
  const deps = { db, encryptionKey, allowPrivateMailHosts };
  authed.route("/accounts", accountRoutes(deps));
  authed.route("/messages", messageRoutes(deps));
  authed.route("/", syncRoutes({ db, hub }));
  v1.route("/", authed);

  app.route("/v1", v1);

  return app;
}
