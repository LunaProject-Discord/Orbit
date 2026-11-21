import type { MicrosoftOAuthConfig } from "@mail/core";
import type { Database } from "@mail/db";
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
