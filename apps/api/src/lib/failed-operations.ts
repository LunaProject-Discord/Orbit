import {
  accountLockKey,
  CHANNEL_CHANGES,
  CHANNEL_OUTBOX,
  type ChangeNotification,
  type MovePayload,
  type OutboxTarget,
  type SetFlagsPayload,
} from "@mail/core";
import {
  changes,
  type Database,
  mailAccounts,
  mailboxes,
  messageMailboxes,
  messages,
  outbox,
} from "@mail/db";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { recordChanges, removePlacements, type Tx } from "./message-actions.js";

/**
 * メールサーバーへ反映できなかった操作 (既読、スター、移動、削除、控えの保存)。
 * 同期ワーカーが失敗として確定させたもので、画面に通知を出し、やり直しか破棄を選べる。
 * 送信の失敗は別に扱う (GET /v1/messages/outgoing)。
 */
export type FailedOperation = {
  id: string;
  accountId: string;
  kind:
    | "set_flags"
    | "move"
    | "delete"
    | "append"
    | "mailbox_create"
    | "mailbox_rename"
    | "mailbox_delete";
  /** 対象のメールの数 (フォルダへの操作では 1)。 */
  count: number;
  /** フォルダへの操作の対象 (作成と名前の変更では、付けようとした名前)。 */
  mailboxName: string | null;
  /** set_flags で変えようとした内容。 */
  seen: boolean | null;
  flagged: boolean | null;
  answered: boolean | null;
  /** move の移動先のフォルダ。 */
  destinationMailboxId: string | null;
  /** メールサーバーなどから返った失敗の理由。 */
  error: string | null;
  createdAt: Date;
  failedAt: Date;
};

const FAILURE_KINDS = [
  "set_flags",
  "move",
  "delete",
  "append",
  "mailbox_create",
  "mailbox_rename",
  "mailbox_delete",
] as const;

/** メッセージを対象にする操作。やり直すときに、対象がまだあるかを確かめる。 */
const MESSAGE_KINDS: readonly string[] = ["set_flags", "move", "delete"];

function targetsOf(payload: Record<string, unknown>): OutboxTarget[] {
  return Array.isArray(payload.targets)
    ? (payload.targets as OutboxTarget[])
    : [];
}

function toFailedOperation(row: {
  id: string;
  accountId: string;
  kind: string;
  payload: Record<string, unknown>;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}): FailedOperation {
  const flags = row.payload as Partial<SetFlagsPayload>;
  const destination = (row.payload as Partial<MovePayload>).destination;
  const messageIds = new Set(
    targetsOf(row.payload).map((target) => target.messageId),
  );
  return {
    id: row.id,
    accountId: row.accountId,
    kind: row.kind as FailedOperation["kind"],
    // 控えの保存 (append) は対象を持たないが、メール 1 通分。
    count: Math.max(messageIds.size, 1),
    mailboxName: row.kind.startsWith("mailbox_")
      ? String((row.payload as { name?: unknown }).name ?? "")
      : null,
    seen: row.kind === "set_flags" ? (flags.seen ?? null) : null,
    flagged: row.kind === "set_flags" ? (flags.flagged ?? null) : null,
    answered: row.kind === "set_flags" ? (flags.answered ?? null) : null,
    destinationMailboxId:
      row.kind === "move" ? (destination?.mailboxId ?? null) : null,
    error: row.lastError,
    createdAt: row.createdAt,
    failedAt: row.updatedAt,
  };
}

export async function listFailedOperations(
  db: Database,
  userId: string,
): Promise<FailedOperation[]> {
  const rows = await db
    .select({
      id: outbox.id,
      accountId: outbox.accountId,
      kind: outbox.kind,
      payload: outbox.payload,
      lastError: outbox.lastError,
      createdAt: outbox.createdAt,
      updatedAt: outbox.updatedAt,
    })
    .from(outbox)
    .innerJoin(mailAccounts, eq(mailAccounts.id, outbox.accountId))
    .where(
      and(
        eq(mailAccounts.userId, userId),
        eq(outbox.status, "failed"),
        inArray(outbox.kind, FAILURE_KINDS),
      ),
    )
    .orderBy(desc(outbox.updatedAt), desc(outbox.id))
    .limit(100);
  return rows.map(toFailedOperation);
}

