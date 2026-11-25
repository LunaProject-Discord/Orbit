import { zValidator } from "@hono/zod-validator";
import { CHANNEL_CHANGES, type ChangeNotification } from "@orbit/core";
import {
  type Database,
  mailAccounts,
  mailboxes,
  messages,
  sidebarLayouts,
  unifiedFolders,
} from "@orbit/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, RouteDeps } from "../context.js";
import { accountIcon } from "../lib/account-icon.js";
import { threadCount } from "../lib/threads.js";
import {
  BUILTIN_VIEWS,
  loadUnifiedFolder,
  normalizeCategories,
  normalizeFilters,
  ownScope,
  readFilters,
  sidebarCategories,
  sidebarLayout,
  unifiedFilters,
  unifiedHeads,
  unifiedScope,
  unifiedUnreadCount,
} from "../lib/unified.js";

const idParam = z.object({ id: z.uuid() });

/** 1 人が作れる統合フォルダの数。 */
const MAX_FOLDERS = 100;

const COLOR = /^#[0-9a-f]{6}$/;
const name = z.string().trim().min(1).max(100);
const createBody = z.object({
  name,
  /** アイコンの名前か絵文字。null なら既定のアイコン。 */
  icon: accountIcon.nullable().default(null),
  /** アイコンの色 ("#rrggbb")。null なら色を付けない。 */
  color: z.string().regex(COLOR).nullable().default(null),
  scope: unifiedScope,
  filters: unifiedFilters,
});
const updateBody = z
  .object({
    name: name.optional(),
    icon: accountIcon.nullable().optional(),
    color: z.string().regex(COLOR).nullable().optional(),
    scope: unifiedScope.optional(),
    filters: unifiedFilters.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined));

const builtinParam = z.object({ view: z.enum(BUILTIN_VIEWS) });
/** 初めからある項目の見た目。null にした項目は、初期の設定に戻る。 */
const builtinBody = z.object({
  name: z.string().trim().max(100).nullable(),
  icon: accountIcon.nullable(),
  color: z.string().regex(COLOR).nullable(),
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** 前のページの nextCursor。 */
  cursor: z.string().max(100).optional(),
});

const cursorPattern = /^(\d{4}-[0-9T:.-]+Z)_([0-9a-f-]{36})$/;

const publicColumns = {
  id: unifiedFolders.id,
  name: unifiedFolders.name,
  icon: unifiedFolders.icon,
  color: unifiedFolders.color,
  scope: unifiedFolders.scope,
  filters: unifiedFolders.filters,
  createdAt: unifiedFolders.createdAt,
};

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * 統合フォルダや並び順が変わったことを、利用者のほかの端末へ知らせる。
 * 変更履歴 (メールやフォルダの差分) には載せず、取得し直すきっかけだけを送る。
 */
async function notifyChanged(tx: Tx | Database, userId: string) {
  const payload: ChangeNotification = { userId, seq: "resync" };
  await tx.execute(
    sql`select pg_notify(${CHANNEL_CHANGES}, ${JSON.stringify(payload)})`,
  );
}

/**
 * 統合フォルダ (利用者が作る、複数のフォルダをまとめた一覧) と、
 * サイドバー上部の項目の並び順・表示 / 非表示。どの端末でも同じ内容になる。
 */
