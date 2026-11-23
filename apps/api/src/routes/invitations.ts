import { createHash, randomBytes } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { type Database, invitations, sessions, users } from "@mail/db";
import { isAPIError } from "better-auth/api";
import { and, asc, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { Auth } from "../auth.js";
import type { AppEnv } from "../context.js";

/** パスワードの長さ (auth.ts の minPasswordLength と Better Auth の上限に合わせる)。 */
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;
/** 使われていない招待を、同時に持てる数。 */
const MAX_PENDING = 50;
const DEFAULT_EXPIRES_IN_DAYS = 7;

const idParam = z.object({ id: z.uuid() });
const email = z.email().max(320);
/** 合言葉は 32 バイトの base64url (43 文字)。 */
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const createBody = z.object({
  /** 誰に渡したかの覚え書き。 */
  label: z.string().trim().max(100).nullable().default(null),
  /** 指定すると、このメールアドレスでしか登録できない。 */
  email: email.nullable().default(null),
  expiresInDays: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(DEFAULT_EXPIRES_IN_DAYS),
});

const acceptBody = z.object({
  token,
  name: z.string().trim().min(1).max(100),
  email,
  password: z.string().min(1).max(1024),
});

export function hashInvitationToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 招待リンク。Web は静的に書き出しているので、合言葉はクエリ文字列で渡す。 */
export function invitationUrl(webOrigin: string, value: string): string {
  return `${webOrigin}/invite?token=${value}`;
}

/** いま使える招待 (未使用で、期限内) を探す。 */
async function findUsable(db: Database, value: string) {
  const [row] = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      expiresAt: invitations.expiresAt,
    })
    .from(invitations)
    .where(
      and(
        eq(invitations.tokenHash, hashInvitationToken(value)),
        isNull(invitations.usedAt),
        gt(invitations.expiresAt, sql`now()`),
      ),
    );
  return row ?? null;
}

type PublicDeps = {
  db: Database;
  /** 新規登録を受け付ける設定の Better Auth。招待を確かめたあとにだけ使う。 */
  signUpAuth: Auth;
};

/**
 * 招待リンクを開いた人が使う受け口。まだ利用者ではないのでログインは無く、
 * 代わりにリンクの合言葉 (推測できない長さの乱数) を確かめる。
 */
