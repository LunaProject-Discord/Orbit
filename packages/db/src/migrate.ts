/**
 * マイグレーションを適用する (本番用)。
 *
 *   node packages/db/dist/migrate.js
 *
 * 開発時の `pnpm db:migrate` (drizzle-kit) と同じ SQL と同じ適用履歴の表を使うが、
 * 実行時の依存 (drizzle-orm と pg) だけで動くので、本番のコンテナに drizzle-kit を入れずに済む。
 */
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL が設定されていません。");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString, max: 1 });
try {
  await migrate(drizzle({ client: pool }), {
    // ビルド後は dist/migrate.js なので、1 つ上の drizzle/ が SQL の置き場になる。
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  console.log("マイグレーションを適用しました。");
} catch (error) {
  console.error("マイグレーションを適用できませんでした。", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