export function unifiedRoutes({ db }: Pick<RouteDeps, "db">) {
  const app = new Hono<AppEnv>();

  /** 統合フォルダの一覧 (未読数付き) と、サイドバー上部の並び順。 */
  app.get("/", async (c) => {
    const userId = c.var.user.id;
    const [rows, [layout]] = await Promise.all([
      db
        .select(publicColumns)
        .from(unifiedFolders)
        .where(eq(unifiedFolders.userId, userId))
        .orderBy(asc(unifiedFolders.createdAt), asc(unifiedFolders.id)),
      db
        .select({
          order: sidebarLayouts.order,
          hidden: sidebarLayouts.hidden,
          builtins: sidebarLayouts.builtins,
          categories: sidebarLayouts.categories,
        })
        .from(sidebarLayouts)
        .where(eq(sidebarLayouts.userId, userId)),
    ]);
    const folders = await Promise.all(
      rows.map(async (row) => ({
        ...row,
        filters: readFilters(row.filters),
        unreadCount: await unifiedUnreadCount(db, userId, row),
      })),
    );
    return c.json({
      folders,
      layout: { order: layout?.order ?? [], hidden: layout?.hidden ?? [] },
      builtins: layout?.builtins ?? {},
      categories: layout?.categories ?? [],
    });
  });

  app.post("/", zValidator("json", createBody), async (c) => {
    const body = c.req.valid("json");
    const userId = c.var.user.id;
    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(unifiedFolders)
      .where(eq(unifiedFolders.userId, userId));
    if (count >= MAX_FOLDERS) {
      return c.json({ error: "too_many" }, 409);
    }
    const [folder] = await db
      .insert(unifiedFolders)
      .values({
        userId,
        name: body.name,
        icon: body.icon,
        color: body.color,
        scope: await ownScope(db, userId, body.scope),
        filters: normalizeFilters(body.filters),
      })
      .returning(publicColumns);
    await notifyChanged(db, userId);
    return c.json(
      { folder: folder && { ...folder, filters: readFilters(folder.filters) } },
      201,
    );
  });

  /** サイドバー上部の項目の並び順と、隠す項目を保存する。 */
  app.put("/layout", zValidator("json", sidebarLayout), async (c) => {
    const layout = c.req.valid("json");
    const userId = c.var.user.id;
    await db
      .insert(sidebarLayouts)
      .values({ userId, ...layout })
      .onConflictDoUpdate({ target: sidebarLayouts.userId, set: layout });
    await notifyChanged(db, userId);
    return c.body(null, 204);
  });

  /**
   * サイドバーのカテゴリ (名前、上からの順、中に入れた項目) をまとめて保存する。
   * 無くなったアカウントや統合フォルダの ID が残っていても、画面の側で無視する。
   */
  app.put(
    "/categories",
    zValidator("json", z.object({ categories: sidebarCategories })),
    async (c) => {
      const categories = normalizeCategories(c.req.valid("json").categories);
      const userId = c.var.user.id;
      await db
        .insert(sidebarLayouts)
        .values({ userId, categories })
        .onConflictDoUpdate({
          target: sidebarLayouts.userId,
          set: { categories },
        });
      await notifyChanged(db, userId);
      return c.body(null, 204);
    },
  );

  /**
   * 初めからある項目 (すべての受信トレイ、スター付き、下書き、送信待ち) の
   * 名前・アイコン・色を変える。すべて null なら、初期の設定に戻す。
   */
  app.put(
    "/builtins/:view",
    zValidator("param", builtinParam),
    zValidator("json", builtinBody),
    async (c) => {
      const { view } = c.req.valid("param");
      const body = c.req.valid("json");
      const userId = c.var.user.id;
      const style = { ...body, name: body.name === "" ? null : body.name };
      const builtins = await db.transaction(async (tx) => {
        await tx
          .insert(sidebarLayouts)
          .values({ userId })
          .onConflictDoNothing();
        const [row] = await tx
          .select({ builtins: sidebarLayouts.builtins })
          .from(sidebarLayouts)
          .where(eq(sidebarLayouts.userId, userId))
          .for("update");
        const next = { ...(row?.builtins ?? {}) };
        if (
          style.name === null &&
          style.icon === null &&
          style.color === null
        ) {
          delete next[view];
        } else {
          next[view] = style;
        }
        await tx
          .update(sidebarLayouts)
          .set({ builtins: next })
          .where(eq(sidebarLayouts.userId, userId));
        return next;
      });
      await notifyChanged(db, userId);
      return c.json({ builtins });
    },
  );

  app.patch(
    "/:id",
    zValidator("param", idParam),
    zValidator("json", updateBody),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const userId = c.var.user.id;
      const [folder] = await db
        .update(unifiedFolders)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.icon !== undefined ? { icon: body.icon } : {}),
          ...(body.color !== undefined ? { color: body.color } : {}),
          ...(body.scope
            ? { scope: await ownScope(db, userId, body.scope) }
            : {}),
          ...(body.filters ? { filters: normalizeFilters(body.filters) } : {}),
        })
        .where(
          and(eq(unifiedFolders.id, id), eq(unifiedFolders.userId, userId)),
        )
        .returning(publicColumns);
      if (!folder) {
        return c.json({ error: "not_found" }, 404);
      }
      await notifyChanged(db, userId);
      return c.json({
        folder: { ...folder, filters: readFilters(folder.filters) },
      });
    },
  );

  /** 統合フォルダを削除する。中に並んでいたメールは、元のフォルダにそのまま残る。 */
  app.delete("/:id", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const userId = c.var.user.id;
    const deleted = await db
      .delete(unifiedFolders)
      .where(and(eq(unifiedFolders.id, id), eq(unifiedFolders.userId, userId)))
      .returning({ id: unifiedFolders.id });
    if (deleted.length === 0) {
      return c.json({ error: "not_found" }, 404);
    }
    await notifyChanged(db, userId);
    return c.body(null, 204);
  });

  /**
   * 統合フォルダのメールの一覧。フォルダの一覧 (GET /v1/messages) と同じ形で、
   * 会話ごとに 1 行にまとめ、新しい順に返す。
   */
  app.get(
    "/:id/messages",
    zValidator("param", idParam),
    zValidator("query", listQuery),
    async (c) => {
      const { id } = c.req.valid("param");
      const query = c.req.valid("query");
      const userId = c.var.user.id;
      const folder = await loadUnifiedFolder(db, userId, id);
      if (!folder) {
        return c.json({ error: "not_found" }, 404);
      }
      const conditions = [sql`heads.rn = 1`];
      if (query.cursor) {
        const match = cursorPattern.exec(query.cursor);
        if (!match) {
          return c.json({ error: "invalid_cursor" }, 400);
        }
        conditions.push(
          sql`(${messages.receivedAt}, ${messages.id}) < (${match[1]}::timestamptz, ${match[2]}::uuid)`,
        );
      }
      const rows = await db
        .select({
          id: messages.id,
          accountId: messages.accountId,
          mailboxId: mailboxes.id,
          threadKey: messages.threadKey,
          subject: messages.subject,
          from: messages.from,
          to: messages.to,
          receivedAt: messages.receivedAt,
          snippet: messages.snippet,
          bodyPending: sql<boolean>`${messages.bodyFetchedAt} is null`,
          hasAttachments: sql<boolean>`heads.t_attachments`,
          seen: sql<boolean>`heads.t_seen`,
          flagged: sql<boolean>`heads.t_flagged`,
          answered: messages.answered,
          threadCount,
          threadMessageIds: sql<string[]>`heads.t_ids`,
          // 下書きフォルダにある控えなら、元の下書きの ID (開くと作成画面で続きを書ける)。
          draftId: sql<string | null>`(
            select d.id from drafts d
            where d.account_id = ${messages.accountId}
              and (d.remote_message_id = ${messages.messageIdHeader}
                or d.remote_provider_id = ${messages.providerMessageId})
            limit 1
          )`,
        })
        .from(messages)
        .innerJoin(unifiedHeads(userId, folder), sql`heads.id = ${messages.id}`)
        .innerJoin(mailboxes, sql`${mailboxes.id} = heads.mailbox_id`)
        .innerJoin(mailAccounts, eq(mailAccounts.id, messages.accountId))
        .where(and(...conditions))
        .orderBy(desc(messages.receivedAt), desc(messages.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      const nextCursor =
        rows.length > query.limit && last
          ? `${last.receivedAt.toISOString()}_${last.id}`
          : null;
      return c.json({ messages: page, nextCursor });
    },
  );

  return app;
}
