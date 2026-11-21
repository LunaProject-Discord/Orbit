import { zValidator } from "@hono/zod-validator";
import {
  attachmentsDir,
  deleteAttachment,
  MAX_ATTACHMENTS_BYTES,
  writeAttachment,
} from "@mail/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";

const idParam = z.object({ id: z.uuid() });

/**
 * 送信するメールに付けるファイルの受け取り。
 * 作成画面でファイルを選んだ時点で受け取り、送信のときは ID だけを指定する。
 * 受け取ったファイルを返す API は無い (置いた本人が送信に使うだけ)。
 */
export function attachmentRoutes() {
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

  /** 作成画面で添付を外したとき。他人のものや存在しないものでも、同じ応答を返す。 */
  app.delete("/:id", zValidator("param", idParam), async (c) => {
    await deleteAttachment(dir, c.var.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  });

  return app;
}
