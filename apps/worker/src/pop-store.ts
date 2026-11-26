import {
  MAX_PREVIEW,
  NEW_MAIL_MAX_AGE_MS,
  type NewMailCandidate,
  type OutboxOperation,
} from "@orbit/core";
import {
  attachments,
  type Database,
  mailboxes,
  messageMailboxes,
  messageSources,
  messages,
  popMessages,
} from "@orbit/db";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { recordChanges, type Tx } from "./changes.js";
import type { SpecialUse } from "./mailbox-list.js";
import { renameMailboxPaths } from "./mailbox-operations.js";
import { removePlacements, type SyncAccount } from "./mailbox-store.js";
import { headersPending, parseListHeaders } from "./message-headers.js";
import { makeSnippet } from "./message-parse.js";
import { buildMime } from "./mime.js";
import { announceNewMail } from "./new-mail.js";
import type { OutboxResult } from "./outbox.js";
import { headerSection, parseRawMessage } from "./pop-parse.js";
import { resolveThreadKey } from "./thread-key.js";

/**
 * POP3 のアカウントのフォルダとメールを、このアプリの中だけで持つための処理。
 * POP3 のサーバーには受信トレイしか無く、既読やフォルダの考えも無いので、
 * 取り込んだあとの操作 (既読、移動、削除、フォルダの作成など) はすべて DB の中で完結する。
 */

/** フォルダの階層の区切り文字。API がフォルダのパスを作るときにも使う。 */
export const POP_DELIMITER = "/";

/** POP3 のアカウントに最初から作るフォルダ。 */
export const POP_MAILBOXES: { path: string; specialUse: SpecialUse }[] = [
  { path: "INBOX", specialUse: "inbox" },
  { path: "Archive", specialUse: "archive" },
  { path: "Sent", specialUse: "sent" },
  { path: "Junk", specialUse: "junk" },
  { path: "Trash", specialUse: "trash" },
];

/** 決まったフォルダが無ければ作る。戻り値は受信トレイの ID。 */
export async function ensurePopMailboxes(
  db: Database,
  account: SyncAccount,
): Promise<string> {
  return db.transaction(async (tx) => {
    const created = await tx
      .insert(mailboxes)
      .values(
        POP_MAILBOXES.map((mailbox) => ({
          accountId: account.id,
          path: mailbox.path,
          name: mailbox.path,
          delimiter: POP_DELIMITER,
          specialUse: mailbox.specialUse,
          detectedSpecialUse: mailbox.specialUse,
        })),
      )
      .onConflictDoNothing({ target: [mailboxes.accountId, mailboxes.path] })
      .returning({ id: mailboxes.id });
    await recordChanges(
      tx,
      account.userId,
      "mailbox",
      "upsert",
      created.map((row) => row.id),
    );
    const [inbox] = await tx
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.accountId, account.id),
          eq(mailboxes.specialUse, "inbox"),
        ),
      )
      .limit(1);
    if (inbox) return inbox.id;
    // 利用者が受信トレイの役割を外していた場合は、最初に作った INBOX を使う。
    const [fallback] = await tx
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(
        and(eq(mailboxes.accountId, account.id), eq(mailboxes.path, "INBOX")),
      );
    if (!fallback) throw new Error("受信トレイを作れませんでした。");
    return fallback.id;
  });
}

/** 取り込みの結果。null なら同じメール (UIDL) をすでに取り込んでいた。 */
export type ImportedMessage = { id: string } | null;

/** 新着として通知するか。届いてから時間の経ったメールは知らせない。 */
function isRecent(receivedAt: Date, now: number) {
  return now - receivedAt.getTime() <= NEW_MAIL_MAX_AGE_MS;
}

/**
 * 原文 1 通を、フォルダへ取り込む。本文と添付ファイルの一覧も一緒に入れ、原文も残す。
 * uidl を渡すと POP3 の取り込みの記録も付け、同じ UIDL を二度取り込まない。
 */