/** 失敗の一覧が変わったことを、利用者の端末へ知らせる。 */
async function notifyFailures(tx: Tx, userId: string, accountId: string) {
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

/** 本人の、失敗した操作 1 件を取り出す。アカウントのロックを取ってから読み直す。 */
async function loadFailed(tx: Tx, userId: string, id: string) {
  const [owned] = await tx
    .select({ accountId: outbox.accountId })
    .from(outbox)
    .innerJoin(mailAccounts, eq(mailAccounts.id, outbox.accountId))
    .where(and(eq(outbox.id, id), eq(mailAccounts.userId, userId)));
  if (!owned) return null;
  // 同期ワーカーの書き込みと順番に実行する。
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${accountLockKey(owned.accountId)}, 0))`,
  );
  const [row] = await tx
    .select()
    .from(outbox)
    .where(
      and(
        eq(outbox.id, id),
        eq(outbox.status, "failed"),
        inArray(outbox.kind, FAILURE_KINDS),
      ),
    );
  return row ?? null;
}

/**
 * 失敗した操作の対象が、いま DB のどのメッセージに当たるかを調べる。
 * 失敗のあと、同期がサーバーの状態に合わせてメッセージを取り込み直すと、
 * messages.id が変わっていることがある。IMAP はフォルダと UID、Microsoft Graph は
 * 不変 ID で突き合わせる。
 */
async function resolveTargets(
  tx: Tx,
  accountId: string,
  targets: OutboxTarget[],
) {
  const mailboxIds = [...new Set(targets.map((target) => target.mailboxId))];
  const boxes =
    mailboxIds.length > 0
      ? await tx
          .select({ id: mailboxes.id, uidValidity: mailboxes.uidValidity })
          .from(mailboxes)
          .where(
            and(
              eq(mailboxes.accountId, accountId),
              inArray(mailboxes.id, mailboxIds),
            ),
          )
      : [];
  const validity = new Map(
    boxes.map((box) => [box.id, box.uidValidity?.toString() ?? null]),
  );
  const placed =
    mailboxIds.length > 0
      ? await tx
          .select({
            mailboxId: messageMailboxes.mailboxId,
            uid: messageMailboxes.uid,
            messageId: messages.id,
          })
          .from(messageMailboxes)
          .innerJoin(messages, eq(messages.id, messageMailboxes.messageId))
          .where(
            and(
              eq(messages.accountId, accountId),
              inArray(messageMailboxes.mailboxId, mailboxIds),
            ),
          )
      : [];
  const byUid = new Map<string, string>();
  for (const row of placed) {
    if (row.uid !== null) {
      byUid.set(`${row.mailboxId}:${row.uid.toString()}`, row.messageId);
    }
  }
  // Microsoft Graph のメッセージは、フォルダに関係なく不変 ID で指せる。
  const providerIds = targets.flatMap((target) =>
    target.uid === null && target.providerMessageId !== null
      ? [target.providerMessageId]
      : [],
  );
  const byProviderId = new Map<string, string>();
  if (providerIds.length > 0) {
    const rows = await tx
      .select({
        messageId: messages.id,
        providerMessageId: messages.providerMessageId,
      })
      .from(messages)
      .where(
        and(
          eq(messages.accountId, accountId),
          inArray(messages.providerMessageId, providerIds),
        ),
      );
    for (const row of rows) {
      if (row.providerMessageId !== null) {
        byProviderId.set(row.providerMessageId, row.messageId);
      }
    }
  }

  return matchTargets(targets, validity, byUid, byProviderId);
}

/**
 * 失敗した操作の対象を、いまの DB の内容と突き合わせる。
 * validity はフォルダの ID から今の UIDVALIDITY、byUid は「フォルダの ID:UID」から、
 * byProviderId は Microsoft Graph の不変 ID から、今の messages.id を引く。
 */
export function matchTargets(
  targets: OutboxTarget[],
  validity: Map<string, string | null>,
  byUid: Map<string, string>,
  byProviderId: Map<string, string>,
) {
  /** DB に今もあるもの (messageId は今の値に直す)。 */
  const present: OutboxTarget[] = [];
  /** DB には無いが、まだ実行できるかもしれないもの。 */
  const absent: OutboxTarget[] = [];
  for (const target of targets) {
    // フォルダが消えた。もう同じメールを指せない。
    if (!validity.has(target.mailboxId)) continue;
    if (target.uid !== null) {
      const current = validity.get(target.mailboxId) ?? null;
      // フォルダの最初の取り込みが終わる前に受け付けた操作は、UIDVALIDITY を持っていない
      // (以前は取り込みが終わるまで保存していなかった)。今の値を補ってやり直せるようにする。
      const resolved: OutboxTarget =
        target.uidValidity === null && current !== null
          ? { ...target, uidValidity: current }
          : target;
      // UID が振り直された。もう同じメールを指せない。
      if (current !== resolved.uidValidity) continue;
      const messageId = byUid.get(`${target.mailboxId}:${target.uid}`);
      if (messageId) present.push({ ...resolved, messageId });
      else absent.push(resolved);
    } else if (target.providerMessageId !== null) {
      const messageId = byProviderId.get(target.providerMessageId);
      if (messageId) present.push({ ...target, messageId });
      else absent.push(target);
    }
  }
  return { present, absent };
}

export type RetryResult = "ok" | "not_found" | "gone";

/**
 * 失敗した操作をやり直す。画面と DB にもう一度反映し、送信待ちキューへ戻す。
 * 対象のメールがもう無ければ "gone" を返し、失敗の記録を消す。
 */
export async function retryFailedOperation(
  db: Database,
  userId: string,
  id: string,
): Promise<RetryResult> {
  return db.transaction(async (tx): Promise<RetryResult> => {
    const row = await loadFailed(tx, userId, id);
    if (!row) return "not_found";
    const accountId = row.accountId;
    let payload = row.payload;

    if (MESSAGE_KINDS.includes(row.kind)) {
      const { present, absent } = await resolveTargets(
        tx,
        accountId,
        targetsOf(row.payload),
      );
      let targets: OutboxTarget[];
      if (row.kind === "set_flags") {
        // 既読やスターは、DB に今あるメールにだけ付け直せる。
        targets = present;
        const ids = [...new Set(targets.map((target) => target.messageId))];
        const { seen, flagged, answered } = row.payload as SetFlagsPayload;
        const values = {
          ...(seen === undefined ? {} : { seen }),
          ...(flagged === undefined ? {} : { flagged }),
          ...(answered === undefined ? {} : { answered }),
        };
        if (ids.length > 0 && Object.keys(values).length > 0) {
          await tx
            .update(messages)
            .set(values)
            .where(inArray(messages.id, ids));
          await recordChanges(tx, userId, "upsert", ids);
        }
      } else {
        // 移動と削除。同期が取り込み直したメールは、もう一度フォルダから外す。
        // まだ取り込み直されていないものは、DB では外れたままなので、そのまま実行する。
        targets = [...present, ...absent];
        if (present.length > 0) await removePlacements(tx, userId, present);
      }
      if (targets.length === 0) {
        await tx.delete(outbox).where(eq(outbox.id, id));
        await notifyFailures(tx, userId, accountId);
        return "gone";
      }
      payload = { ...row.payload, targets };
    }

    await tx
      .update(outbox)
      .set({ status: "pending", attempts: 0, lastError: null, payload })
      .where(eq(outbox.id, id));
    await notifyFailures(tx, userId, accountId);
    // コミット時に同期ワーカーへ届き、すぐにメールサーバーへ反映される。
    await tx.execute(sql`select pg_notify(${CHANNEL_OUTBOX}, ${accountId})`);
    return "ok";
  });
}

/** 失敗した操作を、やり直さずに一覧から消す。 */
export async function dismissFailedOperation(
  db: Database,
  userId: string,
  id: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const row = await loadFailed(tx, userId, id);
    if (!row) return false;
    await tx
      .delete(outbox)
      .where(and(eq(outbox.id, id), ne(outbox.kind, "send")));
    await notifyFailures(tx, userId, row.accountId);
    return true;
  });
}
