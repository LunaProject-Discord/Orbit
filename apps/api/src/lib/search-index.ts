import type { Database } from "@orbit/db";
import { sql } from "drizzle-orm";

/**
 * 検索の索引 (message_search と、その索引 message_search_grams_idx) が使えるか。
 * 同期ワーカーが取り込み済みのメールの行と索引を作り終えるまでは false で、その間の検索は
 * 索引を使わずに探す (search-sql.ts の termCondition)。一度そろえば、以後はトリガーが
 * メールの追加・変更のたびに行を作るので、false に戻ることはない。
 */
export const searchIndex = { ready: false };

/** 索引が有効で、すべてのメールに検索用の行があるか。 */
export async function checkSearchIndex(db: Database): Promise<boolean> {
  const result = await db.execute<{ ready: boolean }>(sql`
    select exists (
      select 1 from pg_index
      where indexrelid = to_regclass('message_search_grams_idx') and indisvalid
    ) and not exists (
      select 1 from messages m
      where not exists (select 1 from message_search s where s.message_id = m.id)
    ) as ready
  `);
  return result.rows[0]?.ready === true;
}

/**
 * 索引がそろうまで、一定の間隔で確かめる。そろったら searchIndex.ready を true にして止まる。
 * 返す関数で止められる (終了時用)。
 */
export function watchSearchIndex(
  db: Database,
  intervalMs = 30_000,
  log: (message: string) => void = console.log,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const check = async () => {
    try {
      if (await checkSearchIndex(db)) {
        searchIndex.ready = true;
        log("検索の索引を使います。");
        return;
      }
    } catch (error) {
      console.warn("検索の索引を確かめられませんでした。", error);
    }
    if (!stopped) timer = setTimeout(check, intervalMs);
  };
  void check();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
