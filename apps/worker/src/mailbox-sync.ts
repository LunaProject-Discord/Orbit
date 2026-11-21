import {
  attachments,
  type Database,
  mailboxes,
  messageMailboxes,
  messages,
} from "@mail/db";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  notInArray,
} from "drizzle-orm";
import type { FetchMessageObject, ImapFlow } from "imapflow";
import { recordChanges } from "./changes.js";
import {
  analyzeStructure,
  clean,
  flagsOf,
  makeSnippet,
  parseReferences,
  threadKeyOf,
  toAddresses,
  toDate,
  toSpecialUse,
} from "./message-parse.js";
import { loadPendingGuard } from "./outbox.js";

const FETCH_CHUNK = 100;
const BODY_BATCH = 20;
/** 本文 1 パートあたりの上限。これを超える分は切り捨てる。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export type SyncAccount = { id: string; userId: string };

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

/** サーバーのフォルダ一覧を DB に反映する。 */
export async function syncMailboxList(
  db: Database,
  client: ImapFlow,
  account: SyncAccount,
) {
  const listed = await client.list();
  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: mailboxes.id, path: mailboxes.path })
      .from(mailboxes)
      .where(eq(mailboxes.accountId, account.id));
    const known = new Map(existing.map((row) => [row.path, row.id]));
    const upserted: string[] = [];

    for (const entry of listed) {
      if (entry.flags.has("\\Noselect") || entry.flags.has("\\NonExistent")) {
        continue;
      }
      const specialUse =
        entry.path.toUpperCase() === "INBOX"
          ? "inbox"
          : toSpecialUse(entry.specialUse);
      const values = {
        name: clean(entry.name),
        delimiter: entry.delimiter || null,
        specialUse,
      };
      const [row] = await tx
        .insert(mailboxes)
        .values({ accountId: account.id, path: entry.path, ...values })
        .onConflictDoUpdate({
          target: [mailboxes.accountId, mailboxes.path],
          set: values,
        })
        .returning({ id: mailboxes.id });
      if (row && !known.has(entry.path)) upserted.push(row.id);
      known.delete(entry.path);
    }

    // サーバーから無くなったフォルダを消す (メッセージの所在は cascade で消える)。
    const removed = [...known.values()];
    if (removed.length > 0) {
      await tx.delete(mailboxes).where(inArray(mailboxes.id, removed));
    }
    await recordChanges(tx, account.userId, "mailbox", "upsert", upserted);
    await recordChanges(tx, account.userId, "mailbox", "delete", removed);
  });
}

/**
 * 選択中のフォルダ (呼び出し側がロックを持っていること) を DB と突き合わせる。
 * UID の一覧を比べて追加と削除を求め、フラグは CONDSTORE があれば差分だけ取る。
 */