export async function importRawMessage(
  db: Database,
  account: SyncAccount,
  mailboxId: string,
  raw: Buffer,
  options: {
    uidl?: string;
    /** 新着として通知する。 */
    announce?: boolean;
    seen?: boolean;
  } = {},
): Promise<ImportedMessage> {
  const parsed = await parseRawMessage(
    raw,
    `pop:${account.id}:${options.uidl ?? crypto.randomUUID()}`,
  );
  const now = Date.now();
  // POP3 には届いた時刻が無いので、Date ヘッダーを使う (未来の日時は今に直す)。
  const receivedAt =
    parsed.sentAt && parsed.sentAt.getTime() <= now
      ? parsed.sentAt
      : new Date(now);
  return db.transaction(async (tx) => {
    if (options.uidl !== undefined) {
      const [claimed] = await tx
        .insert(popMessages)
        .values({ accountId: account.id, uidl: options.uidl })
        .onConflictDoNothing()
        .returning({ uidl: popMessages.uidl });
      if (!claimed) return null;
    }
    const { threadKey, moved } = await resolveThreadKey(tx, account.id, {
      computed: parsed.threadKey,
      messageId: parsed.messageIdHeader,
      parents: [
        ...parsed.references,
        ...(parsed.inReplyTo ? [parsed.inReplyTo] : []),
      ],
    });
    const [row] = await tx
      .insert(messages)
      .values({
        accountId: account.id,
        threadKey,
        messageIdHeader: parsed.messageIdHeader,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
        subject: parsed.subject,
        from: parsed.from,
        to: parsed.to,
        cc: parsed.cc,
        bcc: parsed.bcc,
        replyTo: parsed.replyTo,
        sender: parsed.sender,
        listId: parsed.listId,
        listUnsubscribe: parsed.listUnsubscribe,
        authResults: parsed.authResults,
        senderCheck: parsed.senderCheck,
        headersFetchedAt: new Date(now),
        sentAt: parsed.sentAt,
        receivedAt,
        size: raw.length,
        hasAttachments: parsed.attachments.some((file) => !file.inline),
        bodyText: parsed.bodyText,
        bodyHtml: parsed.bodyHtml,
        snippet: parsed.snippet,
        bodyFetchedAt: new Date(now),
        seen: options.seen ?? false,
      })
      .returning({ id: messages.id });
    if (!row) throw new Error("メールを保存できませんでした。");
    await tx.insert(messageMailboxes).values({ mailboxId, messageId: row.id });
    await tx.insert(messageSources).values({ messageId: row.id, raw });
    if (parsed.attachments.length > 0) {
      await tx
        .insert(attachments)
        .values(
          parsed.attachments.map((file) => ({ messageId: row.id, ...file })),
        );
    }
    if (options.uidl !== undefined) {
      await tx
        .update(popMessages)
        .set({ messageId: row.id })
        .where(
          and(
            eq(popMessages.accountId, account.id),
            eq(popMessages.uidl, options.uidl),
          ),
        );
    }
    await recordChanges(tx, account.userId, "message", "upsert", [
      row.id,
      ...moved,
    ]);
    if (options.announce && !options.seen && isRecent(receivedAt, now)) {
      const candidate: NewMailCandidate = {
        id: row.id,
        from: parsed.from,
        subject: parsed.subject,
        preview: makeSnippet(parsed.bodyText, parsed.bodyHtml, MAX_PREVIEW),
        seen: false,
        receivedAt,
      };
      await announceNewMail(tx, account, [candidate]);
    }
    return { id: row.id };
  });
}

/** 取り込みの記録 1 件分。 */
export type PopRecord = {
  uidl: string;
  messageId: string | null;
  downloadedAt: Date;
};

