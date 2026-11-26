import { randomUUID } from "node:crypto";
import {
  buildNotificationReply,
  CHANNEL_OUTBOX,
  type OutgoingMessage,
  type SendPayload,
} from "@orbit/core";
import {
  type Database,
  mailAccounts,
  messages,
  outbox,
  signatureRules,
} from "@orbit/db";
import { and, eq, or, sql } from "drizzle-orm";
import { notifyAccountChanged } from "./changes.js";
import { enqueueMessageAction } from "./message-actions.js";

export type NotificationReplyResult =
  | { ok: true; id: string | null }
  | { ok: false; error: "not_found" | "no_recipients" | "receive_only" };

/**
 * 署名を選ぶ。画面 (apps/web の lib/signatures.ts) と同じ優先順位:
 * 会話の署名、宛先の全員に同じ連絡先の署名があればそれ、どちらでもなければアカウントの署名。
 */
export function pickSignature(input: {
  rules: {
    kind: string;
    accountId: string | null;
    key: string;
    signatureHtml: string | null;
  }[];
  accountId: string;
  threadKey: string;
  accountSignature: string | null;
  to: { address: string }[];
}): string | null {
  const thread = input.rules.find(
    (rule) =>
      rule.kind === "thread" &&
      rule.accountId === input.accountId &&
      rule.key === input.threadKey,
  );
  if (thread) return thread.signatureHtml;
  const keys = [
    ...new Set(input.to.map((entry) => entry.address.trim().toLowerCase())),
  ];
  if (keys.length > 0) {
    const found = keys.map(
      (key) =>
        input.rules.find(
          (rule) => rule.kind === "contact" && rule.key === key,
        ) ?? null,
    );
    const first = found[0];
    if (
      first &&
      found.every(
        (rule) => rule !== null && rule.signatureHtml === first.signatureHtml,
      )
    ) {
      return first.signatureHtml;
    }
  }
  return input.accountSignature;
}

/**
 * 通知の返信欄に書いた文章で、そのメールへ返信する (送信待ちキューに積む)。
 * 画面からの送信 (POST /v1/messages/send) と同じく、実際の送信は同期ワーカーが行う。
 * 返信したメールは既読にする。
 */
export async function queueNotificationReply(
  db: Database,
  userId: string,
  messageId: string,
  text: string,
  idempotencyKey: string,
): Promise<NotificationReplyResult> {
  const [source] = await db
    .select({
      accountId: messages.accountId,
      threadKey: messages.threadKey,
      from: messages.from,
      to: messages.to,
      replyTo: messages.replyTo,
      subject: messages.subject,
      bodyText: messages.bodyText,
      bodyHtml: messages.bodyHtml,
      sentAt: messages.sentAt,
      receivedAt: messages.receivedAt,
      messageIdHeader: messages.messageIdHeader,
      references: messages.references,
      email: mailAccounts.email,
      displayName: mailAccounts.displayName,
      signatureHtml: mailAccounts.signatureHtml,
      protocol: mailAccounts.protocol,
      smtpHost: mailAccounts.smtpHost,
    })
    .from(messages)
    .innerJoin(mailAccounts, eq(mailAccounts.id, messages.accountId))
    .where(and(eq(messages.id, messageId), eq(mailAccounts.userId, userId)));
  if (!source) return { ok: false, error: "not_found" };
  // 受信専用のアカウント (送信サーバーが無い) からは送れない。
  if (source.protocol !== "graph" && source.smtpHost === null) {
    return { ok: false, error: "receive_only" };
  }

  const own = await db
    .select({ email: mailAccounts.email })
    .from(mailAccounts)
    .where(eq(mailAccounts.userId, userId));
  const rules = await db
    .select({
      kind: signatureRules.kind,
      accountId: signatureRules.accountId,
      key: signatureRules.key,
      signatureHtml: signatureRules.signatureHtml,
    })
    .from(signatureRules)
    .where(
      and(
        eq(signatureRules.userId, userId),
        or(
          eq(signatureRules.kind, "contact"),
          and(
            eq(signatureRules.kind, "thread"),
            eq(signatureRules.accountId, source.accountId),
            eq(signatureRules.key, source.threadKey),
          ),
        ),
      ),
    );

  const ownAddresses = own.map((row) => row.email);
  const draft = buildNotificationReply({
    source,
    ownAddresses,
    signatureHtml: null,
    text,
  });
  if (draft.to.length === 0) return { ok: false, error: "no_recipients" };
  const signatureHtml = pickSignature({
    rules,
    accountId: source.accountId,
    threadKey: source.threadKey,
    accountSignature: source.signatureHtml,
    to: draft.to,
  });
  const reply = signatureHtml
    ? buildNotificationReply({ source, ownAddresses, signatureHtml, text })
    : draft;

  const domain = source.email.split("@").pop() || "localhost";
  const message: OutgoingMessage = {
    from: {
      address: source.email,
      ...(source.displayName ? { name: source.displayName } : {}),
    },
    to: reply.to.map((entry) =>
      entry.name
        ? { name: entry.name, address: entry.address }
        : { address: entry.address },
    ),
    cc: [],
    bcc: [],
    subject: reply.subject.trim(),
    text: reply.text,
    html: reply.html,
    attachments: [],
    messageId: `<${randomUUID()}@${domain}>`,
    date: new Date().toISOString(),
    inReplyTo: source.messageIdHeader ?? null,
    // 長いやり取りでヘッダーが膨らみすぎないよう、直近の分だけ引き継ぐ (画面からの送信と同じ)。
    references: source.messageIdHeader
      ? [...source.references, source.messageIdHeader].slice(-20)
      : [],
  };
  const payload: SendPayload = {
    message,
    sourceMessageId: messageId,
    mode: "reply",
  };

  const id = await db.transaction(async (tx) => {
    const [queued] = await tx
      .insert(outbox)
      .values({
        accountId: source.accountId,
        kind: "send",
        payload,
        idempotencyKey,
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
            eq(outbox.accountId, source.accountId),
            eq(outbox.idempotencyKey, idempotencyKey),
          ),
        );
      return existing?.id ?? null;
    }
    await notifyAccountChanged(tx, userId, source.accountId);
    // コミット時に同期ワーカーへ届き、すぐに送信される。
    await tx.execute(
      sql`select pg_notify(${CHANNEL_OUTBOX}, ${source.accountId})`,
    );
    return queued.id;
  });

  // 返信したメールは読んだものとして扱う (既読にできなくても、返信は受け付け済み)。
  await enqueueMessageAction(db, userId, {
    idempotencyKey: randomUUID(),
    messageIds: [messageId],
    action: "set_flags",
    seen: true,
  }).catch(() => {});
  return { ok: true, id };
}
