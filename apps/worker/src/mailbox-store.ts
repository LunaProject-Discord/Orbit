import { resolveMailboxRoles } from "@orbit/core";
import {
  type Database,
  mailboxes,
  messageMailboxes,
  messages,
  outbox,
} from "@orbit/db";
import { and, eq, inArray, isNotNull, lt, notInArray } from "drizzle-orm";
import { recordChanges, type Tx } from "./changes.js";
import type { ListedMailbox } from "./mailbox-list.js";

export type SyncAccount = { id: string; userId: string };

/**
 * フォルダからメッセージの所在を外し、どのフォルダにも無くなったメッセージを消す。
 * messageIds が null ならフォルダ内の全メッセージが対象。
 * 戻り値は所在を外したメッセージの数。
 */
export async function removePlacements(
  tx: Tx,
  account: SyncAccount,
  mailboxIds: string[],
  messageIds: string[] | null,
): Promise<number> {
  if (mailboxIds.length === 0 || messageIds?.length === 0) return 0;
  const removed = await tx
    .delete(messageMailboxes)
    .where(
      and(
        inArray(messageMailboxes.mailboxId, mailboxIds),
        messageIds
          ? inArray(messageMailboxes.messageId, messageIds)
          : undefined,
      ),
    )
    .returning({ messageId: messageMailboxes.messageId });
  const ids = [...new Set(removed.map((row) => row.messageId))];
  if (ids.length === 0) return 0;
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
  const gone = new Set(deleted.map((row) => row.id));
  await recordChanges(tx, account.userId, "message", "delete", [...gone]);
  // 他のフォルダに残っているメッセージは、所在が変わったことを知らせる。
  await recordChanges(
    tx,
    account.userId,
    "message",
    "upsert",
    ids.filter((id) => !gone.has(id)),
  );
  return ids.length;
}

/**
 * サーバーのフォルダ一覧を DB に反映する (追加、名前や親の変更、削除)。
 * 変わったフォルダだけを変更履歴に載せる。
 *
 * サーバーが知らせてきた役割は detectedSpecialUse に入れ、実際に使う役割 (specialUse) は
 * 利用者がアプリ内で付けた役割 (roleOverride) を当てはめて決める。
 */
