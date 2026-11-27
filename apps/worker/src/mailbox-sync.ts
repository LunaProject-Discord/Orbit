import {
  MAX_PREVIEW,
  MAX_SINGLE_NOTIFICATIONS,
  NEW_MAIL_MAX_AGE_MS,
  type NewMailCandidate,
} from "@orbit/core";
import {
  attachments,
  type Database,
  mailboxes,
  messageMailboxes,
  messages,
} from "@orbit/db";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm";
import type { FetchMessageObject, ImapFlow } from "imapflow";
import { recordChanges, type Tx } from "./changes.js";
import { toListedMailboxes } from "./mailbox-list.js";
import {
  applyMailboxList,
  dropStalePending,
  type SyncAccount,
} from "./mailbox-store.js";
import {
  authTrustOf,
  FETCH_HEADERS,
  headersPending,
  LIST_HEADERS,
  parseListHeaders,
} from "./message-headers.js";
import {
  analyzeStructure,
  clean,
  flagsOf,
  makeSnippet,
  parseReferences,
  threadKeyOf,
  toAddresses,
  toDate,
} from "./message-parse.js";
import { announceNewMail } from "./new-mail.js";
import { loadPendingGuard } from "./outbox.js";
import { resolveThreadKey } from "./thread-key.js";

const FETCH_CHUNK = 100;
const BODY_BATCH = 20;
const HEADER_BATCH = 200;
/** 本文 1 パートあたりの上限。これを超える分は切り捨てる。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export type { SyncAccount };

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

export const STATUS_QUERY = {
  messages: true,
  uidNext: true,
  uidValidity: true,
  unseen: true,
  highestModseq: true,
};

/**
 * サーバーのフォルダ一覧を DB に反映し、取得した一覧を返す。
 * withStatus が true なら、各フォルダの件数や変更番号 (STATUS) も一緒に取得する。
 */
export async function syncMailboxList(
  db: Database,
  client: ImapFlow,
  account: SyncAccount,
  withStatus = false,
) {
  const listed = await client.list(
    withStatus ? { statusQuery: STATUS_QUERY } : undefined,
  );
  await applyMailboxList(db, account, toListedMailboxes(listed));
  return listed;
}

/**
 * フォルダごとの同期状態と、DB にあるメッセージの数 (path をキーにする)。
 * mailboxId を渡すと、そのフォルダだけを調べる。
 */
export async function loadMailboxStates(
  db: Database,
  accountId: string,
  mailboxId?: string,
) {
  const rows = await db
    .select({
      id: mailboxes.id,
      path: mailboxes.path,
      specialUse: mailboxes.specialUse,
      uidValidity: mailboxes.uidValidity,
      uidNext: mailboxes.uidNext,
      highestModseq: mailboxes.highestModseq,
      lastSyncedAt: mailboxes.lastSyncedAt,
      total: sql<number>`count(${messageMailboxes.messageId})::int`,
      unseen: sql<number>`(count(*) filter (where ${messages.seen} = false))::int`,
      /** いちばん新しいメールの日時。通知を受ける接続を張るフォルダの順番に使う。 */
      latestAt: sql<Date | null>`max(${messages.receivedAt})`.mapWith(
        (value: string | Date) => new Date(value),
      ),
    })
    .from(mailboxes)
    .leftJoin(messageMailboxes, eq(messageMailboxes.mailboxId, mailboxes.id))
    .leftJoin(messages, eq(messages.id, messageMailboxes.messageId))
    .where(
      and(
        eq(mailboxes.accountId, accountId),
        mailboxId ? eq(mailboxes.id, mailboxId) : undefined,
      ),
    )
    .groupBy(mailboxes.id);
  return new Map(rows.map((row) => [row.path, row]));
}

