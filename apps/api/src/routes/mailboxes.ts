import { zValidator } from "@hono/zod-validator";
import {
  CHANNEL_OUTBOX,
  MAILBOX_ROLE_OVERRIDES,
  type MailboxCreatePayload,
  type MailboxDeletePayload,
  type MailboxRenamePayload,
  mailboxNameError,
  resolveMailboxRoles,
} from "@orbit/core";
import {
  mailAccounts,
  mailboxes,
  messageMailboxes,
  messages,
  outbox,
} from "@orbit/db";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, RouteDeps } from "../context.js";
import { accountIcon } from "../lib/account-icon.js";
import { isDistinct, recordChanges } from "../lib/changes.js";
import { enqueueMessageAction } from "../lib/message-actions.js";

const idParam = z.object({ id: z.uuid() });

const createBody = z.object({
  accountId: z.uuid(),
  /** 親フォルダ。最上位に作るなら null。 */
  parentId: z.uuid().nullable(),
  name: z.string().max(400),
});
const renameBody = z.object({ name: z.string().max(400) });
/**
 * アプリ内での役割・表示名・アイコン・色の上書き。null にした項目は、上書きを外す
 * (役割はメールサーバーが知らせてきたものに、名前とアイコンは標準に戻る)。
 */
const overridesBody = z.object({
  role: z.enum(MAILBOX_ROLE_OVERRIDES).nullable(),
  displayName: z.string().trim().max(100).nullable(),
  icon: accountIcon.nullable(),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/)
    .nullable(),
});
/** 「すべて既読にする」で、1 回の操作にまとめるメッセージの数。 */
const MARK_READ_BATCH = 500;

const orderBody = z.object({
  /** 上から順に並べたいフォルダの ID (同じ親を持つフォルダをすべて)。 */
  mailboxIds: z.array(z.uuid()).min(1).max(1000).refine(isDistinct),
});

