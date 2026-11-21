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

const eventsQuery = z.object({
  /** 端末 (ブラウザーやアプリ) ごとの ID。接続している端末を数えるのに使う。 */
  device: z.uuid().optional(),
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

  /**
   * 変更があったこと (change) と新着メール (mail) を SSE で知らせる。
   * 変更の内容は GET /v1/sync で取得する。mail には通知に出す内容が入っている。
   */
  app.get("/events", zValidator("query", eventsQuery), (c) => {
    const userId = c.var.user.id;
    const { device } = c.req.valid("query");
    return streamSSE(c, async (stream) => {
      const [row] = await db
        .select({ seq: max(changes.seq) })
        .from(changes)
        .where(eq(changes.userId, userId));
      await stream.writeSSE({
        event: "ready",
        data: JSON.stringify({ seq: (row?.seq ?? 0n).toString() }),
      });

      // 端末の数が変わるたびに devices が届く。最初の値は、ここで直接送る。
      const unsubscribe = hub.subscribe(
        userId,
        (event) => {
          const { type, ...data } = event;
          stream
            .writeSSE({ event: type, data: JSON.stringify(data) })
            .catch(() => {});
        },
        device,
      );
      await stream.writeSSE({
        event: "devices",
        data: JSON.stringify({ count: hub.deviceCount(userId) }),
      });
      await new Promise<void>((resolve) => {
        // プロキシに切られないよう、定期的に空のイベントを送る。
        const ping = setInterval(() => {
          stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
        }, 25_000);
        let done = false;
        const cleanup = () => {
          if (done) return;
          done = true;
          clearInterval(ping);
          unsubscribe();
          resolve();
        };
        stream.onAbort(cleanup);
        // 配信を始める前 (上の問い合わせの途中) に端末が接続を切っていると、切断の知らせは
        // もう届かない。その場合はここで片付けないと、切れた接続が残り続ける。
        const { signal } = c.req.raw;
        signal.addEventListener("abort", cleanup, { once: true });
        if (signal.aborted || stream.aborted) cleanup();
      });
    });
  });

  return app;
}
