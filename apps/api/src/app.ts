import { CHANNEL_GRAPH_PUSH } from "@mail/core";
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
import { failureRoutes } from "./routes/failures.js";
import { focusRoutes } from "./routes/focus.js";
import { mailboxRoutes } from "./routes/mailboxes.js";
import { messageRoutes } from "./routes/messages.js";
import { pushRoutes } from "./routes/push.js";
import { sendRoutes } from "./routes/send.js";
import { syncRoutes } from "./routes/sync.js";
import { webhookRoutes } from "./routes/webhooks.js";

export type AppOptions = {
  db: Database;
  auth: Auth;
  hub: EventsHub;
  /** CORS を許可するオリジン (Web、Tauri、Capacitor)。 */
  allowedOrigins: string[];
  encryptionKey: Buffer;
  allowPrivateMailHosts: boolean;
  microsoft: RouteDeps["microsoft"];
  google: RouteDeps["google"];
  webPushPublicKey: string | null;
};

export function createApp({
  db,
  auth,
  hub,
  allowedOrigins,
  encryptionKey,
  allowPrivateMailHosts,
  microsoft,
  google,
  webPushPublicKey,
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

  // Microsoft Graph から直接呼ばれる。ログインの代わりに、通知に付く合言葉で確かめる。
  v1.route(
    "/",
    webhookRoutes({
      encryptionKey,
      notify: async (payload) => {
        await db.execute(
          sql`select pg_notify(${CHANNEL_GRAPH_PUSH}, ${JSON.stringify(payload)})`,
        );
      },
    }),
  );

  const authed = new Hono<AppEnv>();
  authed.use(requireUser(auth));
  authed.get("/me", (c) => c.json({ user: c.var.user }));
  const deps = {
    db,
    encryptionKey,
    allowPrivateMailHosts,
    microsoft,
    google,
    webPushPublicKey,
  };
  authed.route("/accounts", accountRoutes(deps));
  authed.route("/mailboxes", mailboxRoutes(deps));
  authed.route("/focus", focusRoutes(deps));
  authed.route("/attachments", attachmentRoutes());
  authed.route("/push", pushRoutes(deps));
  // /messages/:id より先に、送信 (/messages/send、/messages/outgoing) と
  // 反映の失敗 (/messages/failures) を登録する。
  authed.route("/messages", sendRoutes(deps));
  authed.route("/messages", failureRoutes(deps));
  authed.route("/messages", messageRoutes(deps));
  authed.route("/", syncRoutes({ db, hub }));
  v1.route("/", authed);

  app.route("/v1", v1);

  return app;
}
