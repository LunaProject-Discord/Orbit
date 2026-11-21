import { zValidator } from "@hono/zod-validator";
import { changes } from "@mail/db";
import { and, asc, eq, gt, max } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AppEnv, RouteDeps } from "../context.js";
import type { EventsHub } from "../lib/events-hub.js";

const syncQuery = z.object({
  since: z
    .string()
    .regex(/^\d{1,18}$/)
    .default("0"),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export function syncRoutes({
  db,
  hub,
}: Pick<RouteDeps, "db"> & { hub: EventsHub }) {
  const app = new Hono<AppEnv>();

  /** 変更番号 since より後の変更を古い順に返す。 */
  app.get("/sync", zValidator("query", syncQuery), async (c) => {
    const { since, limit } = c.req.valid("query");
    const rows = await db
      .select({
        seq: changes.seq,
        entity: changes.entity,
        entityId: changes.entityId,
        op: changes.op,
      })
      .from(changes)
      .where(
        and(eq(changes.userId, c.var.user.id), gt(changes.seq, BigInt(since))),
      )
      .orderBy(asc(changes.seq))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return c.json({
      changes: page.map((row) => ({ ...row, seq: row.seq.toString() })),
      latestSeq: page.at(-1)?.seq.toString() ?? since,
      hasMore: rows.length > limit,
    });
  });

  /** 変更があったことを SSE で知らせる。内容は GET /v1/sync で取得する。 */
  app.get("/events", (c) => {
    const userId = c.var.user.id;
    return streamSSE(c, async (stream) => {
      const [row] = await db
        .select({ seq: max(changes.seq) })
        .from(changes)
        .where(eq(changes.userId, userId));
      await stream.writeSSE({
        event: "ready",
        data: JSON.stringify({ seq: (row?.seq ?? 0n).toString() }),
      });

      const unsubscribe = hub.subscribe(userId, (seq) => {
        stream
          .writeSSE({ event: "change", data: JSON.stringify({ seq }) })
          .catch(() => {});
      });
      await new Promise<void>((resolve) => {
        // プロキシに切られないよう、定期的に空のイベントを送る。
        const ping = setInterval(() => {
          stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
        }, 25_000);
        stream.onAbort(() => {
          clearInterval(ping);
          unsubscribe();
          resolve();
        });
      });
    });
  });

  return app;
}