export async function loadPopRecords(
  db: Database,
  accountId: string,
): Promise<Map<string, PopRecord>> {
  const rows = await db
    .select({
      uidl: popMessages.uidl,
      messageId: popMessages.messageId,
      downloadedAt: popMessages.downloadedAt,
    })
    .from(popMessages)
    .where(eq(popMessages.accountId, accountId));
  return new Map(rows.map((row) => [row.uidl, row]));
}

/** サーバーから無くなったメールの記録を消す (もう二度と届かないので、覚えておく必要が無い)。 */
export async function forgetPopRecords(
  db: Database,
  accountId: string,
  uidls: string[],
) {
  for (let i = 0; i < uidls.length; i += 500) {
    await db
      .delete(popMessages)
      .where(
        and(
          eq(popMessages.accountId, accountId),
          inArray(popMessages.uidl, uidls.slice(i, i + 500)),
        ),
      );
  }
}

/**
 * サーバーから消すメールを選ぶ。
 * - アプリで完全に削除したメール (記録の messageId が null)
 * - サーバーに残さない設定なら、取り込み済みのメールすべて
 * - 残す日数を決めていれば、取り込んでからその日数が過ぎたメール
 */
export function selectPopDeletions(
  records: Map<string, PopRecord>,
  onServer: Iterable<string>,
  settings: { leaveOnServer: boolean; deleteAfterDays: number | null },
  now = Date.now(),
): string[] {
  const result: string[] = [];
  for (const uidl of onServer) {
    const record = records.get(uidl);
    if (!record) continue;
    if (record.messageId === null || !settings.leaveOnServer) {
      result.push(uidl);
      continue;
    }
    if (
      settings.deleteAfterDays !== null &&
      now - record.downloadedAt.getTime() >=
        settings.deleteAfterDays * 24 * 60 * 60_000
    ) {
      result.push(uidl);
    }
  }
  return result;
}

/**
 * 送信待ちキューの操作 1 件を、POP3 のアカウントに反映する。
 * DB は API が受け付けたときに書き換え済みなので、残りの後始末だけを行う。
 */
export async function applyPopOperation(
  db: Database,
  account: SyncAccount,
  operation: OutboxOperation,
): Promise<OutboxResult> {
  switch (operation.kind) {
    case "set_flags":
      // 既読などの印は DB にしか無い。
      return { ok: true };
    case "delete":
      // メールは DB から消えている。取り込みの記録の messageId が null になったので、
      // 次の受信でサーバーからも消える。
      return { ok: true };
    case "move": {
      // 移動先に「移動中」として置いた所在を、そのまま確定させる。
      const ids = [
        ...new Set(operation.payload.targets.map((target) => target.messageId)),
      ];
      if (ids.length === 0) return { ok: true };
      await db.transaction(async (tx) => {
        await tx
          .update(messageMailboxes)
          .set({ pendingSince: null })
          .where(
            and(
              eq(
                messageMailboxes.mailboxId,
                operation.payload.destination.mailboxId,
              ),
              inArray(messageMailboxes.messageId, ids),
              isNotNull(messageMailboxes.pendingSince),
            ),
          );
        await recordChanges(tx, account.userId, "message", "upsert", ids);
      });
      return { ok: true };
    }
    case "append":
      return appendLocalCopy(db, account, operation.payload);
    case "mailbox_create":
      await createLocalMailbox(db, account, operation.payload);
      return { ok: true };
    case "mailbox_rename":
      await renameMailboxPaths(db, account, {
        ...operation.payload,
        delimiter: operation.payload.delimiter ?? POP_DELIMITER,
      });
      return { ok: true };
    case "mailbox_delete":
      await deleteLocalMailbox(db, account, operation.payload.mailboxId);
      return { ok: true };
  }
}

