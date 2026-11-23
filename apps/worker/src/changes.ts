import { CHANNEL_CHANGES, type ChangeNotification } from "@orbit/core";
import { changes, type Database } from "@orbit/db";
import { sql } from "drizzle-orm";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * 変更履歴を記録し、API サーバーへ NOTIFY で知らせる。
 * NOTIFY はトランザクションのコミット時に届くので、端末が通知を受けて
 * 取りに来た時点でデータは必ず見える。
 */
export async function recordChanges(
  tx: Tx,
  userId: string,
  entity: "account" | "mailbox" | "message",
  op: "upsert" | "delete",
  entityIds: string[],
) {
  if (entityIds.length === 0) return;
  const rows = await tx
    .insert(changes)
    .values(entityIds.map((entityId) => ({ userId, entity, entityId, op })))
    .returning({ seq: changes.seq });
  const seq = rows.reduce((max, row) => (row.seq > max ? row.seq : max), 0n);
  const payload: ChangeNotification = { userId, seq: seq.toString() };
  await tx.execute(
    sql`select pg_notify(${CHANNEL_CHANGES}, ${JSON.stringify(payload)})`,
  );
}
