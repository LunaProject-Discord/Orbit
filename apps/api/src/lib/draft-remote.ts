import { accountLockKey, CHANNEL_OUTBOX, type DeletePayload } from "@mail/core";
import { type Database, type drafts, mailboxes, outbox } from "@mail/db";
import { and, eq, or, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type DraftRow = typeof drafts.$inferSelect;

/**
 * 下書きの控えを置く処理 (同期ワーカー) と順番に実行するための、アカウント単位のロック。
 * 下書きを消す、または別のアカウントへ移すトランザクションの最初に取る。
 */
export async function lockDraftAccount(tx: Tx, accountId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${accountLockKey(accountId)}, 0))`,
  );
}

/** 下書きが変わったことを同期ワーカーへ知らせる (コミット時に届く)。 */
export async function notifyDraftSync(tx: Tx, accountId: string) {
  await tx.execute(sql`select pg_notify(${CHANNEL_OUTBOX}, ${accountId})`);
}

/**
 * メールサーバーの下書きフォルダに置いてある控えを消す操作を積む。
 * 下書きを送信・破棄したとき、差出人のアカウントを変えたときに呼ぶ。
 * 控えを置いていなければ何もしない。
 */
export async function queueDraftCopyRemoval(tx: Tx, row: DraftRow) {
  if (row.remoteProviderId === null && row.remoteUid === null) return;
  const [mailbox] = await tx
    .select({ id: mailboxes.id, path: mailboxes.path })
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.accountId, row.accountId),
        row.remoteMailboxPath === null
          ? eq(mailboxes.specialUse, "drafts")
          : or(
              eq(mailboxes.path, row.remoteMailboxPath),
              eq(mailboxes.specialUse, "drafts"),
            ),
      ),
    )
    .orderBy(
      sql`${mailboxes.path} = ${row.remoteMailboxPath ?? ""} desc`,
      mailboxes.id,
    )
    .limit(1);
  // 下書きフォルダごと無くなっていれば、控えも残っていない。
  if (!mailbox) return;
  if (row.remoteUid !== null && mailbox.path !== row.remoteMailboxPath) return;
  const payload: DeletePayload = {
    targets: [
      {
        messageId: row.id,
        providerMessageId: row.remoteProviderId,
        mailboxId: mailbox.id,
        mailboxPath: mailbox.path,
        uid: row.remoteUid?.toString() ?? null,
        uidValidity: row.remoteUidValidity?.toString() ?? null,
      },
    ],
  };
  await tx
    .insert(outbox)
    .values({
      accountId: row.accountId,
      kind: "delete",
      payload,
      idempotencyKey: `draft-copy:${row.id}:${row.remoteProviderId ?? row.remoteUid}`,
    })
    .onConflictDoNothing();
  await notifyDraftSync(tx, row.accountId);
}
