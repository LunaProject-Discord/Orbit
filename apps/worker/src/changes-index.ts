import type pg from "pg";

/**
 * 変更履歴 (changes) の索引 changes_delete_entity_idx (op = 'delete' の部分索引) を裏で作る。
 *
 * changes は全利用者のメールの同期も書き込む大きな表なので、マイグレーション 0046 では作らず、
 * ここで CREATE INDEX CONCURRENTLY で作る (書き込みを止めない。search-index.ts と同じ方式)。
 * 索引が無い間も、予定の POST の再送の確かめ (wasDeleted) は正しく動く (遅いだけ)。
 *
 * 何度動かしてもよい (あれば確かめるだけ)。途中で止まった (使えない) 索引は作り直す。
 */

const INDEX_NAME = "changes_delete_entity_idx";
const INDEX_MEMORY = "128MB";

export type ChangesIndexOptions = {
  log?: (message: string) => void;
  /** true になったら途中でやめる (終了時用)。 */
  stopped?: () => boolean;
};

export async function buildChangesIndex(
  pool: pg.Pool,
  options: ChangesIndexOptions = {},
): Promise<void> {
  const log = options.log ?? console.log;
  const stopped = options.stopped ?? (() => false);
  if (stopped()) return;

  const state = await pool.query<{ valid: boolean }>(
    "select indisvalid as valid from pg_index where indexrelid = to_regclass($1)",
    [INDEX_NAME],
  );
  if (state.rows[0]?.valid === true) return;

  const client = await pool.connect();
  try {
    if (state.rows[0]) {
      await client.query(`drop index concurrently if exists ${INDEX_NAME}`);
    }
    log("変更履歴の索引を作っています。");
    const started = Date.now();
    await client.query(`set maintenance_work_mem = '${INDEX_MEMORY}'`);
    await client.query(
      `create index concurrently if not exists ${INDEX_NAME} on changes (entity_id) where op = 'delete'`,
    );
    await client.query("reset maintenance_work_mem");
    log(
      `変更履歴の索引を作りました (${Math.round((Date.now() - started) / 1000)} 秒)。`,
    );
  } finally {
    client.release();
  }
}
