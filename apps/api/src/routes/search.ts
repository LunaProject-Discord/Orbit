import { zValidator } from "@hono/zod-validator";
import { mailAccounts, mailboxes, messageMailboxes, messages } from "@orbit/db";
import { and, desc, eq, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, RouteDeps } from "../context.js";
import {
  highlightTerms,
  isEmptySearch,
  normalizeDate,
  parseSearchQuery,
} from "../lib/search-query.js";
import {
  folderCondition,
  hasPositiveFolder,
  termCondition,
} from "../lib/search-sql.js";
import {
  filterConditions,
  loadUnifiedFolder,
  scopeCondition,
} from "../lib/unified.js";

const flag = z.enum(["true", "false"]).optional();
const dateParam = z
  .string()
  .max(20)
  .optional()
  .transform((value, context) => {
    if (value === undefined || value === "") return undefined;
    const date = normalizeDate(value);
    if (!date) {
      context.addIssue({ code: "custom", message: "invalid_date" });
      return z.NEVER;
    }
    return date;
  });

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const searchQuery = z.object({
  /** 検索欄の入力。from: や is:unread などの書き方は lib/search-query.ts を参照。 */
  q: z.string().max(500).default(""),
  /** 省略すると全アカウントから探す。 */
  accountId: z.uuid().optional(),
  /** scope が folder のときに探すフォルダ。省略すると受信トレイ。 */
  mailboxId: z.uuid().optional(),
  /** scope が folder のときに探す統合フォルダ (その場所と条件の中から探す)。 */
  unifiedId: z.uuid().optional(),
  /** all は全フォルダ (ごみ箱と迷惑メールを除く)、folder は 1 つのフォルダだけ。 */
  scope: z.enum(["all", "folder"]).default("all"),
  from: z.string().max(200).optional(),
  to: z.string().max(200).optional(),
  subject: z.string().max(200).optional(),
  /** この日 (YYYY-MM-DD) 以降。 */
  since: dateParam,
  /** この日 (YYYY-MM-DD) まで (この日を含む)。 */
  until: dateParam,
  hasAttachment: flag,
  unread: flag,
  flagged: flag,
  /** 日付の区切りに使うタイムゾーン (Asia/Tokyo など)。 */
  timeZone: z.string().max(64).refine(isTimeZone).default("UTC"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** 前のページの nextCursor。 */
  cursor: z.string().max(100).optional(),
});

const cursorPattern = /^(\d{4}-[0-9T:.-]+Z)_([0-9a-f-]{36})$/;

/** 抜粋で、見つかった語の前に付ける文字数と全体の長さ。 */
const EXCERPT_BEFORE = 30;
const EXCERPT_LENGTH = 160;

/**
 * メールの検索。サーバーに同期済みのメール (全フォルダ) を、件名・差出人・宛先・本文の
 * 部分一致で探す。並びは新しい順で、続きは一覧と同じく cursor で取得する。
 */
export function searchRoutes({ db }: Pick<RouteDeps, "db">) {
  const app = new Hono<AppEnv>();

  app.get("/search", zValidator("query", searchQuery), async (c) => {
    const query = c.req.valid("query");
    const search = parseSearchQuery(query.q);
    for (const [field, value] of [
      ["from", query.from],
      ["to", query.to],
      ["subject", query.subject],
    ] as const) {
      if (value?.trim()) {
        search.terms.push({ field, text: value.trim(), negated: false });
      }
    }
    if (query.hasAttachment === "true") search.hasAttachment = true;
    if (query.unread === "true") search.seen = false;
    if (query.flagged === "true") search.flagged = true;
    if (query.since) search.since = query.since;

    const terms = highlightTerms(search);
    const unified =
      query.scope === "folder" && query.unifiedId
        ? await loadUnifiedFolder(db, c.var.user.id, query.unifiedId)
        : null;
    if (query.scope === "folder" && query.unifiedId && !unified) {
      return c.json({ error: "not_found" }, 404);
    }
    if (isEmptySearch(search) && !query.until) {
      return c.json({ messages: [], nextCursor: null, terms });
    }

    const conditions: SQL[] = [eq(mailAccounts.userId, c.var.user.id)];
    if (query.accountId) {
      conditions.push(eq(messages.accountId, query.accountId));
    }
    for (const term of search.terms) conditions.push(termCondition(term));
    for (const folder of search.folders ?? []) {
      conditions.push(folderCondition(folder));
    }
    if (search.hasAttachment !== undefined) {
      conditions.push(eq(messages.hasAttachments, search.hasAttachment));
    }
    if (search.seen !== undefined) {
      conditions.push(eq(messages.seen, search.seen));
    }
    if (search.flagged !== undefined) {
      conditions.push(eq(messages.flagged, search.flagged));
    }
    // 日付は、利用者のタイムゾーンでの 0 時を区切りにする。
    const startOfDay = (date: string, addDays = 0) =>
      sql`((${date}::date + ${addDays}::int)::timestamp at time zone ${query.timeZone})`;
    if (search.since) {
      conditions.push(
        sql`${messages.receivedAt} >= ${startOfDay(search.since)}`,
      );
    }
    if (search.before) {
      conditions.push(
        sql`${messages.receivedAt} < ${startOfDay(search.before)}`,
      );
    }
    if (query.until) {
      conditions.push(
        sql`${messages.receivedAt} < ${startOfDay(query.until, 1)}`,
      );
    }

    // 探す範囲。1 通が複数のフォルダにあっても (Gmail のラベルなど)、結果には 1 回だけ出す。
    if (unified) conditions.push(...filterConditions(unified.filters));
    const inScope = unified
      ? scopeCondition(unified.scope)
      : query.scope === "folder"
        ? query.mailboxId
          ? eq(mailboxes.id, query.mailboxId)
          : eq(mailboxes.specialUse, "inbox")
        : hasPositiveFolder(search)
          ? // folder: で選んだフォルダは、ごみ箱や迷惑メールでも探す。
            sql`true`
          : sql`${mailboxes.specialUse} is distinct from 'trash' and ${mailboxes.specialUse} is distinct from 'junk'`;
    conditions.push(
      sql`exists (
        select 1 from ${messageMailboxes}
        inner join ${mailboxes} on ${mailboxes.id} = ${messageMailboxes.mailboxId}
        where ${messageMailboxes.messageId} = ${messages.id} and ${inScope}
      )`,
    );

    if (query.cursor) {
      const match = cursorPattern.exec(query.cursor);
      if (!match) {
        return c.json({ error: "invalid_cursor" }, 400);
      }
      conditions.push(
        sql`(${messages.receivedAt}, ${messages.id}) < (${match[1]}::timestamptz, ${match[2]}::uuid)`,
      );
    }

    // 結果に添えるフォルダ。探したフォルダを優先し、「すべてのメール」やごみ箱は後回しにする。
    const preferred =
      query.scope === "folder" ? (query.mailboxId ?? null) : null;
    const mailboxId = sql<string>`(
      select ${mailboxes.id} from ${messageMailboxes}
      inner join ${mailboxes} on ${mailboxes.id} = ${messageMailboxes.mailboxId}
      where ${messageMailboxes.messageId} = ${messages.id}
      order by
        (${mailboxes.id} = ${preferred}::uuid) desc nulls last,
        case
          when ${mailboxes.specialUse} = 'inbox' then 0
          when ${mailboxes.specialUse} in ('all', 'flagged') then 2
          when ${mailboxes.specialUse} in ('trash', 'junk') then 3
          else 1
        end,
        ${mailboxes.id}
      limit 1
    )`;

    // 語が件名にも冒頭の抜粋にも現れないときは、本文の該当箇所を抜き出して返す。
    const excerptTerm = search.terms.find(
      (term) =>
        !term.negated && (term.field === "any" || term.field === "body"),
    );
    const position = excerptTerm
      ? sql<number>`position(lower(${excerptTerm.text}) in lower(${messages.searchBody}))`
      : sql<number>`0`;
    const excerpt = excerptTerm
      ? sql<string | null>`case
          when position(lower(${excerptTerm.text}) in lower(${messages.snippet})) = 0
            and position(lower(${excerptTerm.text}) in lower(${messages.subject})) = 0
            and ${position} > 0
          then substring(${messages.searchBody} from greatest(1, ${position} - ${EXCERPT_BEFORE}::int) for ${EXCERPT_LENGTH}::int)
        end`
      : sql<string | null>`null`;

    const rows = await db
      .select({
        id: messages.id,
        accountId: messages.accountId,
        mailboxId,
        threadKey: messages.threadKey,
        subject: messages.subject,
        from: messages.from,
        to: messages.to,
        receivedAt: messages.receivedAt,
        snippet: messages.snippet,
        hasAttachments: messages.hasAttachments,
        seen: messages.seen,
        flagged: messages.flagged,
        answered: messages.answered,
        excerpt,
        excerptPosition: position,
      })
      .from(messages)
      .innerJoin(mailAccounts, eq(mailAccounts.id, messages.accountId))
      .where(and(...conditions))
      .orderBy(desc(messages.receivedAt), desc(messages.id))
      .limit(query.limit + 1);

    const page = rows
      .slice(0, query.limit)
      .map(({ excerpt: text, excerptPosition, ...message }) => ({
        ...message,
        // 検索結果は会話にまとめず、当てはまったメールを 1 通ずつ返す。
        threadCount: 1,
        threadMessageIds: [message.id],
        excerpt: text
          ? `${excerptPosition > EXCERPT_BEFORE + 1 ? "…" : ""}${text.replace(/\s+/g, " ").trim()}`
          : null,
      }));
    const last = page.at(-1);
    const nextCursor =
      rows.length > query.limit && last
        ? `${last.receivedAt.toISOString()}_${last.id}`
        : null;
    return c.json({ messages: page, nextCursor, terms });
  });

  return app;
}
