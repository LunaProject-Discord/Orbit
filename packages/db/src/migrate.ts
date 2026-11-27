/**
 * マイグレーションを適用する。
 *
 *   開発:  pnpm db:migrate  (tsx で src/migrate.ts を直接動かす。ルートの .env を読む)
 *   本番:  node packages/db/dist/migrate.js
 *
 * drizzle-kit migrate と同じ SQL と同じ適用履歴の表 (drizzle.__drizzle_migrations) を使う。
 * drizzle-kit migrate は失敗しても原因を表示せずに終わるため、開発でもこちらを使い、
 * 接続先・未適用のマイグレーション・失敗したマイグレーションと SQL・PostgreSQL のエラー内容を表示する。
 * 実行時の依存 (drizzle-orm と pg) だけで動くので、本番のコンテナに drizzle-kit を入れずに済む。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DrizzleQueryError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/** 開発用の既定の接続先 (drizzle.config.ts と同じ)。`--dev` のときだけ使う。 */
const DEV_DEFAULT_URL = "postgres://orbit:orbit@localhost:5432/orbit";

const isDev = process.argv.includes("--dev");
const connectionString =
  process.env.DATABASE_URL ?? (isDev ? DEV_DEFAULT_URL : undefined);
if (!connectionString) {
  console.error("DATABASE_URL が設定されていません。");
  process.exit(1);
}

// src/migrate.ts でも dist/migrate.js でも、1 つ上の drizzle/ が SQL の置き場になる。
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function readJournal(): JournalEntry[] {
  const text = readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8");
  return (JSON.parse(text) as { entries: JournalEntry[] }).entries;
}

/** パスワードを伏せた接続先の表示。 */
function describeTarget(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    return "(DATABASE_URL を URL として読めません)";
  }
}

/** 失敗した SQL 文が、どのマイグレーションのものかを探す。 */
function findMigrationOf(
  query: string,
  journal: JournalEntry[],
): string | null {
  const target = query.trim();
  for (const entry of journal) {
    let text: string;
    try {
      text = readFileSync(`${migrationsFolder}/${entry.tag}.sql`, "utf8");
    } catch {
      continue;
    }
    const statements = text
      .split("--> statement-breakpoint")
      .map((s) => s.trim());
    if (statements.includes(target)) return entry.tag;
  }
  return null;
}

/** よくある接続の失敗に、見直す場所を添える。 */
function hintFor(code: string | undefined): string | null {
  switch (code) {
    case "ECONNREFUSED":
      return "PostgreSQL に接続できません。DB が起動しているか (docker compose ps)、DATABASE_URL のホストとポートを確かめてください。";
    case "ENOTFOUND":
      return "DATABASE_URL のホスト名が見つかりません。";
    case "28P01":
      return "パスワードが違います。.env の DATABASE_URL と POSTGRES_PASSWORD を確かめてください。";
    case "3D000":
      return "データベースがありません。DATABASE_URL のデータベース名を確かめてください。";
    case "42883":
      return "関数がありません。PostgreSQL 18 未満では uuidv7() が無いので、PostgreSQL 18 以降を使ってください。";
    default:
      return null;
  }
}

function printError(error: unknown, journal: JournalEntry[]): void {
  console.error("\nマイグレーションを適用できませんでした。");
  console.error(
    "(まとめて 1 つのトランザクションで流すので、今回の分はどれも適用されていません。)",
  );

  let cause: unknown = error;
  if (error instanceof DrizzleQueryError) {
    const tag = findMigrationOf(error.query, journal);
    console.error(
      `\n失敗したマイグレーション: ${tag ?? "(特定できませんでした)"}`,
    );
    console.error(
      `失敗した SQL:\n  ${error.query.trim().split("\n").join("\n  ")}`,
    );
    cause = error.cause ?? error;
  }

  const e = cause as Partial<pg.DatabaseError> & { code?: string };
  // localhost が ::1 と 127.0.0.1 の両方に解決されると、接続の失敗は
  // メッセージが空の AggregateError になるので、中のエラーを並べる。
  const inner =
    cause instanceof AggregateError
      ? cause.errors.map((x: unknown) =>
          x instanceof Error ? x.message : String(x),
        )
      : [];
  const message = e.message || inner.join(" / ") || String(cause);
  console.error(`\nエラー: ${message}`);
  if (e.code) console.error(`コード: ${e.code}`);
  if (e.detail) console.error(`詳細: ${e.detail}`);
  if (e.hint) console.error(`ヒント: ${e.hint}`);
  if (e.table) console.error(`表: ${e.table}`);
  if (e.constraint) console.error(`制約: ${e.constraint}`);
  const hint = hintFor(e.code);
  if (hint) console.error(`\n${hint}`);
}

const journal = readJournal();
const pool = new pg.Pool({ connectionString, max: 1 });
console.log(`接続先: ${describeTarget(connectionString)}`);
try {
  // 未適用のものを先に表示する (drizzle の migrator と同じ判定: 最後に適用した時刻より新しいもの)。
  const { rows } = await pool
    .query<{ created_at: string | null }>(
      `select max(created_at) as created_at from drizzle.__drizzle_migrations`,
    )
    .catch((error: { code?: string }) => {
      // 一度も流していない DB には履歴の表 (やスキーマ) がまだ無い。
      if (error.code === "42P01" || error.code === "3F000") {
        return { rows: [{ created_at: null }] };
      }
      throw error;
    });
  const last = rows[0]?.created_at == null ? null : Number(rows[0].created_at);
  const pending = journal.filter((e) => last == null || last < e.when);
  const lastTag = journal.find((e) => e.when === last)?.tag;
  console.log(
    `適用済みの最新: ${last == null ? "(なし)" : (lastTag ?? `不明 (created_at=${last})`)}`,
  );
  if (pending.length === 0) {
    console.log("未適用のマイグレーションはありません。");
  } else {
    console.log(`未適用: ${pending.map((e) => e.tag).join(", ")}`);
    await migrate(drizzle({ client: pool }), { migrationsFolder });
    console.log("マイグレーションを適用しました。");
  }
} catch (error) {
  printError(error, journal);
  process.exitCode = 1;
} finally {
  await pool.end();
}