export function invitationPublicRoutes({ db, signUpAuth }: PublicDeps) {
  const app = new Hono();

  /** 招待が使えるかを確かめる (登録画面を出す前に呼ぶ)。 */
  app.get(
    "/invitations/lookup",
    zValidator("query", z.object({ token: z.string().max(200) })),
    async (c) => {
      const parsed = token.safeParse(c.req.valid("query").token);
      const invitation = parsed.success
        ? await findUsable(db, parsed.data)
        : null;
      // 無い・使用済み・期限切れは区別しない。
      if (!invitation) return c.json({ error: "invalid_invitation" }, 404);
      return c.json({
        email: invitation.email,
        expiresAt: invitation.expiresAt,
      });
    },
  );

  /** 招待を使って利用者を作る。ログインは、このあと通常の手順で行う。 */
  app.post("/invitations/accept", zValidator("json", acceptBody), async (c) => {
    const body = c.req.valid("json");
    const address = body.email.trim().toLowerCase();
    if (body.password.length < MIN_PASSWORD_LENGTH) {
      return c.json({ error: "password_too_short" }, 400);
    }
    if (body.password.length > MAX_PASSWORD_LENGTH) {
      return c.json({ error: "password_too_long" }, 400);
    }
    const invitation = await findUsable(db, body.token);
    if (!invitation) return c.json({ error: "invalid_invitation" }, 404);
    if (invitation.email && invitation.email.toLowerCase() !== address) {
      return c.json({ error: "email_mismatch" }, 400);
    }
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${address}`);
    if (existing) return c.json({ error: "email_taken" }, 409);

    // 同じ招待が同時に 2 回使われても、利用者を作れるのは先に印を付けられた 1 回だけ。
    const [claimed] = await db
      .update(invitations)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(invitations.id, invitation.id),
          isNull(invitations.usedAt),
          gt(invitations.expiresAt, sql`now()`),
        ),
      )
      .returning({ id: invitations.id });
    if (!claimed) return c.json({ error: "invalid_invitation" }, 404);

    let userId: string;
    try {
      const { user } = await signUpAuth.api.signUpEmail({
        body: { email: address, name: body.name, password: body.password },
      });
      userId = user.id;
    } catch (error) {
      // 作れなかったら、招待をもう一度使えるように戻す。
      await db
        .update(invitations)
        .set({ usedAt: null })
        .where(eq(invitations.id, claimed.id));
      if (isAPIError(error)) {
        const taken = error.body?.code === "USER_ALREADY_EXISTS";
        return taken
          ? c.json({ error: "email_taken" }, 409)
          : c.json({ error: "sign_up_failed" }, 400);
      }
      throw error;
    }
    await db
      .update(invitations)
      .set({ usedBy: userId })
      .where(eq(invitations.id, claimed.id));
    // 登録と同時に作られるセッションは使わない (端末は、2 段階認証なども通る通常のログインをする)。
    await db.delete(sessions).where(eq(sessions.userId, userId));
    return c.json({ email: address }, 201);
  });

  return app;
}

/** 管理者であることを確かめる。requireUser のあとに使う。 */
export function requireAdmin(db: Database) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const [row] = await db
      .select({ isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, c.var.user.id));
    if (!row?.isAdmin) return c.json({ error: "forbidden" }, 403);
    await next();
  });
}

type AdminDeps = { db: Database; webOrigin: string };

/** 管理者が招待を発行・確認・取り消しする。/v1/invitations の下に置く。 */
export function invitationRoutes({ db, webOrigin }: AdminDeps) {
  const app = new Hono<AppEnv>();
  app.use(requireAdmin(db));

  /** 発行した招待と、このサーバーの利用者の一覧。 */
  app.get("/", async (c) => {
    const invited = alias(users, "invited");
    const [rows, members] = await Promise.all([
      db
        .select({
          id: invitations.id,
          label: invitations.label,
          email: invitations.email,
          expiresAt: invitations.expiresAt,
          usedAt: invitations.usedAt,
          createdAt: invitations.createdAt,
          usedByEmail: invited.email,
          usedByName: invited.name,
        })
        .from(invitations)
        .leftJoin(invited, eq(invited.id, invitations.usedBy))
        .orderBy(desc(invitations.createdAt), desc(invitations.id))
        .limit(200),
      db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          isAdmin: users.isAdmin,
          createdAt: users.createdAt,
        })
        .from(users)
        .orderBy(asc(users.createdAt), asc(users.id))
        .limit(500),
    ]);
    return c.json({ invitations: rows, users: members });
  });

  /**
   * 招待を発行する。リンクは、この応答でしか返さない (サーバーは合言葉を保存しない)。
   */
  app.post("/", zValidator("json", createBody), async (c) => {
    const body = c.req.valid("json");
    const address = body.email?.trim().toLowerCase() ?? null;
    if (address) {
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${address}`);
      if (existing) return c.json({ error: "email_taken" }, 409);
    }
    const [pending] = await db
      .select({ total: count() })
      .from(invitations)
      .where(
        and(isNull(invitations.usedAt), gt(invitations.expiresAt, sql`now()`)),
      );
    if ((pending?.total ?? 0) >= MAX_PENDING) {
      return c.json({ error: "too_many" }, 409);
    }
    const value = randomBytes(32).toString("base64url");
    const [invitation] = await db
      .insert(invitations)
      .values({
        tokenHash: hashInvitationToken(value),
        createdBy: c.var.user.id,
        label: body.label || null,
        email: address,
        expiresAt: new Date(Date.now() + body.expiresInDays * 86_400_000),
      })
      .returning({
        id: invitations.id,
        label: invitations.label,
        email: invitations.email,
        expiresAt: invitations.expiresAt,
        usedAt: invitations.usedAt,
        createdAt: invitations.createdAt,
      });
    return c.json(
      {
        invitation: { ...invitation, usedByEmail: null, usedByName: null },
        url: invitationUrl(webOrigin, value),
      },
      201,
    );
  });

  /** 招待を取り消す (一覧から消す)。使われたあとに消しても、作られた利用者は残る。 */
  app.delete("/:id", zValidator("param", idParam), async (c) => {
    const deleted = await db
      .delete(invitations)
      .where(eq(invitations.id, c.req.valid("param").id))
      .returning({ id: invitations.id });
    if (deleted.length === 0) return c.json({ error: "not_found" }, 404);
    return c.body(null, 204);
  });

  return app;
}