export async function applyMailboxList(
  db: Database,
  account: SyncAccount,
  listed: ListedMailbox[],
) {
  const entries = [
    ...new Map(listed.map((entry) => [entry.path, entry])).values(),
  ];
  await db.transaction(async (tx) => {
    const existing = await tx
      .select({
        id: mailboxes.id,
        path: mailboxes.path,
        parentId: mailboxes.parentId,
        name: mailboxes.name,
        delimiter: mailboxes.delimiter,
        specialUse: mailboxes.specialUse,
        detectedSpecialUse: mailboxes.detectedSpecialUse,
        roleOverride: mailboxes.roleOverride,
      })
      .from(mailboxes)
      .where(eq(mailboxes.accountId, account.id))
      // 役割の上書き (API) と同時に走っても、古い内容で役割を決めないようにする。
      .for("update");
    const known = new Map(existing.map((row) => [row.path, row]));
    const ids = new Map<string, string>();
    const changed = new Set<string>();

    for (const entry of entries) {
      const values = {
        name: entry.name,
        delimiter: entry.delimiter,
        detectedSpecialUse: entry.specialUse,
      };
      const row = known.get(entry.path);
      if (
        row &&
        row.name === values.name &&
        row.delimiter === values.delimiter &&
        row.detectedSpecialUse === values.detectedSpecialUse
      ) {
        ids.set(entry.path, row.id);
        continue;
      }
      const [saved] = await tx
        .insert(mailboxes)
        .values({
          accountId: account.id,
          path: entry.path,
          ...values,
          specialUse: entry.specialUse,
        })
        .onConflictDoUpdate({
          target: [mailboxes.accountId, mailboxes.path],
          set: values,
        })
        .returning({ id: mailboxes.id });
      if (!saved) continue;
      ids.set(entry.path, saved.id);
      changed.add(saved.id);
    }

    // 親は、全フォルダの ID が決まってから付ける。
    for (const entry of entries) {
      const id = ids.get(entry.path);
      if (!id) continue;
      const parentId =
        entry.parentPath === null ? null : (ids.get(entry.parentPath) ?? null);
      if ((known.get(entry.path)?.parentId ?? null) === parentId) continue;
      await tx.update(mailboxes).set({ parentId }).where(eq(mailboxes.id, id));
      changed.add(id);
    }

    // 実際に使う役割を、利用者の上書きを当てはめて決め直す。
    const roles = resolveMailboxRoles(
      entries.flatMap((entry) => {
        const id = ids.get(entry.path);
        return id
          ? [
              {
                id,
                detected: entry.specialUse,
                override: known.get(entry.path)?.roleOverride ?? null,
              },
            ]
          : [];
      }),
    );
    for (const entry of entries) {
      const id = ids.get(entry.path);
      if (!id) continue;
      const row = known.get(entry.path);
      const specialUse = roles.get(id) ?? null;
      // 新しいフォルダは、サーバーが知らせてきた役割をそのまま入れてある。
      if ((row ? row.specialUse : entry.specialUse) === specialUse) continue;
      await tx
        .update(mailboxes)
        .set({ specialUse })
        .where(eq(mailboxes.id, id));
      changed.add(id);
    }

    // サーバーから無くなったフォルダを、中のメッセージごと消す。
    const removed = existing
      .filter((row) => !ids.has(row.path))
      .map((row) => row.id);
    if (removed.length > 0) {
      await removePlacements(tx, account, removed, null);
      await tx.delete(mailboxes).where(inArray(mailboxes.id, removed));
    }
    await recordChanges(tx, account.userId, "mailbox", "upsert", [...changed]);
    await recordChanges(tx, account.userId, "mailbox", "delete", removed);
  });
}

/** 移動中として置いた所在を、移動先の同期で結び付かないまま残しておく時間。 */
export const STALE_PENDING_MS = 10 * 60_000;

/**
 * 移動中として先に置いた所在のうち、移動先を同期しても同じメールが見つからないまま
 * 時間が経ったものを外す (メールサーバー側で別の場所へ移されたなど)。
 * まだメールサーバーへ反映していない移動があるアカウントでは何もしない。
 */
export async function dropStalePending(
  db: Database,
  account: SyncAccount,
  mailboxId: string,
  now = Date.now(),
): Promise<number> {
  return db.transaction(async (tx) => {
    const [waiting] = await tx
      .select({ id: outbox.id })
      .from(outbox)
      .where(
        and(
          eq(outbox.accountId, account.id),
          eq(outbox.kind, "move"),
          inArray(outbox.status, ["pending", "processing"]),
        ),
      )
      .limit(1);
    if (waiting) return 0;
    const stale = await tx
      .select({ messageId: messageMailboxes.messageId })
      .from(messageMailboxes)
      .where(
        and(
          eq(messageMailboxes.mailboxId, mailboxId),
          lt(messageMailboxes.pendingSince, new Date(now - STALE_PENDING_MS)),
        ),
      );
    return removePlacements(
      tx,
      account,
      [mailboxId],
      stale.map((row) => row.messageId),
    );
  });
}

/**
 * メールサーバーで移動できなかったとき、移動先に先に置いた所在を外す
 * (移動元は、同期で全件を突き合わせ直して戻る)。
 */
export async function dropPendingPlacements(
  tx: Tx,
  account: SyncAccount,
  mailboxId: string,
  messageIds: string[],
): Promise<number> {
  if (messageIds.length === 0) return 0;
  const pending = await tx
    .select({ messageId: messageMailboxes.messageId })
    .from(messageMailboxes)
    .where(
      and(
        eq(messageMailboxes.mailboxId, mailboxId),
        inArray(messageMailboxes.messageId, messageIds),
        isNotNull(messageMailboxes.pendingSince),
      ),
    );
  return removePlacements(
    tx,
    account,
    [mailboxId],
    pending.map((row) => row.messageId),
  );
}