export async function syncMailbox(
  db: Database,
  client: ImapFlow,
  account: SyncAccount,
  path: string,
) {
  const remote = client.mailbox;
  if (!remote || remote.path !== path) {
    throw new Error(`フォルダ ${path} が選択されていません。`);
  }

  const [mailbox] = await db
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.accountId, account.id), eq(mailboxes.path, path)));
  if (!mailbox) {
    throw new Error(`フォルダ ${path} が DB にありません。`);
  }

  // UIDVALIDITY が変わると、これまでの UID はすべて無効になる。取り直す。
  const uidValidityChanged =
    mailbox.uidValidity !== null && mailbox.uidValidity !== remote.uidValidity;
  if (uidValidityChanged) {
    await removeMessages(db, account, mailbox.id, null);
  }

  const local = await db
    .select({
      uid: messageMailboxes.uid,
      messageId: messages.id,
      seen: messages.seen,
      flagged: messages.flagged,
      answered: messages.answered,
      draft: messages.draft,
    })
    .from(messageMailboxes)
    .innerJoin(messages, eq(messages.id, messageMailboxes.messageId))
    .where(eq(messageMailboxes.mailboxId, mailbox.id));
  const localByUid = new Map(
    local.flatMap((row) =>
      row.uid === null ? [] : [[Number(row.uid), row] as const],
    ),
  );

  const found =
    remote.exists > 0 ? await client.search({ all: true }, { uid: true }) : [];
  if (!found) {
    throw new Error("UID の一覧を取得できませんでした。");
  }
  const remoteUids = new Set(found);

  // 削除されたメッセージ
  const removedUids = [...localByUid.keys()].filter(
    (uid) => !remoteUids.has(uid),
  );
  if (removedUids.length > 0) {
    await removeMessages(db, account, mailbox.id, removedUids);
  }

  // 新しいメッセージ。新しいものから順に取り込み、途中で切れても次回に続きから再開できる。
  const addedUids = found
    .filter((uid) => !localByUid.has(uid))
    .sort((a, b) => b - a);
  for (const uids of chunk(addedUids, FETCH_CHUNK)) {
    const fetched: FetchMessageObject[] = [];
    for await (const message of client.fetch(
      uids,
      {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true,
        internalDate: true,
        size: true,
        headers: ["references"],
      },
      { uid: true },
    )) {
      fetched.push(message);
    }
    await insertMessages(db, account, mailbox.id, fetched);
  }

  // 既存メッセージのフラグ (既読など) の変化
  const canUseModseq =
    !uidValidityChanged &&
    !remote.noModseq &&
    remote.highestModseq !== undefined &&
    mailbox.highestModseq !== null;
  const flagsUnchanged =
    canUseModseq && remote.highestModseq === mailbox.highestModseq;
  if (localByUid.size > 0 && !flagsUnchanged) {
    const changed: {
      messageId: string;
      flags: ReturnType<typeof flagsOf>;
    }[] = [];
    for await (const message of client.fetch(
      "1:*",
      { uid: true, flags: true },
      {
        uid: true,
        ...(canUseModseq && mailbox.highestModseq !== null
          ? { changedSince: mailbox.highestModseq }
          : {}),
      },
    )) {
      const row = localByUid.get(message.uid);
      if (!row || !message.flags) continue;
      const flags = flagsOf(message.flags);
      if (
        row.seen !== flags.seen ||
        row.flagged !== flags.flagged ||
        row.answered !== flags.answered ||
        row.draft !== flags.draft
      ) {
        changed.push({ messageId: row.messageId, flags });
      }
    }
    if (changed.length > 0) {
      await db.transaction(async (tx) => {
        // この端末側で既読などを変更中のメッセージは、サーバーへ反映し終えるまで
        // 上書きしない (反映後はフラグが変わるので、次の同期で改めて届く)。
        const guard = await loadPendingGuard(tx, account.id);
        const applied = changed.filter(
          (entry) => !guard.flagMessageIds.has(entry.messageId),
        );
        for (const { messageId, flags } of applied) {
          await tx
            .update(messages)
            .set(flags)
            .where(eq(messages.id, messageId));
        }
        await recordChanges(
          tx,
          account.userId,
          "message",
          "upsert",
          applied.map((entry) => entry.messageId),
        );
      });
    }
  }

  await db
    .update(mailboxes)
    .set({
      uidValidity: remote.uidValidity,
      uidNext: BigInt(remote.uidNext),
      highestModseq: remote.highestModseq ?? null,
      lastSyncedAt: new Date(),
    })
    .where(eq(mailboxes.id, mailbox.id));

  return {
    mailboxId: mailbox.id,
    added: addedUids.length,
    removed: removedUids.length,
  };
}

/** uids が null ならフォルダ内の全メッセージを消す。 */
async function removeMessages(
  db: Database,
  account: SyncAccount,
  mailboxId: string,
  uids: number[] | null,
) {
  await db.transaction(async (tx) => {
    const removed = await tx
      .delete(messageMailboxes)
      .where(
        and(
          eq(messageMailboxes.mailboxId, mailboxId),
          uids
            ? inArray(
                messageMailboxes.uid,
                uids.map((uid) => BigInt(uid)),
              )
            : undefined,
        ),
      )
      .returning({ messageId: messageMailboxes.messageId });
    const ids = [...new Set(removed.map((row) => row.messageId))];
    if (ids.length === 0) return;
    // 他のフォルダにも無くなったメッセージだけを本体ごと消す。
    const deleted = await tx
      .delete(messages)
      .where(
        and(
          inArray(messages.id, ids),
          notInArray(
            messages.id,
            tx
              .select({ id: messageMailboxes.messageId })
              .from(messageMailboxes)
              .where(inArray(messageMailboxes.messageId, ids)),
          ),
        ),
      )
      .returning({ id: messages.id });
    await recordChanges(
      tx,
      account.userId,
      "message",
      "delete",
      deleted.map((row) => row.id),
    );
  });
}

