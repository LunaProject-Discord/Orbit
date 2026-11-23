import type { GoogleOAuthConfig, MicrosoftOAuthConfig } from "@orbit/core";
import type { Database } from "@orbit/db";
import { createMiddleware } from "hono/factory";
import type { Auth } from "./auth.js";

export type AppEnv = {
  Variables: {
    user: { id: string; email: string; name: string };
  };
};

export type RouteDeps = {
  db: Database;
  encryptionKey: Buffer;
  allowPrivateMailHosts: boolean;
  microsoft: { config: MicrosoftOAuthConfig; redirectUri: string } | null;
  google: { config: GoogleOAuthConfig; redirectUri: string } | null;
  /** Web Push の公開鍵 (VAPID)。未設定なら null で、端末は画面を開いている間だけ通知する。 */
  webPushPublicKey: string | null;
  /** スマホアプリへの通知 (FCM) をサーバーが送れるか。 */
  fcmEnabled: boolean;
};

/** ログイン済みであることを確かめ、利用者を c.var.user に入れる。 */
export function requireUser(auth: Auth) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) {
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set("user", {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    });
    await next();
  });
}
