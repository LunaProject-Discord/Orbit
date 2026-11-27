import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export * from "./calendar-imip.js";
export * from "./calendar-store.js";
export * from "./schema.js";
export { schema };

export type Database = ReturnType<typeof createDb>["db"];

/** 接続プールと Drizzle のクライアントを作る。終了時は pool.end() を呼ぶ。 */
export function createDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  const db = drizzle({ client: pool, schema, casing: "snake_case" });
  return { db, pool };
}
