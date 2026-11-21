import type { Database } from "@mail/db";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

export type AppOptions = {
  db: Database;
  /** CORS を許可するオリジン (Web、Tauri、Capacitor)。 */
  allowedOrigins: string[];
};

export function createApp({ db, allowedOrigins }: AppOptions) {
  const app = new Hono();

  app.use(logger());
  app.use(cors({ origin: allowedOrigins, credentials: true }));

  app.get("/healthz", async (c) => {
    try {
      await db.execute(sql`select 1`);
      return c.json({ status: "ok" });
    } catch {
      return c.json({ status: "error", reason: "database" }, 503);
    }
  });

  // /v1 以下にメール API を追加していく。
  const v1 = new Hono();
  v1.get("/", (c) => c.json({ name: "mail-api", version: 1 }));
  app.route("/v1", v1);

  return app;
}
