import { CHANNEL_CHANGES, type ChangeNotification } from "@orbit/core";
import { changes, type Database } from "@orbit/db";
import { sql } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** 変更履歴に載せ、接続中の端末へ知らせる (同期ワーカーの recordChanges と同じ)。 */
export async function recordChanges(
  tx: Tx,
  userId: string,
  entity: "account" | "mailbox",
  entityIds: string[],
) {
  if (entityIds.length === 0) return;
  const rows = await tx
    .insert(changes)
    .values(
      entityIds.map((entityId) => ({
        userId,
        entity,
        entityId,
        op: "upsert" as const,
      })),
    )
    .returning({ seq: changes.seq });
  const seq = rows.reduce((max, row) => (row.seq > max ? row.seq : max), 0n);
  const payload: ChangeNotification = { userId, seq: seq.toString() };
  await tx.execute(
    sql`select pg_notify(${CHANNEL_CHANGES}, ${JSON.stringify(payload)})`,
  );
}

/**
 * アカウントに属するもの (送信待ちのメール、下書き) が変わったことを、
 * 利用者の端末へ知らせる。NOTIFY はコミット時に届く。
 */
export async function notifyAccountChanged(
  tx: Tx,
  userId: string,
  accountId: string,
) {
  await recordChanges(tx, userId, "account", [accountId]);
}

/** 並び替えの依頼。ids は上から順に並べたい ID (重複は不可)。 */
export function isDistinct(ids: string[]): boolean {
  return new Set(ids).size === ids.length;
}
