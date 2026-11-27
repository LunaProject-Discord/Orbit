import { zValidator } from "@hono/zod-validator";
import {
  adminPasskeys,
  adminSessions,
  adminUsers,
  type Database,
  users,
} from "@orbit/db";
import { isAPIError } from "better-auth/api";
import { asc, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import {
  ADMIN_AUTH_ALLOWED_PATHS,
  ADMIN_AUTH_BASE_PATH,
  ADMIN_MAX_PASSWORD_LENGTH,
  ADMIN_MIN_PASSWORD_LENGTH,
  ADMIN_USERNAME_MAX,
  ADMIN_USERNAME_MIN,
  ADMIN_USERNAME_PATTERN,
  type AdminAuth,
  adminPlaceholderEmail,
} from "../admin-auth.js";
import { withoutCookies } from "../context.js";
import type { SetupCode } from "../lib/admin-setup.js";
import { withAuthStateCookie, withAuthStateHeader } from "../lib/auth-state.js";
import type { SsoClientResolver } from "../lib/sso-providers.js";
import { adminSsoRoutes } from "./admin-sso.js";
import { invitationRoutes } from "./invitations.js";

export type AdminEnv = {
  Variables: {
    admin: { id: string; username: string; name: string };
  };
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を弾くための正規表現
const noControl = /^[^\u0000-\u001f\u007f]*$/;

export const adminUsername = z
  .string()
  .trim()
  .toLowerCase()
  .min(ADMIN_USERNAME_MIN)
  .max(ADMIN_USERNAME_MAX)
  .regex(ADMIN_USERNAME_PATTERN);
const displayName = z.string().trim().min(1).max(100).regex(noControl);

const setupBody = z.object({
  code: z.string().max(100),
  username: z.string().max(200),
  name: z.string().max(200),
  password: z.string().min(1).max(1024),
});

/** 管理者としてログインしていることを確かめ、c.var.admin に入れる。 */
export function requireAdmin(adminAuth: AdminAuth) {
  return createMiddleware<AdminEnv>(async (c, next) => {
    const session = await adminAuth.api.getSession({
      headers: withoutCookies(c.req.raw.headers),
    });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const user = session.user as typeof session.user & { username?: string };
    c.set("admin", {
      id: user.id,
      username: user.username ?? "",
      name: user.name,
    });
    await next();
  });
}

/** 管理者の人数。 */
export async function countAdmins(db: Database): Promise<number> {
  const [row] = await db.select({ total: count() }).from(adminUsers);
  return row?.total ?? 0;
}

export type CreateAdminResult =
  | { ok: true; id: string; username: string }
  | {
      ok: false;
      error:
        | "invalid_username"
        | "invalid_name"
        | "password_too_short"
        | "password_too_long"
        | "username_taken";
    };

/**
 * 管理者を作る (コマンドと初回セットアップが使う)。
 * signUpAuth は、作成を受け付ける設定の管理者用 Better Auth。外の受け口には出さない。
 */
export async function createAdmin(
  db: Database,
  signUpAuth: AdminAuth,
  input: { username: string; name: string; password: string },
): Promise<CreateAdminResult> {
  const name = adminUsername.safeParse(input.username);
  if (!name.success) return { ok: false, error: "invalid_username" };
  const display = displayName.safeParse(input.name);
  if (!display.success) return { ok: false, error: "invalid_name" };
  if (input.password.length < ADMIN_MIN_PASSWORD_LENGTH) {
    return { ok: false, error: "password_too_short" };
  }
  if (input.password.length > ADMIN_MAX_PASSWORD_LENGTH) {
    return { ok: false, error: "password_too_long" };
  }
  const [existing] = await db
    .select({ id: adminUsers.id })
    .from(adminUsers)
    .where(eq(adminUsers.username, name.data));
  if (existing) return { ok: false, error: "username_taken" };
  try {
    const { user } = await signUpAuth.api.signUpEmail({
      body: {
        email: adminPlaceholderEmail(name.data),
        name: display.data,
        password: input.password,
        username: name.data,
        displayUsername: name.data,
      },
    });
    // 作成と同時にできるセッションは使わない (2 段階認証なども通る通常のログインをする)。
    await db.delete(adminSessions).where(eq(adminSessions.userId, user.id));
    return { ok: true, id: user.id, username: name.data };
  } catch (error) {
    if (isAPIError(error)) {
      const code = error.body?.code;
      if (
        code === "USER_ALREADY_EXISTS" ||
        code === "USERNAME_IS_ALREADY_TAKEN"
      )
        return { ok: false, error: "username_taken" };
      return { ok: false, error: "invalid_username" };
    }
    throw error;
  }
}

type Deps = {
  db: Database;
  adminAuth: AdminAuth;
  adminSignUpAuth: AdminAuth;
  setupCode: SetupCode;
  webOrigin: string;
  encryptionKey: Buffer;
  /** IdP の URL に http を許す (開発用、ALLOW_PRIVATE_MAIL_HOSTS)。 */
  allowHttp: boolean;
  ssoClients: SsoClientResolver;
};

/** 管理画面の API。/v1/admin の下に置く。 */
export function adminRoutes({
  db,
  adminAuth,
  adminSignUpAuth,
  setupCode,
  webOrigin,
  encryptionKey,
  allowHttp,
  ssoClients,
}: Deps) {
  const app = new Hono<AdminEnv>();

  // ログイン、2 段階認証、パスキーは管理者用の Better Auth が処理する。
  // 管理者に要らない受け口 (新規登録、メールでのログインなど) は出さない。
  app.on(["GET", "POST"], "/auth/*", async (c) => {
    const path = new URL(c.req.url).pathname.slice(ADMIN_AUTH_BASE_PATH.length);
    if (!ADMIN_AUTH_ALLOWED_PATHS.has(path)) {
      return c.json({ error: "not_found" }, 404);
    }
    return withAuthStateHeader(
      await adminAuth.handler(withAuthStateCookie(c.req.raw)),
    );
  });

  /** 初回セットアップの画面を出せるか (管理者が 1 人もいないか)。ログイン前に呼ぶ。 */
  app.get("/setup", async (c) => {
    const needed = (await countAdmins(db)) === 0;
    if (needed) setupCode.ensure();
    else setupCode.clear();
    return c.json({ needed });
  });

  /** 最初の管理者を作る。管理者がいないときに、サーバーのログの合言葉を知っている人だけ。 */
  app.post("/setup", zValidator("json", setupBody), async (c) => {
    const body = c.req.valid("json");
    return setupCode.exclusive(async () => {
      if ((await countAdmins(db)) > 0) {
        setupCode.clear();
        return c.json({ error: "already_set_up" }, 409);
      }
      setupCode.ensure();
      // 先に照合する。正しい合言葉なら、ほかの人の間違いが続いていても通す
      // (でたらめを送り続けて、運用者のセットアップを止められないように)。
      if (!setupCode.check(body.code)) {
        if (setupCode.limited()) {
          return c.json({ error: "too_many_attempts" }, 429);
        }
        return c.json({ error: "invalid_code" }, 403);
      }
      const result = await createAdmin(db, adminSignUpAuth, body);
      if (!result.ok) return c.json({ error: result.error }, 400);
      setupCode.clear();
      console.log(`最初の管理者を作りました: ${result.username}`);
      return c.json({ username: result.username }, 201);
    });
  });

  const authed = new Hono<AdminEnv>();
  authed.use(requireAdmin(adminAuth));

  authed.get("/me", (c) => c.json({ admin: c.var.admin }));

  /** 自分のログインの設定 (2 段階認証・パスキー) の状態。 */
  authed.get("/security", async (c) => {
    const [row] = await db
      .select({ twoFactorEnabled: adminUsers.twoFactorEnabled })
      .from(adminUsers)
      .where(eq(adminUsers.id, c.var.admin.id));
    const [passkeyRow] = await db
      .select({ value: count() })
      .from(adminPasskeys)
      .where(eq(adminPasskeys.userId, c.var.admin.id));
    return c.json({
      username: c.var.admin.username,
      twoFactorEnabled: row?.twoFactorEnabled ?? false,
      passkeyCount: passkeyRow?.value ?? 0,
    });
  });

  /** 自分の表示名を変える。 */
  authed.put(
    "/security/name",
    zValidator("json", z.object({ name: displayName })),
    async (c) => {
      const { name } = c.req.valid("json");
      await db
        .update(adminUsers)
        .set({ name })
        .where(eq(adminUsers.id, c.var.admin.id));
      return c.json({ name });
    },
  );

  /** このサーバーの利用者 (一般の利用者) の一覧。 */
  authed.get("/users", async (c) => {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        twoFactorEnabled: users.twoFactorEnabled,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(asc(users.createdAt), asc(users.id))
      .limit(500);
    return c.json({ users: rows });
  });

  /** 管理者の一覧。 */
  authed.get("/admins", async (c) => {
    const rows = await db
      .select({
        id: adminUsers.id,
        username: adminUsers.username,
        name: adminUsers.name,
        twoFactorEnabled: adminUsers.twoFactorEnabled,
        createdAt: adminUsers.createdAt,
      })
      .from(adminUsers)
      .orderBy(asc(adminUsers.createdAt), asc(adminUsers.id));
    return c.json({ admins: rows });
  });

  authed.route("/invitations", invitationRoutes({ db, webOrigin }));
  authed.route(
    "/sso",
    adminSsoRoutes({
      db,
      encryptionKey,
      webOrigin,
      allowHttp,
      clients: ssoClients,
    }),
  );

  app.route("/", authed);
  return app;
}
