import { zValidator } from "@hono/zod-validator";
import {
  attachmentsDir,
  deleteAttachment,
  MAX_ATTACHMENT_COUNT,
  readAttachmentMeta,
} from "@orbit/core";
import { accounts, type DraftAttachment, drafts, outbox } from "@orbit/db";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, RouteDeps } from "../context.js";
import { notifyAccountChanged } from "../lib/changes.js";
import {
  lockDraftAccount,
  notifyDraftSync,
  queueDraftCopyRemoval,
} from "../lib/draft-remote.js";
import { decideDraftSave } from "../lib/draft-save.js";

/** 1 通あたりの宛先の上限 (To / Cc / Bcc の合計)。送信と同じ値。 */
const MAX_RECIPIENTS = 100;

// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を弾くための正規表現
const noControl = /^[^\u0000-\u001f\u007f]*$/;

// 書きかけなので、宛先の形は送信するときに確かめる。ここでは長さと制御文字だけを見る。
const address = z.object({
  name: z.string().trim().max(200).regex(noControl).optional(),
  address: z.string().trim().min(1).max(320).regex(noControl),
});

/** 宛先の欄。入力途中の文字列 (text) は、解釈せずにそのまま預かる。 */
const recipients = z.object({
  list: z.array(address).max(MAX_RECIPIENTS).default([]),
  text: z.string().max(2000).default(""),
});

const saveBody = z.object({
  accountId: z.uuid(),
  to: recipients,
  cc: recipients,
  bcc: recipients,
  subject: z.string().max(998).regex(noControl).default(""),
  html: z.string().max(2_000_000).default(""),
  text: z.string().max(1_000_000).default(""),
  /** POST /v1/attachments で受け取ったファイルの ID。 */
  attachmentIds: z.array(z.uuid()).max(MAX_ATTACHMENT_COUNT).default([]),
  mode: z.enum(["new", "reply", "forward"]).default("new"),
  /** 書いている形式。text なら text が本文で、html はそれを HTML にしたもの。 */
  format: z.enum(["html", "text"]).default("html"),
  sourceMessageId: z.uuid().nullable().default(null),
  /** 端末が元にした revision。まだサーバーに保存していなければ null。 */
  baseRevision: z.number().int().positive().nullable(),
});

const idParam = z.object({ id: z.uuid() });

type DraftRow = typeof drafts.$inferSelect;

/** 端末へ返す形。メールサーバーとの同期の状態は返さない。 */
function toJson(row: DraftRow) {
  return {
    id: row.id,
    accountId: row.accountId,
    to: row.to,
    cc: row.cc,
    bcc: row.bcc,
    subject: row.subject,
    html: row.html,
    snippet: row.text.replace(/\s+/g, " ").trim().slice(0, 200),
    attachments: row.attachments,
    mode: row.mode,
    format: row.format,
    // テキストで書いている下書きは、書いたままのテキストを返す (HTML から戻すと形が崩れるため)。
    ...(row.format === "text" ? { text: row.text } : {}),
    sourceMessageId: row.sourceMessageId,
    revision: row.revision,
    updatedAt: row.updatedAt,
  };
}

/**
 * 書きかけのメール (下書き)。サーバーに置き、どの端末からも続きを書けるようにする。
 * 送信すると POST /v1/messages/send が同じ ID の下書きを消す。
 */
