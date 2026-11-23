import { zValidator } from "@hono/zod-validator";
import { type Database, passkeys, users } from "@orbit/db";
import { isAPIError } from "better-auth/api";
import { count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Auth } from "../auth.js";
import type { AppEnv } from "../context.js";
import type { SystemMailer } from "../lib/system-mail.js";

/** メールのリンクを開いたあとに戻る Web の画面。 */
export function emailChangedUrl(webOrigin: string): string {
  return `${webOrigin}/login?notice=email-changed`;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を弾くための正規表現
const noControl = /^[^\u0000-\u001f\u007f]*$/;

/** 表示名。前後の空白は除き、改行などの制御文字は受け付けない。 */
const nameBody = z.object({
  name: z.string().trim().min(1).max(100).regex(noControl),
});

const emailBody = z.object({
  newEmail: z.email().max(320),
  password: z.string().min(1).max(1024),
});

type Deps = {
  db: Database;
  auth: Auth;
  webOrigin: string;
  /** 利用者へメールを送れるか (再設定とメールアドレスの変更が使えるか)。 */
  mailEnabled: boolean;
  mailer: SystemMailer | null;
};

/** ログイン前の画面が使う、サーバーの対応状況。 */
export function authFeatureRoutes({ mailEnabled }: Pick<Deps, "mailEnabled">) {
  const app = new Hono();
  app.get("/auth-features", (c) =>
    c.json({
      /** パスワードの再設定とメールアドレスの変更 (メールを送れるサーバーだけ)。 */
      mail: mailEnabled,
    }),
  );
  return app;
}

/**
 * ログインまわりの設定のうち、Better Auth の API (/v1/auth/*) に無いもの。
 * パスワードの変更、2 段階認証、パスキーは、画面が /v1/auth/* を直接呼ぶ。
 */
export function securityRoutes({
  db,
  auth,
  webOrigin,
  mailEnabled,
  mailer,
}: Deps) {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const [row] = await db
      .select({
        email: users.email,
        twoFactorEnabled: users.twoFactorEnabled,
      })
      .from(users)
      .where(eq(users.id, c.var.user.id));
    const [passkeyRow] = await db
      .select({ value: count() })
      .from(passkeys)
      .where(eq(passkeys.userId, c.var.user.id));
    return c.json({
      email: row?.email ?? c.var.user.email,
      twoFactorEnabled: row?.twoFactorEnabled ?? false,
      passkeyCount: passkeyRow?.value ?? 0,
      mail: mailEnabled,
    });
  });

  /**
   * ログインに使うメールアドレスの変更を申し込む。
   * いまのパスワードを確かめてから、新しいアドレスへ確認のメールを送る。
   * そのメールのリンクを開くまで、アドレスは変わらない。
   */
  /** 自分の名前 (表示名) を変える。ログインには使わないので、パスワードは尋ねない。 */
  app.put("/name", zValidator("json", nameBody), async (c) => {
    const { name } = c.req.valid("json");
    await db.update(users).set({ name }).where(eq(users.id, c.var.user.id));
    return c.json({ name });
  });

  app.post("/email", zValidator("json", emailBody), async (c) => {
    if (!mailEnabled) return c.json({ error: "mail_disabled" }, 400);
    const { password } = c.req.valid("json");
    const newEmail = c.req.valid("json").newEmail.trim().toLowerCase();
    if (newEmail === c.var.user.email.toLowerCase()) {
      return c.json({ error: "same_email" }, 400);
    }
    const headers = c.req.raw.headers;
    try {
      await auth.api.verifyPassword({ body: { password }, headers });
    } catch (error) {
      if (isAPIError(error)) return c.json({ error: "invalid_password" }, 400);
      throw error;
    }
    try {
      await auth.api.changeEmail({
        body: { newEmail, callbackURL: emailChangedUrl(webOrigin) },
        headers,
      });
    } catch (error) {
      if (isAPIError(error)) return c.json({ error: "change_failed" }, 400);
      throw error;
    }
    // いまのアドレスにも知らせる (本人でなければ気付けるように)。届かなくても申し込みは通す。
    void mailer
      ?.send({
        to: c.var.user.email,
        subject: "Orbit のメールアドレスの変更の申し込み",
        lines: [
          `${c.var.user.name} さん`,
          `Orbit のログインに使うメールアドレスを ${newEmail} に変更する申し込みがありました。新しいアドレスへ届く確認のメールのリンクを開くと、変更が完了します。`,
        ],
        footer: [
          "心当たりがない場合は、すぐに Orbit のパスワードを変更してください。",
        ],
      })
      .catch((error: unknown) => {
        console.error(
          "メールアドレスの変更の知らせを送れませんでした:",
          error instanceof Error ? error.message : error,
        );
      });
    return c.json({ status: "sent" });
  });

  return app;
}
