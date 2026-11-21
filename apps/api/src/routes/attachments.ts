import { zValidator } from "@hono/zod-validator";
import {
  attachmentsDir,
  copyToOutgoingAttachment,
  deleteAttachment,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENTS_BYTES,
  type StoredAttachment,
  writeAttachment,
} from "@mail/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, RouteDeps } from "../context.js";
import type { EventsHub } from "../lib/events-hub.js";
import {
  ensureReceivedAttachment,
  statusOfFetchError,
} from "../lib/received-attachments.js";

const idParam = z.object({ id: z.uuid() });

const forwardBody = z.object({
  /** 転送する元のメッセージ。 */
  messageId: z.uuid(),
  /** そのメッセージの添付ファイル (attachments.id)。 */
  attachmentIds: z.array(z.uuid()).min(1).max(MAX_ATTACHMENT_COUNT),
});

/**
 * 送信するメールに付けるファイルの受け取り。
 * 作成画面でファイルを選んだ時点で受け取り、送信のときは ID だけを指定する。
 * 受け取ったファイルを返す API は無い (置いた本人が送信に使うだけ)。
 */
export function attachmentRoutes({
  db,
  hub,
}: Pick<RouteDeps, "db"> & { hub: EventsHub }) {
  const app = new Hono<AppEnv>();
  const dir = attachmentsDir();

  /**
   * 本文がそのままファイルの内容。ファイル名は X-Filename ヘッダー
   * (encodeURIComponent したもの)、種類は Content-Type で受け取る。
   */
  app.post("/", async (c) => {
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > MAX_ATTACHMENTS_BYTES) {
      return c.json(
        { error: "attachment_too_large", limit: MAX_ATTACHMENTS_BYTES },
        413,
      );
    }
    let filename = "";
    try {
      filename = decodeURIComponent(c.req.header("x-filename") ?? "");
    } catch {
      return c.json({ error: "invalid_filename" }, 400);
    }
    const body = c.req.raw.body;
    if (!body) {
      return c.json({ error: "empty_body" }, 400);
    }
    const stored = await writeAttachment(
      dir,
      c.var.user.id,
      { filename, contentType: c.req.header("content-type") ?? "" },
      body,
      MAX_ATTACHMENTS_BYTES,
    );
    if (stored === "too_large") {
      return c.json(
        { error: "attachment_too_large", limit: MAX_ATTACHMENTS_BYTES },
        413,
      );
    }
    return c.json({ attachment: stored }, 201);
  });

  /**
   * 受信したメールの添付ファイルを、送信用の添付ファイルとして複製する (転送用)。
   * 置き場に無いものは、同期ワーカーがメールサーバーから取得し終えるのを待つ。
   * 1 件でも用意できなければ、複製した分を消して失敗を返す。
   */
  app.post("/forward", zValidator("json", forwardBody), async (c) => {
    const { messageId, attachmentIds } = c.req.valid("json");
    const userId = c.var.user.id;
    const copied: StoredAttachment[] = [];
    const fail = async () => {
      for (const file of copied) await deleteAttachment(dir, userId, file.id);
    };
    for (const attachmentId of new Set(attachmentIds)) {
      const result = await ensureReceivedAttachment(
        { db, hub, dir },
        userId,
        messageId,
        attachmentId,
      );
      if (!result.ok) {
        await fail();
        return c.json(
          { error: result.error, id: attachmentId },
          statusOfFetchError(result.error),
        );
      }
      const stored = await copyToOutgoingAttachment(
        dir,
        userId,
        attachmentId,
        {
          filename: result.attachment.filename ?? "",
          contentType: result.attachment.contentType,
        },
        MAX_ATTACHMENTS_BYTES,
      );
      if (stored === null || stored === "too_large") {
        await fail();
        return stored === null
          ? c.json({ error: "fetch_failed", id: attachmentId }, 502)
          : c.json(
              {
                error: "attachment_too_large",
                id: attachmentId,
                limit: MAX_ATTACHMENTS_BYTES,
              },
              413,
            );
      }
      copied.push(stored);
    }
    return c.json({ attachments: copied }, 201);
  });

  /** 作成画面で添付を外したとき。他人のものや存在しないものでも、同じ応答を返す。 */
  app.delete("/:id", zValidator("param", idParam), async (c) => {
    await deleteAttachment(dir, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  });

  return app;
}
