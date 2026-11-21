import { CHANNEL_CHANGES, type ChangeNotification } from "@mail/core";
import { changes, type Database } from "@mail/db";
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

/** 並び替えの依頼。ids は上から順に並べたい ID (重複は不可)。 */
export function isDistinct(ids: string[]): boolean {
  return new Set(ids).size === ids.length;
}
