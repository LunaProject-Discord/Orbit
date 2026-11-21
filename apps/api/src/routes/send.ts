import { randomUUID } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import {
  CHANNEL_CHANGES,
  CHANNEL_OUTBOX,
  type ChangeNotification,
  type OutgoingMessage,
  type SendPayload,
} from "@mail/core";
import { changes, mailAccounts, messages, outbox } from "@mail/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, RouteDeps } from "../context.js";

/** 1 通あたりの宛先の上限 (To / Cc / Bcc の合計)。 */
const MAX_RECIPIENTS = 100;

// 改行などの制御文字は、ヘッダーへの差し込みに使われるので受け付けない。
// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を弾くための正規表現
const noControl = /^[^\u0000-\u001f\u007f]*$/;

const address = z.object({
  name: z.string().trim().max(200).regex(noControl).optional(),
  address: z.email().max(320),
});

const sendBody = z.object({
  /** 端末が送信ごとに付ける一意な ID。同じ値で再送されても二重に送らない。 */
  idempotencyKey: z.uuid(),
  /** 差出人にするメールアカウント。 */
  accountId: z.uuid(),
  to: z.array(address).max(MAX_RECIPIENTS).default([]),
  cc: z.array(address).max(MAX_RECIPIENTS).default([]),
  bcc: z.array(address).max(MAX_RECIPIENTS).default([]),
  subject: z.string().max(998).regex(noControl).default(""),
  text: z.string().max(1_000_000),
  mode: z.enum(["new", "reply", "forward"]).default("new"),
  /** 返信・転送の元になったメッセージ。返信では In-Reply-To / References を引き継ぐ。 */
  sourceMessageId: z.uuid().optional(),
});

const idParam = z.object({ id: z.uuid() });

/** 送信待ちの一覧が変わったことを、利用者の端末へ知らせる。 */
async function notifyOutgoing(
  tx: Parameters<Parameters<RouteDeps["db"]["transaction"]>[0]>[0],
  userId: string,
  accountId: string,
) {
  const [row] = await tx
    .insert(changes)
    .values({ userId, entity: "account", entityId: accountId, op: "upsert" })
    .returning({ seq: changes.seq });
  if (!row) return;
  const payload: ChangeNotification = { userId, seq: row.seq.toString() };
  await tx.execute(
    sql`select pg_notify(${CHANNEL_CHANGES}, ${JSON.stringify(payload)})`,
  );
}

/**
 * メールの送信。/v1/messages の下に置く。
 * 受け付けたら送信待ちキュー (outbox) に積んですぐ応答し、実際の送信は
 * 同期ワーカーが SMTP または Microsoft Graph で行う。
 */
