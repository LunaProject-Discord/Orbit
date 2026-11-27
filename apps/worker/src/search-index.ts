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
const INDEX_MEMORY = "256MB";
/** 別の処理が索引を作っているときに、確かめ直す間隔。 */
const WAIT_MS = 30_000;
/** 索引を作っている間、進み具合をログに出す間隔。 */
const PROGRESS_MS = 60_000;

export type SearchIndexOptions = {
  log?: (message: string) => void;
  /** true になったら途中でやめる (終了時用)。 */
  stopped?: () => boolean;
  batchSize?: number;
  pauseMs?: number;
  waitMs?: number;
  progressMs?: number;
};

export async function buildSearchIndex(
  pool: pg.Pool,
  options: SearchIndexOptions = {},
): Promise<void> {
  const log = options.log ?? console.log;
  const stopped = options.stopped ?? (() => false);
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const pauseMs = options.pauseMs ?? BATCH_PAUSE_MS;
  const waitMs = options.waitMs ?? WAIT_MS;
  const progressMs = options.progressMs ?? PROGRESS_MS;

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

  // 別の接続 (更新の前に動いていたワーカーなど) が索引を作っている途中なら、終わるのを待つ。
  // ワーカーを止めても、DB では作る処理が続く。作りかけ (使えない状態) に見えるからといって
  // 消すと、それが終わるのを待ってから消すことになり、最初から作り直しになる。
  let waiting = false;
  let state = await readIndexState(pool);
  while (!state.valid && state.building) {
    if (stopped()) return;
    if (!waiting) {
      log("検索の索引を、別の処理が作っている途中です。終わるのを待ちます。");
      waiting = true;
    }
    await sleep(waitMs);
    state = await readIndexState(pool);
  }
  if (state.valid) {
    if (waiting) log("検索の索引ができました。");
    return;
  }
  if (stopped()) return;

  const client = await pool.connect();
  const progress = setInterval(() => {
    void logProgress(pool, log);
  }, progressMs);
  try {
    if (state.exists) {
      // 前回、作っている途中で止まった索引 (使えない状態で残る) を外してから作り直す。
      await client.query(
        "drop index concurrently if exists message_search_grams_idx",
      );
    }
    log("検索の索引を作っています (メールが多いと数分〜数十分かかります)。");
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
    clearInterval(progress);
    client.release();
  }
}

type IndexState = {
  /** 索引があるか (作りかけを含む)。 */
  exists: boolean;
  /** 使える状態か。 */
  valid: boolean;
  /** いま、どこかの接続が message_search の索引を作っているか。 */
  building: boolean;
};

async function readIndexState(pool: pg.Pool): Promise<IndexState> {
  const result = await pool.query<{
    valid: boolean | null;
    building: boolean;
  }>(
    `select
       (select indisvalid from pg_index
        where indexrelid = to_regclass('message_search_grams_idx')) as valid,
       exists (
         select 1 from pg_stat_progress_create_index
         where relid = to_regclass('message_search')
       ) as building`,
  );
  const row = result.rows[0];
  return {
    exists: row?.valid !== null && row?.valid !== undefined,
    valid: row?.valid === true,
    building: row?.building === true,
  };
}

/** 索引を作る進み具合をログに出す (時間がかかるので、止まっていないことが分かるように)。 */
async function logProgress(
  pool: pg.Pool,
  log: (message: string) => void,
): Promise<void> {
  try {
    const result = await pool.query<{
      phase: string;
      done: string;
      total: string;
    }>(
      `select phase, blocks_done::text as done, blocks_total::text as total
       from pg_stat_progress_create_index
       where relid = to_regclass('message_search')`,
    );
    const row = result.rows[0];
    if (!row) return;
    const total = Number(row.total);
    const percent =
      total > 0 ? ` ${Math.floor((Number(row.done) / total) * 100)}%` : "";
    log(`検索の索引を作っています: ${row.phase}${percent}`);
  } catch {
    // 進み具合が読めなくても、作る処理には関係ない。
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