/** 本文をまだ取得していないメッセージがあるフォルダ。 */
export async function mailboxesWithPendingBodies(
  db: Database,
  accountId: string,
) {
  return db
    .selectDistinct({
      id: mailboxes.id,
      path: mailboxes.path,
      specialUse: mailboxes.specialUse,
    })
    .from(mailboxes)
    .innerJoin(messageMailboxes, eq(messageMailboxes.mailboxId, mailboxes.id))
    .innerJoin(messages, eq(messages.id, messageMailboxes.messageId))
    .where(
      and(
        eq(mailboxes.accountId, accountId),
        isNotNull(messageMailboxes.uid),
        isNull(messages.bodyFetchedAt),
      ),
    );
}

/** 代理送信やメーリングリストの情報をまだ取り込んでいないメッセージがあるフォルダ。 */
export async function mailboxesWithPendingHeaders(
  db: Database,
  accountId: string,
) {
  return db
    .selectDistinct({ id: mailboxes.id, path: mailboxes.path })
    .from(messages)
    .innerJoin(messageMailboxes, eq(messageMailboxes.messageId, messages.id))
    .innerJoin(mailboxes, eq(mailboxes.id, messageMailboxes.mailboxId))
    .where(
      and(
        eq(messages.accountId, accountId),
        headersPending,
        isNotNull(messageMailboxes.uid),
      ),
    );
}

/**
 * 代理送信 (Sender) とメーリングリストの情報をまだ取り込んでいないメッセージを、
 * 新しい順に 1 回分だけ補う。これらの項目を足す前に取り込んだメールが対象。
 * 取得対象が残っていれば true を返す (呼び出し側が続けて呼ぶ)。
 */
export async function fetchHeaders(
  db: Database,
  client: ImapFlow,
  account: SyncAccount,
  mailboxId: string,
): Promise<boolean> {
  const pending = await db
    .select({
      uid: messageMailboxes.uid,
      messageId: messages.id,
      from: messages.from,
    })
    .from(messageMailboxes)
    .innerJoin(messages, eq(messages.id, messageMailboxes.messageId))
    .where(
      and(
        eq(messageMailboxes.mailboxId, mailboxId),
        isNotNull(messageMailboxes.uid),
        headersPending,
      ),
    )
    .orderBy(desc(messages.receivedAt))
    .limit(HEADER_BATCH + 1);
  const batch = pending.slice(0, HEADER_BATCH);
  if (batch.length === 0) return false;

  const fetched = new Map<number, FetchMessageObject>();
  for await (const message of client.fetch(
    batch.map((row) => Number(row.uid)),
    { uid: true, envelope: true, headers: LIST_HEADERS },
    { uid: true },
  )) {
    fetched.set(message.uid, message);
  }

  const changed: string[] = [];
  await db.transaction(async (tx) => {
    for (const row of batch) {
      // サーバーから消えていた場合は、空のまま取り込み済みにする (次の同期でメッセージごと消える)。
      const message = fetched.get(Number(row.uid));
      const sender = toAddresses(message?.envelope?.sender);
      const list = parseListHeaders(
        message?.headers,
        row.from,
        authTrustOf(account),
      );
      await tx
        .update(messages)
        .set({ sender, ...list, headersFetchedAt: new Date() })
        .where(eq(messages.id, row.messageId));
      // 画面に出る内容が増えたメールだけ、端末へ変更を知らせる。
      const fromAddresses = new Set(
        row.from.map((item) => item.address.toLowerCase()),
      );
      if (
        list.listId !== null ||
        list.listUnsubscribe.length > 0 ||
        list.senderCheck.warnings.length > 0 ||
        sender.some((item) => !fromAddresses.has(item.address.toLowerCase()))
      ) {
        changed.push(row.messageId);
      }
    }
    await recordChanges(tx, account.userId, "message", "upsert", changed);
  });
  return pending.length > HEADER_BATCH;
}

/**
 * フォルダを開いた時点で保存する UIDVALIDITY の更新内容。変わっていなければ null。
 *
 * 取り込みが終わってから保存すると、最初の取り込みの途中 (Gmail のようにメールが多いと
 * 数分かかる) で開いたメールへの既読などの操作が、UIDVALIDITY を持たないまま受け付けられ、
 * 反映時に「フォルダが作り直された」と誤って判定される。そのため取り込む前に保存する。
 * 値が変わった場合は、前の番号体系の同期状態 (UIDNEXT や変更番号) も捨てて、
 * 取り込みが途中で切れても次回に最初から突き合わせるようにする。
 */