export function mailboxRoutes({ db }: Pick<RouteDeps, "db">) {
  const app = new Hono<AppEnv>();

  /**
   * 全アカウントのフォルダを、未読数と件数を付けて返す。
   * 親子関係は parentId で表す (最上位は null)。ツリーへの組み立ては端末側で行う。
   */
  app.get("/", async (c) => {
    const rows = await db
      .select({
        id: mailboxes.id,
        accountId: mailboxes.accountId,
        parentId: mailboxes.parentId,
        path: mailboxes.path,
        name: mailboxes.name,
        specialUse: mailboxes.specialUse,
        detectedSpecialUse: mailboxes.detectedSpecialUse,
        roleOverride: mailboxes.roleOverride,
        displayName: mailboxes.displayName,
        icon: mailboxes.icon,
        color: mailboxes.color,
        sortOrder: mailboxes.sortOrder,
        lastSyncedAt: mailboxes.lastSyncedAt,
        totalCount: sql<number>`count(${messageMailboxes.messageId})::int`,
        unreadCount: sql<number>`(count(*) filter (where ${messages.seen} = false))::int`,
      })
      .from(mailboxes)
      .innerJoin(mailAccounts, eq(mailAccounts.id, mailboxes.accountId))
      .leftJoin(messageMailboxes, eq(messageMailboxes.mailboxId, mailboxes.id))
      .leftJoin(messages, eq(messages.id, messageMailboxes.messageId))
      .where(eq(mailAccounts.userId, c.var.user.id))
      .groupBy(mailboxes.id)
      .orderBy(asc(mailboxes.accountId), asc(mailboxes.name));
    return c.json({ mailboxes: rows });
  });

  /**
   * サイドバーでのフォルダの並び順を保存する。ほかの端末にも同じ順で表示される。
   * 表示順だけを変え、メールサーバー側のフォルダ (名前や親子関係) は変えない。
   */
  app.put("/order", zValidator("json", orderBody), async (c) => {
    const { mailboxIds } = c.req.valid("json");
    const user = c.var.user;
    const saved = await db.transaction(async (tx) => {
      const owned = await tx
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .innerJoin(mailAccounts, eq(mailAccounts.id, mailboxes.accountId))
        .where(
          and(
            eq(mailAccounts.userId, user.id),
            inArray(mailboxes.id, mailboxIds),
          ),
        );
      if (owned.length !== mailboxIds.length) return false;
      for (const [index, id] of mailboxIds.entries()) {
        await tx
          .update(mailboxes)
          .set({ sortOrder: index })
          .where(eq(mailboxes.id, id));
      }
      await recordChanges(tx, user.id, "mailbox", mailboxIds);
      return true;
    });
    if (!saved) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.body(null, 204);
  });

  /** 本人のフォルダ 1 件を、アカウントの接続方式と一緒に取り出す。 */
  const loadMailbox = async (userId: string, id: string) => {
    const [row] = await db
      .select({
        id: mailboxes.id,
        accountId: mailboxes.accountId,
        parentId: mailboxes.parentId,
        path: mailboxes.path,
        name: mailboxes.name,
        delimiter: mailboxes.delimiter,
        specialUse: mailboxes.specialUse,
        detectedSpecialUse: mailboxes.detectedSpecialUse,
        protocol: mailAccounts.protocol,
      })
      .from(mailboxes)
      .innerJoin(mailAccounts, eq(mailAccounts.id, mailboxes.accountId))
      .where(and(eq(mailboxes.id, id), eq(mailAccounts.userId, userId)));
    return row ?? null;
  };

  /** フォルダへの操作を送信待ちキューに積み、同期ワーカーへ知らせる。 */
  const enqueue = async (
    accountId: string,
    kind: "mailbox_create" | "mailbox_rename" | "mailbox_delete",
    payload: MailboxCreatePayload | MailboxRenamePayload | MailboxDeletePayload,
  ) => {
    await db.transaction(async (tx) => {
      await tx.insert(outbox).values({
        accountId,
        kind,
        payload,
        idempotencyKey: crypto.randomUUID(),
      });
      await tx.execute(sql`select pg_notify(${CHANNEL_OUTBOX}, ${accountId})`);
    });
  };

  /**
   * フォルダを作る。メールサーバーに作ってから、フォルダ一覧の同期で DB に取り込むので、
   * 画面に出るまで少し間がある (失敗は GET /v1/messages/failures で分かる)。
   */
  app.post("/", zValidator("json", createBody), async (c) => {
    const body = c.req.valid("json");
    const user = c.var.user;
    const [account] = await db
      .select({ id: mailAccounts.id, protocol: mailAccounts.protocol })
      .from(mailAccounts)
      .where(
        and(
          eq(mailAccounts.id, body.accountId),
          eq(mailAccounts.userId, user.id),
        ),
      );
    if (!account) {
      return c.json({ error: "not_found" }, 404);
    }
    const siblings = await db
      .select({
        id: mailboxes.id,
        parentId: mailboxes.parentId,
        path: mailboxes.path,
        name: mailboxes.name,
        delimiter: mailboxes.delimiter,
      })
      .from(mailboxes)
      .where(eq(mailboxes.accountId, account.id));
    const parent = body.parentId
      ? siblings.find((mailbox) => mailbox.id === body.parentId)
      : null;
    if (body.parentId && !parent) {
      return c.json({ error: "not_found" }, 404);
    }
    const imap = account.protocol === "imap";
    // 最上位に作るときは、アカウントのほかのフォルダと同じ区切り文字を使う。
    const delimiter = imap
      ? (parent?.delimiter ??
        siblings.find((mailbox) => mailbox.delimiter)?.delimiter ??
        "/")
      : null;
    if (mailboxNameError(body.name, delimiter)) {
      return c.json({ error: "invalid_name" }, 400);
    }
    const path = parent ? `${parent.path}${delimiter}${body.name}` : body.name;
    const exists = imap
      ? siblings.some(
          (mailbox) => mailbox.path.toLowerCase() === path.toLowerCase(),
        )
      : siblings.some(
          (mailbox) =>
            mailbox.parentId === (parent?.id ?? null) &&
            mailbox.name.toLowerCase() === body.name.toLowerCase(),
        );
    if (exists) {
      return c.json({ error: "mailbox_exists" }, 409);
    }
    await enqueue(account.id, "mailbox_create", {
      name: body.name,
      parentPath: parent?.path ?? null,
      path,
      targets: [],
    });
    return c.body(null, 202);
  });

  /** フォルダの名前を変える。受信トレイなど、役割のあるフォルダは変えられない。 */
  app.patch(
    "/:id",
    zValidator("param", idParam),
    zValidator("json", renameBody),
    async (c) => {
      const { id } = c.req.valid("param");
      const { name } = c.req.valid("json");
      const mailbox = await loadMailbox(c.var.user.id, id);
      if (!mailbox) {
        return c.json({ error: "not_found" }, 404);
      }
      if (mailbox.specialUse || mailbox.detectedSpecialUse) {
        return c.json({ error: "special_mailbox" }, 400);
      }
      const delimiter = mailbox.protocol === "imap" ? mailbox.delimiter : null;
      if (mailboxNameError(name, delimiter)) {
        return c.json({ error: "invalid_name" }, 400);
      }
      // IMAP のパスは、親のパス + 区切り文字 + 名前。最後の区切りより後ろを付け替える。
      const cut = delimiter ? mailbox.path.lastIndexOf(delimiter) : -1;
      const newPath = cut === -1 ? name : mailbox.path.slice(0, cut + 1) + name;
      const others = await db
        .select({
          parentId: mailboxes.parentId,
          path: mailboxes.path,
          name: mailboxes.name,
        })
        .from(mailboxes)
        .where(
          and(eq(mailboxes.accountId, mailbox.accountId), ne(mailboxes.id, id)),
        );
      const exists =
        mailbox.protocol === "imap"
          ? others.some(
              (other) => other.path.toLowerCase() === newPath.toLowerCase(),
            )
          : others.some(
              (other) =>
                other.parentId === mailbox.parentId &&
                other.name.toLowerCase() === name.toLowerCase(),
            );
      if (exists) {
        return c.json({ error: "mailbox_exists" }, 409);
      }
      await enqueue(mailbox.accountId, "mailbox_rename", {
        mailboxId: id,
        path: mailbox.path,
        newPath: mailbox.protocol === "imap" ? newPath : mailbox.path,
        name,
        delimiter,
        targets: [],
      });
      return c.body(null, 202);
    },
  );

  /**
   * フォルダを、中のメールごとメールサーバーから削除する。
   * 役割のあるフォルダと、中にフォルダがあるフォルダは削除できない。
   */
  app.delete("/:id", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const mailbox = await loadMailbox(c.var.user.id, id);
    if (!mailbox) {
      return c.json({ error: "not_found" }, 404);
    }
    if (mailbox.specialUse || mailbox.detectedSpecialUse) {
      return c.json({ error: "special_mailbox" }, 400);
    }
    const [child] = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.parentId, id))
      .limit(1);
    if (child) {
      return c.json({ error: "has_children" }, 409);
    }
    await enqueue(mailbox.accountId, "mailbox_delete", {
      mailboxId: id,
      path: mailbox.path,
      name: mailbox.name,
      targets: [],
    });
    return c.body(null, 202);
  });

  /**
   * フォルダの役割・表示名・アイコン・色を、アプリ内でだけ上書きする (ほかの端末にも同じ内容で出る)。
   * メールサーバー側のフォルダは変えない。迷惑メールのフォルダが独自の名前で、役割が
   * 知らされないメールサーバーなどで使う。上書きした役割は、移動・アーカイブ・削除・
   * 送信の控え・下書きの保存先にもそのまま使われる。
   */
  app.put(
    "/:id/overrides",
    zValidator("param", idParam),
    zValidator("json", overridesBody),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const user = c.var.user;
      const result = await db.transaction(async (tx) => {
        const [target] = await tx
          .select({ accountId: mailboxes.accountId })
          .from(mailboxes)
          .innerJoin(mailAccounts, eq(mailAccounts.id, mailboxes.accountId))
          .where(and(eq(mailboxes.id, id), eq(mailAccounts.userId, user.id)));
        if (!target) return "not_found" as const;
        // 同期ワーカーのフォルダ一覧の反映と、順番に実行する。
        const rows = await tx
          .select({
            id: mailboxes.id,
            specialUse: mailboxes.specialUse,
            detectedSpecialUse: mailboxes.detectedSpecialUse,
            roleOverride: mailboxes.roleOverride,
          })
          .from(mailboxes)
          .where(eq(mailboxes.accountId, target.accountId))
          .for("update");
        const own = rows.find((row) => row.id === id);
        if (!own) return "not_found" as const;
        // 受信トレイなどは、メールサーバーの仕組みと結び付いているので役割を変えられない。
        const fixed =
          own.detectedSpecialUse === "inbox" ||
          own.detectedSpecialUse === "all" ||
          own.detectedSpecialUse === "flagged";
        if (fixed && body.role !== null) return "fixed_role" as const;

        await tx
          .update(mailboxes)
          .set({
            roleOverride: body.role,
            displayName: body.displayName === "" ? null : body.displayName,
            icon: body.icon,
            color: body.color,
          })
          .where(eq(mailboxes.id, id));
        const changed = new Set([id]);
        // 同じ役割をほかのフォルダに付けていたら、そちらの上書きを外す (役割は 1 つのフォルダだけ)。
        const overrides = new Map(
          rows.map((row) => [
            row.id,
            row.id === id ? body.role : row.roleOverride,
          ]),
        );
        if (body.role !== null && body.role !== "none") {
          for (const row of rows) {
            if (row.id === id || row.roleOverride !== body.role) continue;
            overrides.set(row.id, null);
            await tx
              .update(mailboxes)
              .set({ roleOverride: null })
              .where(eq(mailboxes.id, row.id));
            changed.add(row.id);
          }
        }
        const roles = resolveMailboxRoles(
          rows.map((row) => ({
            id: row.id,
            detected: row.detectedSpecialUse,
            override: overrides.get(row.id) ?? null,
          })),
        );
        for (const row of rows) {
          const specialUse = roles.get(row.id) ?? null;
          if (row.specialUse === specialUse) continue;
          await tx
            .update(mailboxes)
            .set({ specialUse })
            .where(eq(mailboxes.id, row.id));
          changed.add(row.id);
        }
        await recordChanges(tx, user.id, "mailbox", [...changed]);
        return "ok" as const;
      });
      if (result === "not_found") {
        return c.json({ error: "not_found" }, 404);
      }
      if (result === "fixed_role") {
        return c.json({ error: "fixed_role" }, 400);
      }
      return c.body(null, 204);
    },
  );

  /** 並び替えたフォルダを、既定の順 (役割、次に名前) に戻す。 */
  app.post("/order/reset", zValidator("json", orderBody), async (c) => {
    const { mailboxIds } = c.req.valid("json");
    const user = c.var.user;
    await db.transaction(async (tx) => {
      const owned = await tx
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .innerJoin(mailAccounts, eq(mailAccounts.id, mailboxes.accountId))
        .where(
          and(
            eq(mailAccounts.userId, user.id),
            inArray(mailboxes.id, mailboxIds),
          ),
        );
      const ids = owned.map((row) => row.id);
      if (ids.length === 0) return;
      await tx
        .update(mailboxes)
        .set({ sortOrder: null })
        .where(inArray(mailboxes.id, ids));
      await recordChanges(tx, user.id, "mailbox", ids);
    });
    return c.body(null, 204);
  });

  /**
   * フォルダの未読のメールを、すべて既読にする。
   * 1 通ずつ既読にするのと同じ経路 (DB に反映し、メールサーバーへは後から反映) を使う。
   */
  app.post("/:id/read", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const user = c.var.user;
    const [mailbox] = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .innerJoin(mailAccounts, eq(mailAccounts.id, mailboxes.accountId))
      .where(and(eq(mailboxes.id, id), eq(mailAccounts.userId, user.id)));
    if (!mailbox) {
      return c.json({ error: "not_found" }, 404);
    }
    let count = 0;
    for (;;) {
      const unread = await db
        .select({ id: messages.id })
        .from(messageMailboxes)
        .innerJoin(messages, eq(messages.id, messageMailboxes.messageId))
        .where(
          and(eq(messageMailboxes.mailboxId, id), eq(messages.seen, false)),
        )
        .limit(MARK_READ_BATCH);
      if (unread.length === 0) break;
      const result = await enqueueMessageAction(db, user.id, {
        action: "set_flags",
        idempotencyKey: crypto.randomUUID(),
        messageIds: unread.map((row) => row.id),
        seen: true,
      });
      // 受け付けられなかった分を繰り返し取り出さないよう、そこで止める。
      if (!result.ok) break;
      count += unread.length;
      if (unread.length < MARK_READ_BATCH) break;
    }
    return c.json({ count });
  });

  return app;
}
