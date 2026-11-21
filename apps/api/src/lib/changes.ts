import { CHANNEL_CHANGES, type ChangeNotification } from "@mail/core";
import { changes, type Database } from "@mail/db";
import { sql } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * アカウントに属するもの (送信待ちのメール、下書き) が変わったことを、
 * 利用者の端末へ知らせる。NOTIFY はコミット時に届く。
 */
export async function notifyAccountChanged(
  tx: Tx,
  userId: string,
  accountId: string,
) {
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