export function uidValidityUpdate(stored: bigint | null, remote: bigint) {
  if (stored === remote) return null;
  if (stored === null) return { uidValidity: remote };
  return {
    uidValidity: remote,
    uidNext: null,
    highestModseq: null,
    lastSyncedAt: null,
  };
}

/**
 * 選択中のフォルダ (呼び出し側がロックを持っていること) を DB と突き合わせる。
 * UID の一覧を比べて追加と削除を求め、フラグは CONDSTORE があれば差分だけ取る。
 * shouldStop が true を返すと取り込みの途中で切り上げ、complete: false を返す
 * (同期状態は保存しないので、次回に続きから取り込む)。
 */
export async function syncMailbox(
  db: Database,
  client: ImapFlow,
  account: SyncAccount,
  path: string,
  shouldStop?: () => boolean,
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
  // UIDVALIDITY は、メッセージを取り込む前に保存する (理由は uidValidityUpdate を参照)。
  const validityUpdate = uidValidityUpdate(
    mailbox.uidValidity,
    remote.uidValidity,
  );
  if (validityUpdate) {
    await db
      .update(mailboxes)
      .set(validityUpdate)
      .where(eq(mailboxes.id, mailbox.id));
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

  // 受信トレイに前回の同期より後に届いたメール (UID が前回の UIDNEXT 以上) は、新着として
  // 端末へ通知する。初回の取り込みや、UID を振り直された場合は通知しない。
  const announceFromUid =
    mailbox.specialUse === "inbox" &&
    !uidValidityChanged &&
    mailbox.lastSyncedAt !== null &&
    mailbox.uidNext !== null
      ? Number(mailbox.uidNext)
      : null;

  // 新しいメッセージ。新しいものから順に取り込み、途中で切れても次回に続きから再開できる。
  const addedUids = found
    .filter((uid) => !localByUid.has(uid))
    .sort((a, b) => b - a);
  for (const uids of chunk(addedUids, FETCH_CHUNK)) {
    if (shouldStop?.()) {
      return {
        mailboxId: mailbox.id,
        added: 0,
        removed: removedUids.length,
        complete: false,
      };
    }
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
        headers: FETCH_HEADERS,
      },
      { uid: true },
    )) {
      fetched.push(message);
    }
    const bodies =
      announceFromUid === null
        ? new Map<number, FetchedBody>()
        : await readNewMailBodies(client, fetched, announceFromUid);
    await insertMessages(
      db,
      account,
      mailbox.id,
      fetched,
      announceFromUid,
      bodies,
    );
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
  // 移動中として置いたまま結び付かなかった所在を片付ける。
  await dropStalePending(db, account, mailbox.id);

  return {
    mailboxId: mailbox.id,
    added: addedUids.length,
    removed: removedUids.length,
    complete: true,
  };
}

/**
 * 移動先のフォルダに「移動中」として先に置いた所在のうち、同じメール (Message-ID が同じ) を
 * 探して、取り込んだ UID を入れる。見つかればそのメッセージの ID を返す。
 */
