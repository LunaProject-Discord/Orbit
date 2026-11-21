import { type Database, mailboxes, messageMailboxes, messages } from "@mail/db";
import { and, eq, inArray, notInArray } from "drizzle-orm";
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
      })
      .from(mailboxes)
      .where(eq(mailboxes.accountId, account.id));
    const known = new Map(existing.map((row) => [row.path, row]));
    const ids = new Map<string, string>();
    const changed = new Set<string>();

    for (const entry of entries) {
      const values = {
        name: entry.name,
        delimiter: entry.delimiter,
        specialUse: entry.specialUse,
      };
      const row = known.get(entry.path);
      if (
        row &&
        row.name === values.name &&
        row.delimiter === values.delimiter &&
        row.specialUse === values.specialUse
      ) {
        ids.set(entry.path, row.id);
        continue;
      }
      const [saved] = await tx
        .insert(mailboxes)
        .values({ accountId: account.id, path: entry.path, ...values })
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