export function draftRoutes({ db }: Pick<RouteDeps, "db">) {
  const app = new Hono<AppEnv>();
  const dir = attachmentsDir();

  app.get("/", async (c) => {
    const rows = await db
      .select()
      .from(drafts)
      .where(eq(drafts.userId, c.var.user.id))
      .orderBy(desc(drafts.updatedAt), desc(drafts.id));
    return c.json({ drafts: rows.map(toJson) });
  });

  /** 下書きを保存する (無ければ作る)。ID は端末が決める。 */
  app.put(
    "/:id",
    zValidator("param", idParam),
    zValidator("json", saveBody),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const user = c.var.user;

      const [account] = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(eq(accounts.id, body.accountId), eq(accounts.userId, user.id)),
        );
      if (!account) {
        return c.json({ error: "account_not_found" }, 404);
      }

      // 添付ファイルは、本人が受け取り済みのものだけを使える。
      const attachments: DraftAttachment[] = [];
      for (const attachmentId of new Set(body.attachmentIds)) {
        const meta = await readAttachmentMeta(dir, user.id, attachmentId);
        if (!meta) {
          return c.json(
            { error: "attachment_not_found", id: attachmentId },
            400,
          );
        }
        attachments.push(meta);
      }

      const values = {
        accountId: account.id,
        to: body.to,
        cc: body.cc,
        bcc: body.bcc,
        subject: body.subject,
        html: body.html,
        text: body.text,
        attachments,
        mode: body.mode,
        format: body.format,
        sourceMessageId: body.sourceMessageId,
      };

      const result = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(drafts)
          .where(eq(drafts.id, id))
          .for("update");
        let alreadySent = false;
        if (!existing) {
          const [sent] = await tx
            .select({ id: outbox.id })
            .from(outbox)
            .innerJoin(accounts, eq(accounts.id, outbox.accountId))
            .where(
              and(
                eq(accounts.userId, user.id),
                eq(outbox.kind, "send"),
                eq(outbox.idempotencyKey, id),
              ),
            )
            .limit(1);
          alreadySent = Boolean(sent);
        }
        const decision = decideDraftSave({
          userId: user.id,
          baseRevision: body.baseRevision,
          existing: existing ?? null,
          alreadySent,
        });
        if (decision.action === "conflict") {
          return { ...decision, draft: existing ?? null };
        }
        if (decision.action === "create") {
          const [created] = await tx
            .insert(drafts)
            .values({ id, userId: user.id, ...values })
            // 同時に同じ ID で作られた場合は、後から来たほうを競合として返す。
            .onConflictDoNothing()
            .returning();
          if (!created) return { action: "conflict" as const, draft: null };
          await notifyAccountChanged(tx, user.id, account.id);
          await notifyDraftSync(tx, account.id);
          return { action: "saved" as const, draft: created, status: 201 };
        }
        if (decision.action === "update") {
          // 差出人のアカウントを変えたら、前のアカウントのメールサーバーに置いた控えは消し、
          // 新しいアカウントのほうへ置き直す。
          const moved = existing && existing.accountId !== account.id;
          if (moved) {
            await lockDraftAccount(tx, existing.accountId);
            const [current] = await tx
              .select()
              .from(drafts)
              .where(eq(drafts.id, id));
            if (current) await queueDraftCopyRemoval(tx, current);
          }
          const [updated] = await tx
            .update(drafts)
            .set({
              ...values,
              revision: decision.revision,
              ...(moved
                ? {
                    syncedRevision: null,
                    remoteMessageId: null,
                    remoteMailboxPath: null,
                    remoteUid: null,
                    remoteUidValidity: null,
                    remoteProviderId: null,
                  }
                : {}),
            })
            .where(eq(drafts.id, id))
            .returning();
          if (!updated) return { action: "gone" as const };
          await notifyAccountChanged(tx, user.id, account.id);
          await notifyDraftSync(tx, account.id);
          return { action: "saved" as const, draft: updated, status: 200 };
        }
        return decision;
      });

      switch (result.action) {
        case "saved":
          return c.json(
            { draft: toJson(result.draft) },
            result.status === 201 ? 201 : 200,
          );
        case "conflict":
          return c.json(
            {
              error: "conflict",
              draft: result.draft ? toJson(result.draft) : null,
            },
            409,
          );
        case "gone":
          return c.json({ error: "gone" }, 410);
        default:
          return c.json({ error: "not_found" }, 404);
      }
    },
  );

  /**
   * 下書きを破棄する。付けていたファイルも消す。
   * 他人のものや存在しないものでも、同じ応答を返す。
   */
  app.delete("/:id", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const user = c.var.user;
    const deleted = await db.transaction(async (tx) => {
      const [found] = await tx
        .select({ accountId: drafts.accountId })
        .from(drafts)
        .where(and(eq(drafts.id, id), eq(drafts.userId, user.id)));
      if (!found) return null;
      // 同期ワーカーが控えを置いている途中なら、終わるのを待つ。
      await lockDraftAccount(tx, found.accountId);
      const [row] = await tx
        .delete(drafts)
        .where(and(eq(drafts.id, id), eq(drafts.userId, user.id)))
        .returning();
      if (!row) return null;
      await queueDraftCopyRemoval(tx, row);
      await notifyAccountChanged(tx, user.id, row.accountId);
      return row;
    });
    for (const file of deleted?.attachments ?? []) {
      await deleteAttachment(dir, user.id, file.id).catch(() => {});
    }
    return c.body(null, 204);
  });

  return app;
}