async function claimPendingPlacement(
  tx: Tx,
  accountId: string,
  mailboxId: string,
  found: {
    messageIdHeader: string | null;
    subject: string;
    receivedAt: Date;
    uid: number;
    modseq: bigint | null;
    flags: ReturnType<typeof flagsOf>;
    /** 既読などを変更中のメッセージ。反映し終えるまでフラグを上書きしない。 */
    guardedFlags: ReadonlySet<string>;
  },
): Promise<string | null> {
  const [pending] = await tx
    .select({ messageId: messageMailboxes.messageId })
    .from(messageMailboxes)
    .innerJoin(messages, eq(messages.id, messageMailboxes.messageId))
    .where(
      and(
        eq(messageMailboxes.mailboxId, mailboxId),
        isNotNull(messageMailboxes.pendingSince),
        eq(messages.accountId, accountId),
        found.messageIdHeader
          ? eq(messages.messageIdHeader, found.messageIdHeader)
          : // Message-ID の無いメールは、件名と受信日時 (移動しても変わらない) で見分ける。
            and(
              isNull(messages.messageIdHeader),
              eq(messages.subject, found.subject),
              eq(messages.receivedAt, found.receivedAt),
            ),
      ),
    )
    .limit(1);
  if (!pending) return null;
  await tx
    .update(messageMailboxes)
    .set({
      uid: BigInt(found.uid),
      modseq: found.modseq,
      pendingSince: null,
    })
    .where(
      and(
        eq(messageMailboxes.mailboxId, mailboxId),
        eq(messageMailboxes.messageId, pending.messageId),
      ),
    );
  // 移動のあいだにほかのメールソフトで変えられたかもしれないので、フラグは移動先の値にする。
  if (!found.guardedFlags.has(pending.messageId)) {
    await tx
      .update(messages)
      .set(found.flags)
      .where(eq(messages.id, pending.messageId));
  }
  return pending.messageId;
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

type FetchedBody = { bodyText: string | null; bodyHtml: string | null };

/**
 * 新着として通知するメールの本文を、取り込みの前に読む (通知に本文の冒頭を出すため)。
 * 1 通ずつ知らせる数までのときだけ読む。多いときはまとめた通知になり、本文は出さない。
 * 読めなかったメールは、本文なしで通知する (本文は後からの取り込みで入る)。
 */
async function readNewMailBodies(
  client: ImapFlow,
  fetched: FetchMessageObject[],
  announceFromUid: number,
): Promise<Map<number, FetchedBody>> {
  const bodies = new Map<number, FetchedBody>();
  const now = Date.now();
  const targets = fetched.filter((message) => {
    if (message.uid < announceFromUid) return false;
    const flags = flagsOf(message.flags);
    if (flags.seen || flags.draft) return false;
    const receivedAt =
      toDate(message.internalDate) ?? toDate(message.envelope?.date);
    return !receivedAt || now - receivedAt.getTime() <= NEW_MAIL_MAX_AGE_MS;
  });
  if (targets.length === 0 || targets.length > MAX_SINGLE_NOTIFICATIONS) {
    return bodies;
  }
  for (const message of targets) {
    try {
      bodies.set(
        message.uid,
        await readBody(
          client,
          message.uid,
          analyzeStructure(message.bodyStructure),
        ),
      );
    } catch {
      // 本文なしで通知する。
    }
  }
  return bodies;
}

export async function insertMessages(
  db: Database,
  account: SyncAccount,
  mailboxId: string,
  fetched: FetchMessageObject[],
  /** この UID 以上のメールを新着として通知する。null なら通知しない。 */
  announceFromUid: number | null,
  /** 先に読んでおいた本文 (UID ごと)。あるメールは、本文も一緒に取り込む。 */
  bodies: Map<number, FetchedBody> = new Map(),
) {
  if (fetched.length === 0) return;
  await db.transaction(async (tx) => {
    // 移動・削除を受け付けたがまだサーバーへ反映していないメッセージは、
    // サーバーにはまだ残っている。取り込み直さない。
    const guard = await loadPendingGuard(tx, account.id);
    const removing = guard.removedUids.get(mailboxId);
    const inserted: string[] = [];
    const arrived: NewMailCandidate[] = [];
    for (const message of fetched) {
      if (removing?.has(message.uid)) continue;
      const envelope = message.envelope ?? {};
      const references = parseReferences(message.headers).map(clean);
      const structure = analyzeStructure(message.bodyStructure);
      const sentAt = toDate(envelope.date);
      const receivedAt = toDate(message.internalDate) ?? sentAt ?? new Date();
      const flags = flagsOf(message.flags);
      const body = bodies.get(message.uid);
      const messageIdHeader = envelope.messageId
        ? clean(envelope.messageId)
        : null;
      const inReplyTo = envelope.inReplyTo ? clean(envelope.inReplyTo) : null;
      const { threadKey, moved } = await resolveThreadKey(tx, account.id, {
        computed: threadKeyOf({
          references,
          inReplyTo: envelope.inReplyTo,
          messageId: envelope.messageId,
          fallback: `${mailboxId}:${message.uid}`,
        }),
        messageId: messageIdHeader,
        parents: [...references, ...(inReplyTo ? [inReplyTo] : [])],
      });
      inserted.push(...moved);
      // このアプリで移動したメールは、移動先に「移動中」の所在が先にある。
      // 同じメールなら新しく取り込まずに、その所在へ UID を入れて結び付ける。
      const claimed = await claimPendingPlacement(tx, account.id, mailboxId, {
        messageIdHeader,
        subject: clean(envelope.subject),
        receivedAt,
        uid: message.uid,
        modseq: message.modseq ?? null,
        flags,
        guardedFlags: guard.flagMessageIds,
      });
      if (claimed) {
        inserted.push(claimed);
        continue;
      }
      const [row] = await tx
        .insert(messages)
        .values({
          accountId: account.id,
          providerMessageId: message.emailId ?? null,
          threadKey,
          messageIdHeader,
          inReplyTo,
          references,
          subject: clean(envelope.subject),
          from: toAddresses(envelope.from),
          to: toAddresses(envelope.to),
          cc: toAddresses(envelope.cc),
          bcc: toAddresses(envelope.bcc),
          replyTo: toAddresses(envelope.replyTo),
          sender: toAddresses(envelope.sender),
          ...parseListHeaders(
            message.headers,
            toAddresses(envelope.from),
            authTrustOf(account),
          ),
          headersFetchedAt: new Date(),
          sentAt,
          receivedAt,
          size: message.size ?? 0,
          hasAttachments: structure.attachments.some((file) => !file.inline),
          ...flags,
          ...(body
            ? {
                bodyText: body.bodyText,
                bodyHtml: body.bodyHtml,
                snippet: makeSnippet(body.bodyText, body.bodyHtml),
                bodyFetchedAt: new Date(),
              }
            : {}),
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
          // 移動中として先に置いた所在なら、UID を入れて確定させる。
          .onConflictDoUpdate({
            target: [messageMailboxes.mailboxId, messageMailboxes.messageId],
            set: {
              uid: BigInt(message.uid),
              modseq: message.modseq ?? null,
              pendingSince: null,
            },
            setWhere: isNotNull(messageMailboxes.pendingSince),
          });
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
      if (
        announceFromUid !== null &&
        message.uid >= announceFromUid &&
        !flags.draft
      ) {
        arrived.push({
          id: row.id,
          from: toAddresses(envelope.from),
          subject: clean(envelope.subject),
          ...(body
            ? {
                preview: makeSnippet(body.bodyText, body.bodyHtml, MAX_PREVIEW),
              }
            : {}),
          seen: flags.seen,
          receivedAt,
        });
      }
    }
    await recordChanges(tx, account.userId, "message", "upsert", inserted);
    await announceNewMail(tx, account, arrived);
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

/** 選択中のフォルダにあるメッセージ 1 通の本文 (テキストと HTML) を読む。 */
export async function readBody(
  client: ImapFlow,
  uid: number,
  structure: Pick<ReturnType<typeof analyzeStructure>, "textPart" | "htmlPart">,
) {
  return {
    bodyText: await readText(client, uid, structure.textPart),
    bodyHtml: await readText(client, uid, structure.htmlPart),
  };
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
    // サーバーから消えていた場合は structure が無い。空のまま取得済みにする
    // (次の同期でメッセージごと消える)。
    const { bodyText, bodyHtml } = structure
      ? await readBody(client, uid, structure)
      : { bodyText: null, bodyHtml: null };
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