async function insertMessages(
  db: Database,
  account: SyncAccount,
  mailboxId: string,
  fetched: FetchMessageObject[],
) {
  if (fetched.length === 0) return;
  await db.transaction(async (tx) => {
    // 移動・削除を受け付けたがまだサーバーへ反映していないメッセージは、
    // サーバーにはまだ残っている。取り込み直さない。
    const guard = await loadPendingGuard(tx, account.id);
    const removing = guard.removedUids.get(mailboxId);
    const inserted: string[] = [];
    for (const message of fetched) {
      if (removing?.has(message.uid)) continue;
      const envelope = message.envelope ?? {};
      const references = parseReferences(message.headers).map(clean);
      const structure = analyzeStructure(message.bodyStructure);
      const sentAt = toDate(envelope.date);
      const [row] = await tx
        .insert(messages)
        .values({
          accountId: account.id,
          providerMessageId: message.emailId ?? null,
          threadKey: threadKeyOf({
            references,
            inReplyTo: envelope.inReplyTo,
            messageId: envelope.messageId,
            fallback: `${mailboxId}:${message.uid}`,
          }),
          messageIdHeader: envelope.messageId
            ? clean(envelope.messageId)
            : null,
          inReplyTo: envelope.inReplyTo ? clean(envelope.inReplyTo) : null,
          references,
          subject: clean(envelope.subject),
          from: toAddresses(envelope.from),
          to: toAddresses(envelope.to),
          cc: toAddresses(envelope.cc),
          bcc: toAddresses(envelope.bcc),
          replyTo: toAddresses(envelope.replyTo),
          sentAt,
          receivedAt: toDate(message.internalDate) ?? sentAt ?? new Date(),
          size: message.size ?? 0,
          hasAttachments: structure.attachments.some((file) => !file.inline),
          ...flagsOf(message.flags),
        })
        // サーバーが不変の ID (OBJECTID の EMAILID など) を返す場合、複製された
        // メッセージは同じ ID になる。その場合は既存の行に所在だけを足す。
        .onConflictDoNothing({
          target: [messages.accountId, messages.providerMessageId],
        })
        .returning({ id: messages.id });
      if (!row) {
        if (!message.emailId) continue;
        const [existing] = await tx
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.accountId, account.id),
              eq(messages.providerMessageId, message.emailId),
            ),
          );
        if (!existing) continue;
        await tx
          .insert(messageMailboxes)
          .values({
            mailboxId,
            uid: BigInt(message.uid),
            messageId: existing.id,
            modseq: message.modseq ?? null,
          })
          .onConflictDoNothing();
        inserted.push(existing.id);
        continue;
      }
      const [placed] = await tx
        .insert(messageMailboxes)
        .values({
          mailboxId,
          uid: BigInt(message.uid),
          messageId: row.id,
          modseq: message.modseq ?? null,
        })
        .onConflictDoNothing()
        .returning({ uid: messageMailboxes.uid });
      if (!placed) {
        // 別のワーカー (再起動の入れ替わりなど) が同じ UID を先に取り込んでいた。
        // 二重にならないよう、いま作った行を取り消す。
        await tx.delete(messages).where(eq(messages.id, row.id));
        continue;
      }
      if (structure.attachments.length > 0) {
        await tx.insert(attachments).values(
          structure.attachments.map((file) => ({
            messageId: row.id,
            ...file,
          })),
        );
      }
      inserted.push(row.id);
    }
    await recordChanges(tx, account.userId, "message", "upsert", inserted);
  });
}

async function readText(
  client: ImapFlow,
  uid: number,
  part: string | null,
): Promise<string | null> {
  if (!part) return null;
  const download = await client.download(String(uid), part, {
    uid: true,
    maxBytes: MAX_BODY_BYTES,
  });
  if (!download.content) return null;
  const chunks: Buffer[] = [];
  for await (const data of download.content) {
    chunks.push(data as Buffer);
  }
  // download() は転送エンコードを解き、テキストの文字コードを UTF-8 に変換して返す。
  return clean(Buffer.concat(chunks).toString("utf8"));
}

/**
 * 本文をまだ取得していないメッセージを、新しい順に 1 回分だけ取得する。
 * 取得対象が残っていれば true を返す (呼び出し側が続けて呼ぶ)。
 */
export async function fetchBodies(
  db: Database,
  client: ImapFlow,
  account: SyncAccount,
  mailboxId: string,
): Promise<boolean> {
  const pending = await db
    .select({ uid: messageMailboxes.uid, messageId: messages.id })
    .from(messageMailboxes)
    .innerJoin(messages, eq(messages.id, messageMailboxes.messageId))
    .where(
      and(
        eq(messageMailboxes.mailboxId, mailboxId),
        isNotNull(messageMailboxes.uid),
        isNull(messages.bodyFetchedAt),
      ),
    )
    .orderBy(desc(messages.receivedAt))
    .limit(BODY_BATCH + 1);
  const batch = pending.slice(0, BODY_BATCH);
  if (batch.length === 0) return false;

  const structures = new Map<number, ReturnType<typeof analyzeStructure>>();
  for await (const message of client.fetch(
    batch.map((row) => Number(row.uid)),
    { uid: true, bodyStructure: true },
    { uid: true },
  )) {
    structures.set(message.uid, analyzeStructure(message.bodyStructure));
  }

  const done: string[] = [];
  for (const row of batch) {
    const uid = Number(row.uid);
    const structure = structures.get(uid);
    let bodyText: string | null = null;
    let bodyHtml: string | null = null;
    // サーバーから消えていた場合は structure が無い。空のまま取得済みにする
    // (次の同期でメッセージごと消える)。
    if (structure) {
      bodyText = await readText(client, uid, structure.textPart);
      bodyHtml = await readText(client, uid, structure.htmlPart);
    }
    await db
      .update(messages)
      .set({
        bodyText,
        bodyHtml,
        snippet: makeSnippet(bodyText, bodyHtml),
        bodyFetchedAt: new Date(),
      })
      .where(eq(messages.id, row.messageId));
    done.push(row.messageId);
  }
  await db.transaction((tx) =>
    recordChanges(tx, account.userId, "message", "upsert", done),
  );
  return pending.length > BODY_BATCH;
}
