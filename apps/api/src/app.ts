import { CHANNEL_GRAPH_PUSH } from "@orbit/core";
import { type Database, users } from "@orbit/db";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Auth } from "./auth.js";
import { type AppEnv, type RouteDeps, requireUser } from "./context.js";
import {
  AUTH_STATE_HEADER,
  withAuthStateCookie,
  withAuthStateHeader,
} from "./lib/auth-state.js";
import type { EventsHub } from "./lib/events-hub.js";
import {
  createSenderIconService,
  defaultIconDeps,
} from "./lib/sender-icons.js";
import type { SystemMailer } from "./lib/system-mail.js";
import type { BuildInfo, UpdatePolicy } from "./lib/update-policy.js";
import { accountRoutes } from "./routes/accounts.js";
import { attachmentRoutes } from "./routes/attachments.js";
import { contactRoutes } from "./routes/contacts.js";
import { draftRoutes } from "./routes/drafts.js";
import { failureRoutes } from "./routes/failures.js";
import { focusRoutes } from "./routes/focus.js";
import {
  invitationPublicRoutes,
  invitationRoutes,
} from "./routes/invitations.js";
import { mailboxRoutes } from "./routes/mailboxes.js";
import { messageRoutes } from "./routes/messages.js";
import { notificationActionRoutes } from "./routes/notification-actions.js";
import { pushRoutes } from "./routes/push.js";
import { searchRoutes } from "./routes/search.js";
import { authFeatureRoutes, securityRoutes } from "./routes/security.js";
import { sendRoutes } from "./routes/send.js";
import { senderIconRoutes } from "./routes/sender-icons.js";
import { serverInfoRoutes } from "./routes/server-info.js";
import { settingsRoutes } from "./routes/settings.js";
import { signatureRoutes } from "./routes/signatures.js";
import { syncRoutes } from "./routes/sync.js";
import { unifiedRoutes } from "./routes/unified.js";
import { webhookRoutes } from "./routes/webhooks.js";

export type AppOptions = {
  db: Database;
  auth: Auth;
  /** 新規登録を受け付ける設定の Better Auth。招待リンクからの登録にだけ使う。 */
  signUpAuth: Auth;
  hub: EventsHub;
  /** CORS を許可するオリジン (Web、Tauri、Capacitor)。 */
  allowedOrigins: string[];
  encryptionKey: Buffer;
  allowPrivateMailHosts: boolean;
  microsoft: RouteDeps["microsoft"];
  google: RouteDeps["google"];
  webPushPublicKey: string | null;
  fcmEnabled: boolean;
  /** Web の URL (メールのリンクから戻る先)。 */
  webOrigin: string;
  /** 利用者へメールを送る手段。null なら再設定とメールアドレスの変更は使えない。 */
  mailer: SystemMailer | null;
  /** 動いているサーバーの版。 */
  build: BuildInfo;
  /** サーバーとアプリの更新の方針 (deploy/.env の ORBIT_*)。 */
  updatePolicy: UpdatePolicy;
  /** アプリ本体の配布用のファイルの置き場 (APP_RELEASES_DIR)。null なら本体は配らない。 */
  appReleasesDir: string | null;
  /** 外から見た API の URL (API_PUBLIC_URL)。 */
  publicUrl: string;
};

export function createApp({
  db,
  auth,
  signUpAuth,
  hub,
  allowedOrigins,
  encryptionKey,
  allowPrivateMailHosts,
  microsoft,
  google,
  webPushPublicKey,
  fcmEnabled,
  webOrigin,
  mailer,
  build,
  updatePolicy,
  appReleasesDir,
  publicUrl,
}: AppOptions) {
  const app = new Hono();

  app.use(logger());
  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-Filename",
        AUTH_STATE_HEADER,
      ],
      // ログイン時に Better Auth が返すセッショントークンと、2 段階認証・パスキーの
      // 途中の値 (lib/auth-state.ts) をブラウザから読めるようにする。
      exposeHeaders: ["set-auth-token", AUTH_STATE_HEADER, "X-Icon-Source"],
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
  // 版と更新の方針。ログイン前にも読めるようにする。
  v1.route(
    "/",
    serverInfoRoutes({
      build,
      policy: updatePolicy,
      releasesDir: appReleasesDir,
      publicUrl,
    }),
  );

  // ログイン、ログアウト、セッション取得は Better Auth が処理する。
  // メールアドレスの変更は、パスワードを確かめる /v1/security/email からだけ受け付ける。
  v1.all("/auth/change-email", (c) => c.json({ error: "not_found" }, 404));
  // Better Auth が Cookie で持つ途中の値は、X-Auth-State ヘッダーで受け渡す。
  v1.on(["GET", "POST"], "/auth/*", async (c) =>
    withAuthStateHeader(await auth.handler(withAuthStateCookie(c.req.raw))),
  );
  v1.route("/", authFeatureRoutes({ mailEnabled: mailer !== null }));

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

  // 通知のボタンから呼ばれる。ログインの代わりに、通知に付けた合言葉で確かめる。
  v1.route("/", notificationActionRoutes({ db, encryptionKey }));

  // 招待リンクを開いた人 (まだ利用者ではない) が呼ぶ。リンクの合言葉で確かめる。
  v1.route("/", invitationPublicRoutes({ db, signUpAuth }));

  const authed = new Hono<AppEnv>();
  authed.use(requireUser(auth));
  authed.get("/me", async (c) => {
    const [row] = await db
      .select({ isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, c.var.user.id));
    return c.json({ user: { ...c.var.user, isAdmin: row?.isAdmin ?? false } });
  });
  const deps = {
    db,
    encryptionKey,
    allowPrivateMailHosts,
    microsoft,
    google,
    webPushPublicKey,
    fcmEnabled,
  };
  authed.route("/accounts", accountRoutes(deps));
  authed.route("/mailboxes", mailboxRoutes(deps));
  authed.route("/unified", unifiedRoutes(deps));
  authed.route("/settings", settingsRoutes(deps));
  authed.route(
    "/security",
    securityRoutes({
      db,
      auth,
      webOrigin,
      mailEnabled: mailer !== null,
      mailer,
    }),
  );
  authed.route("/signatures", signatureRoutes(deps));
  authed.route("/contacts", contactRoutes(deps));
  authed.route("/invitations", invitationRoutes({ db, webOrigin }));
  authed.route("/focus", focusRoutes(deps));
  authed.route("/attachments", attachmentRoutes({ db, hub }));
  authed.route("/push", pushRoutes(deps));
  authed.route("/drafts", draftRoutes(deps));
  authed.route(
    "/sender-icons",
    senderIconRoutes({
      icons: createSenderIconService(
        db,
        defaultIconDeps(allowPrivateMailHosts),
      ),
    }),
  );
  // /messages/:id より先に、送信 (/messages/send、/messages/outgoing) と
  // 反映の失敗 (/messages/failures) を登録する。
  authed.route("/messages", sendRoutes(deps));
  authed.route("/messages", failureRoutes(deps));
  // 検索 (/messages/search) も /messages/:id より先に登録する。
  authed.route("/messages", searchRoutes(deps));
  authed.route("/messages", messageRoutes({ db, hub }));
  authed.route("/", syncRoutes({ db, hub }));
  v1.route("/", authed);

  app.route("/v1", v1);

  return app;
}
