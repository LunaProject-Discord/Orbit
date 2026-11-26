import type pg from "pg";

/**
 * メールの検索用の行 (message_search) と、その索引 message_search_grams_idx を裏で作る。
 *
 * マイグレーション 0037 は、取り込み済みのメールの行も索引も作らない (メールが多いと時間がかかり、
 * その間マイグレーションが終わらないため)。新しく届いたメールや書き換えたメールの行はトリガーが作るので、
 * ここでは行の無いメールの分を少しずつ作り、そろったら CREATE INDEX CONCURRENTLY で索引を作る
 * (表を止めずに作れる)。API は、両方がそろうまで索引を使わずに探す。
 *
 * 何度動かしてもよい (そろっていれば、確かめるだけで終わる)。途中で止まっても、次に動かしたときに続きから作る。
 */

/** 一度に作る行の数。 */
const BATCH_SIZE = 1000;
/** 行を作る合間に待つ時間 (同期など、ほかの書き込みを待たせないため)。 */
const BATCH_PAUSE_MS = 50;
/** 索引を作るときに使うメモリ。 */
const INDEX_MEMORY = "128MB";

export type SearchIndexOptions = {
  log?: (message: string) => void;
  /** true になったら途中でやめる (終了時用)。 */
  stopped?: () => boolean;
  batchSize?: number;
  pauseMs?: number;
};

export async function buildSearchIndex(
  pool: pg.Pool,
  options: SearchIndexOptions = {},
): Promise<void> {
  const log = options.log ?? console.log;
  const stopped = options.stopped ?? (() => false);
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const pauseMs = options.pauseMs ?? BATCH_PAUSE_MS;

  let created = 0;
  for (;;) {
    if (stopped()) return;
    const result = await pool.query(
      `insert into message_search (message_id, doc)
       select m.id, mail_search_document(m.subject, m."from", m."to" || m.cc || m.bcc, m.body_text, m.body_html, m.snippet)
       from messages m
       where not exists (select 1 from message_search s where s.message_id = m.id)
       limit $1
       on conflict (message_id) do nothing`,
      [batchSize],
    );
    const count = result.rowCount ?? 0;
    if (count === 0) break;
    if (created === 0) log("検索用の文字列を作っています。");
    created += count;
    if (created % (batchSize * 10) < count) {
      log(`検索用の文字列を ${created} 通分作りました。`);
    }
    if (pauseMs > 0)
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  if (created > 0) log(`検索用の文字列を ${created} 通分作りました。`);

  const state = await pool.query<{ valid: boolean }>(
    `select indisvalid as valid from pg_index
     where indexrelid = to_regclass('message_search_grams_idx')`,
  );
  if (state.rows[0]?.valid === true) return;
  if (stopped()) return;

  const client = await pool.connect();
  try {
    if (state.rows[0]) {
      // 前回、作っている途中で止まった索引 (使えない状態で残る) を外してから作り直す。
      await client.query(
        "drop index concurrently if exists message_search_grams_idx",
      );
    }
    log("検索の索引を作っています (メールが多いと数分かかります)。");
    const started = Date.now();
    await client.query(`set maintenance_work_mem = '${INDEX_MEMORY}'`);
    await client.query(
      "create index concurrently if not exists message_search_grams_idx on message_search using gin (mail_search_grams(doc))",
    );
    await client.query("reset maintenance_work_mem");
    await client.query("analyze message_search");
    log(
      `検索の索引を作りました (${Math.round((Date.now() - started) / 1000)} 秒)。`,
    );
  } finally {
    client.release();
  }
}