/** 送ったメールの控えを、送信済みフォルダに置く。 */
async function appendLocalCopy(
  db: Database,
  account: SyncAccount,
  payload: Extract<OutboxOperation, { kind: "append" }>["payload"],
): Promise<OutboxResult> {
  const [mailbox] = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.accountId, account.id),
        eq(mailboxes.path, payload.mailboxPath),
      ),
    );
  if (!mailbox) {
    return { ok: false, reason: "送信済みフォルダが見つかりませんでした。" };
  }
  const raw = await buildMime(payload.message, { keepBcc: true });
  await importRawMessage(db, account, mailbox.id, raw, { seen: true });
  return { ok: true };
}

async function createLocalMailbox(
  db: Database,
  account: SyncAccount,
  payload: Extract<OutboxOperation, { kind: "mailbox_create" }>["payload"],
) {
  await db.transaction(async (tx) => {
    const [parent] = payload.parentPath
      ? await tx
          .select({ id: mailboxes.id })
          .from(mailboxes)
          .where(
            and(
              eq(mailboxes.accountId, account.id),
              eq(mailboxes.path, payload.parentPath),
            ),
          )
      : [];
    const [created] = await tx
      .insert(mailboxes)
      .values({
        accountId: account.id,
        path: payload.path,
        name: payload.name,
        delimiter: POP_DELIMITER,
        parentId: parent?.id ?? null,
      })
      .onConflictDoNothing({ target: [mailboxes.accountId, mailboxes.path] })
      .returning({ id: mailboxes.id });
    if (created) {
      await recordChanges(tx, account.userId, "mailbox", "upsert", [
        created.id,
      ]);
    }
  });
}

/** フォルダを、中のフォルダとメールごと消す。 */
async function deleteLocalMailbox(
  db: Database,
  account: SyncAccount,
  mailboxId: string,
) {
  await db.transaction(async (tx: Tx) => {
    const [target] = await tx
      .select({ id: mailboxes.id, path: mailboxes.path })
      .from(mailboxes)
      .where(
        and(eq(mailboxes.accountId, account.id), eq(mailboxes.id, mailboxId)),
      );
    if (!target) return;
    const prefix = target.path + POP_DELIMITER;
    const descendants = await tx
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.accountId, account.id),
          sql`left(${mailboxes.path}, ${prefix.length}) = ${prefix}`,
        ),
      );
    const ids = [target.id, ...descendants.map((row) => row.id)];
    await removePlacements(tx, account, ids, null);
    await tx.delete(mailboxes).where(inArray(mailboxes.id, ids));
    await recordChanges(tx, account.userId, "mailbox", "delete", ids);
  });
}

const HEADER_BACKFILL_BATCH = 200;

/**
 * ヘッダーの補完がまだのメール (項目を足す前に取り込んだもの) に、保存しておいた原文から
 * 認証結果などを入れる。続きがあれば true。原文が無いメール (送信の控えなど) は、
 * 表示名だけで確認結果を決める。
 */
export async function backfillPopHeaders(
  db: Database,
  account: Pick<SyncAccount, "id" | "userId">,
): Promise<boolean> {
  const pending = await db
    .select({
      id: messages.id,
      from: messages.from,
      raw: messageSources.raw,
    })
    .from(messages)
    .leftJoin(messageSources, eq(messageSources.messageId, messages.id))
    .where(and(eq(messages.accountId, account.id), headersPending))
    .orderBy(desc(messages.receivedAt))
    .limit(HEADER_BACKFILL_BATCH + 1);
  const batch = pending.slice(0, HEADER_BACKFILL_BATCH);
  if (batch.length === 0) return false;
  const changed: string[] = [];
  await db.transaction(async (tx) => {
    for (const row of batch) {
      const info = parseListHeaders(
        row.raw ? headerSection(row.raw) : undefined,
        row.from,
      );
      await tx
        .update(messages)
        .set({ ...info, headersFetchedAt: new Date() })
        .where(eq(messages.id, row.id));
      if (info.senderCheck.warnings.length > 0) {
        changed.push(row.id);
      }
    }
    await recordChanges(tx, account.userId, "message", "upsert", changed);
  });
  return pending.length > HEADER_BACKFILL_BATCH;
}
