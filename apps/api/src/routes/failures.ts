import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, RouteDeps } from "../context.js";
import {
  dismissFailedOperation,
  listFailedOperations,
  retryFailedOperation,
} from "../lib/failed-operations.js";

const idParam = z.object({ id: z.uuid() });

/**
 * メールサーバーへ反映できなかった操作 (既読、移動など)。/v1/messages の下に置く。
 * 端末は変更通知 (SSE) を受けるたびに一覧を取り直し、失敗があれば画面に通知を出す。
 */
export function failureRoutes({ db }: Pick<RouteDeps, "db">) {
  const app = new Hono<AppEnv>();

  app.get("/failures", async (c) =>
    c.json({ failures: await listFailedOperations(db, c.var.user.id) }),
  );

  /** もう一度メールサーバーへ反映する。対象のメールがもう無ければ 410。 */
  app.post("/failures/:id/retry", zValidator("param", idParam), async (c) => {
    const result = await retryFailedOperation(
      db,
      c.var.user.id,
      c.req.valid("param").id,
    );
    if (result === "not_found") return c.json({ error: "not_found" }, 404);
    if (result === "gone") return c.json({ error: "gone" }, 410);
    return c.body(null, 202);
  });

  /** やり直さずに、失敗の記録を消す。 */
  app.delete("/failures/:id", zValidator("param", idParam), async (c) => {
    const found = await dismissFailedOperation(
      db,
      c.var.user.id,
      c.req.valid("param").id,
    );
    return found ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  });

  return app;
}