export function sendRoutes({ db }: Pick<RouteDeps, "db">) {
  const app = new Hono<AppEnv>();

  app.post("/send", zValidator("json", sendBody), async (c) => {
    const body = c.req.valid("json");
    const user = c.var.user;
    const count = body.to.length + body.cc.length + body.bcc.length;
    if (count === 0) {
      return c.json({ error: "no_recipients" }, 400);
    }
    if (count > MAX_RECIPIENTS) {
      return c.json({ error: "too_many_recipients" }, 400);
    }

    const [account] = await db
      .select({
        id: mailAccounts.id,
        email: mailAccounts.email,
        displayName: mailAccounts.displayName,
      })
      .from(mailAccounts)
      .where(
        and(
          eq(mailAccounts.id, body.accountId),
          eq(mailAccounts.userId, user.id),
        ),
      );
    if (!account) {
      return c.json({ error: "account_not_found" }, 404);
    }

    let inReplyTo: string | null = null;
    let references: string[] = [];
    if (body.sourceMessageId && body.mode === "reply") {
      // 他人のメッセージは見つからない扱いにする。
      const [source] = await db
        .select({
          messageIdHeader: messages.messageIdHeader,
          references: messages.references,
        })
        .from(messages)
        .innerJoin(mailAccounts, eq(mailAccounts.id, messages.accountId))
        .where(
          and(
            eq(messages.id, body.sourceMessageId),
            eq(mailAccounts.userId, user.id),
          ),
        );
      if (source?.messageIdHeader) {
        inReplyTo = source.messageIdHeader;
        // 長いやり取りでヘッダーが膨らみすぎないよう、直近の分だけ引き継ぐ。
        references = [...source.references, source.messageIdHeader].slice(-20);
      }
    }

    const domain = account.email.split("@").pop() || "localhost";
    const message: OutgoingMessage = {
      from: {
        address: account.email,
        ...(account.displayName ? { name: account.displayName } : {}),
      },
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      subject: body.subject.trim(),
      text: body.text,
      messageId: `<${randomUUID()}@${domain}>`,
      date: new Date().toISOString(),
      inReplyTo,
      references,
    };
    const payload: SendPayload = {
      message,
      sourceMessageId: body.sourceMessageId ?? null,
      mode: body.mode,
    };

    const id = await db.transaction(async (tx) => {
      const [queued] = await tx
        .insert(outbox)
        .values({
          accountId: account.id,
          kind: "send",
          payload,
          idempotencyKey: body.idempotencyKey,
        })
        .onConflictDoNothing({
          target: [outbox.accountId, outbox.idempotencyKey],
        })
        .returning({ id: outbox.id });
      if (!queued) {
        // 再送された依頼。前回の受け付けをそのまま返す。
        const [existing] = await tx
          .select({ id: outbox.id })
          .from(outbox)
          .where(
            and(
              eq(outbox.accountId, account.id),
              eq(outbox.idempotencyKey, body.idempotencyKey),
            ),
          );
        return existing?.id ?? null;
      }
      await notifyOutgoing(tx, user.id, account.id);
      // コミット時に同期ワーカーへ届き、すぐに送信される。
      await tx.execute(sql`select pg_notify(${CHANNEL_OUTBOX}, ${account.id})`);
      return queued.id;
    });
    return c.json({ id }, 202);
  });

  /** まだ送り終えていないメール (送信待ち、送信中、失敗) の一覧。 */
  app.get("/outgoing", async (c) => {
    const rows = await db
      .select({
        id: outbox.id,
        accountId: outbox.accountId,
        status: outbox.status,
        attempts: outbox.attempts,
        lastError: outbox.lastError,
        createdAt: outbox.createdAt,
        payload: outbox.payload,
      })
      .from(outbox)
      .innerJoin(mailAccounts, eq(mailAccounts.id, outbox.accountId))
      .where(
        and(
          eq(mailAccounts.userId, c.var.user.id),
          eq(outbox.kind, "send"),
          inArray(outbox.status, ["pending", "processing", "failed"]),
        ),
      )
      .orderBy(asc(outbox.createdAt), asc(outbox.id));
    return c.json({
      outgoing: rows.map(({ payload, ...row }) => {
        const { message, mode, sourceMessageId } =
          payload as unknown as SendPayload;
        return {
          ...row,
          mode,
          sourceMessageId,
          to: message.to,
          cc: message.cc,
          bcc: message.bcc,
          subject: message.subject,
          text: message.text,
        };
      }),
    });
  });

  /**
   * 送信待ちのメールを取り消す、または失敗したメールを一覧から消す。
   * 送信中のものは取り消せない。
   */
  app.delete("/outgoing/:id", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const user = c.var.user;
    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: outbox.id, accountId: outbox.accountId })
        .from(outbox)
        .innerJoin(mailAccounts, eq(mailAccounts.id, outbox.accountId))
        .where(
          and(
            eq(outbox.id, id),
            eq(outbox.kind, "send"),
            eq(mailAccounts.userId, user.id),
          ),
        );
      if (!row) return "not_found" as const;
      // 同期ワーカーが送信を始めていたら、status が processing になっていて消えない。
      const [deleted] = await tx
        .delete(outbox)
        .where(
          and(eq(outbox.id, id), inArray(outbox.status, ["pending", "failed"])),
        )
        .returning({ id: outbox.id });
      if (!deleted) return "in_progress" as const;
      await notifyOutgoing(tx, user.id, row.accountId);
      return "deleted" as const;
    });
    if (result === "not_found") return c.json({ error: "not_found" }, 404);
    if (result === "in_progress") return c.json({ error: "in_progress" }, 409);
    return c.body(null, 204);
  });

  return app;
}
