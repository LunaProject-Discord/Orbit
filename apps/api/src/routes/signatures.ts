import { zValidator } from "@hono/zod-validator";
import { CHANNEL_CHANGES, type ChangeNotification } from "@mail/core";
import { type Database, mailAccounts, signatureRules } from "@mail/db";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, RouteDeps } from "../context.js";

const idParam = z.object({ id: z.uuid() });

/** 1 人が持てる決まりの数。 */
const MAX_RULES = 2000;

/** 使う署名 (書式付き)。null は「署名を付けない」。空の文字列も null として扱う。 */
const signatureHtml = z.string().max(50_000).nullable();
const label = z.string().trim().max(300).nullable().default(null);

const contactBody = z.object({
  /** 宛先のメールアドレス。大文字と小文字は区別しない。 */
  address: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(320)
    .regex(/^\S+@\S+$/),
  /** 一覧に出す名前。 */
  label,
  signatureHtml,
});

const threadBody = z.object({
  accountId: z.uuid(),
  /** 会話のキー (メッセージの threadKey)。 */
  threadKey: z.string().min(1).max(1000),
  /** 一覧に出す件名。 */
  label,
  signatureHtml,
});

const publicColumns = {
  id: signatureRules.id,
  kind: signatureRules.kind,
  accountId: signatureRules.accountId,
  key: signatureRules.key,
  label: signatureRules.label,
  signatureHtml: signatureRules.signatureHtml,
  updatedAt: signatureRules.updatedAt,
};

/** 決まりが変わったことを、利用者のほかの端末へ知らせる (取得し直すきっかけだけを送る)。 */
async function notifyChanged(db: Database, userId: string) {
  const payload: ChangeNotification = { userId, seq: "resync" };
  await db.execute(
    sql`select pg_notify(${CHANNEL_CHANGES}, ${JSON.stringify(payload)})`,
  );
}

async function overLimit(db: Database, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ total: count() })
    .from(signatureRules)
    .where(eq(signatureRules.userId, userId));
  return (row?.total ?? 0) >= MAX_RULES;
}

/**
 * 連絡先 (宛先のアドレス) ごと、会話ごとの署名。作成画面は、
 * 会話の署名、連絡先の署名、アカウントの署名の順に探して使う。どの端末でも同じ内容になる。
 */
export function signatureRoutes({ db }: Pick<RouteDeps, "db">) {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const rules = await db
      .select(publicColumns)
      .from(signatureRules)
      .where(eq(signatureRules.userId, c.var.user.id))
      .orderBy(asc(signatureRules.createdAt), asc(signatureRules.id));
    return c.json({ rules });
  });

  /** 連絡先の署名を決める。同じアドレスの決まりがあれば置き換える。 */
  app.put("/contact", zValidator("json", contactBody), async (c) => {
    const body = c.req.valid("json");
    const userId = c.var.user.id;
    if (await overLimit(db, userId)) {
      return c.json({ error: "too_many_rules" }, 409);
    }
    const html = body.signatureHtml?.trim() || null;
    const [rule] = await db
      .insert(signatureRules)
      .values({
        userId,
        kind: "contact",
        key: body.address,
        label: body.label || null,
        signatureHtml: html,
      })
      .onConflictDoUpdate({
        target: [signatureRules.userId, signatureRules.key],
        targetWhere: sql`${signatureRules.kind} = 'contact'`,
        set: {
          // 名前を渡さなかったときは、前の名前を残す。
          ...(body.label ? { label: body.label } : {}),
          signatureHtml: html,
          updatedAt: new Date(),
        },
      })
      .returning(publicColumns);
    await notifyChanged(db, userId);
    return c.json({ rule });
  });

  /** 会話の署名を決める。同じ会話の決まりがあれば置き換える。 */
  app.put("/thread", zValidator("json", threadBody), async (c) => {
    const body = c.req.valid("json");
    const userId = c.var.user.id;
    const [account] = await db
      .select({ id: mailAccounts.id })
      .from(mailAccounts)
      .where(
        and(
          eq(mailAccounts.id, body.accountId),
          eq(mailAccounts.userId, userId),
        ),
      );
    if (!account) {
      return c.json({ error: "account_not_found" }, 404);
    }
    if (await overLimit(db, userId)) {
      return c.json({ error: "too_many_rules" }, 409);
    }
    const html = body.signatureHtml?.trim() || null;
    const [rule] = await db
      .insert(signatureRules)
      .values({
        userId,
        kind: "thread",
        accountId: account.id,
        key: body.threadKey,
        label: body.label || null,
        signatureHtml: html,
      })
      .onConflictDoUpdate({
        target: [signatureRules.accountId, signatureRules.key],
        targetWhere: sql`${signatureRules.kind} = 'thread'`,
        set: {
          ...(body.label ? { label: body.label } : {}),
          signatureHtml: html,
          updatedAt: new Date(),
        },
      })
      .returning(publicColumns);
    await notifyChanged(db, userId);
    return c.json({ rule });
  });

  /** 決まりを消す。消すと、1 つ下の優先順位の署名 (連絡先かアカウント) に戻る。 */
  app.delete("/:id", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const userId = c.var.user.id;
    const deleted = await db
      .delete(signatureRules)
      .where(and(eq(signatureRules.id, id), eq(signatureRules.userId, userId)))
      .returning({ id: signatureRules.id });
    if (deleted.length === 0) {
      return c.json({ error: "not_found" }, 404);
    }
    await notifyChanged(db, userId);
    return c.body(null, 204);
  });

  return app;
}
