import {
  type Database,
  mailAccounts,
  mailboxes,
  messageMailboxes,
  messages,
  type UnifiedFilters,
  type UnifiedScope,
  unifiedFolders,
} from "@orbit/db";
import { and, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { parseSearchQuery } from "./search-query.js";
import { termCondition } from "./search-sql.js";

/**
 * 統合フォルダ。複数のアカウントのフォルダを 1 つの一覧にまとめ、条件で絞り込む。
 * ここでは、保存する内容の形と、その内容に当てはまるメールを探す SQL を用意する。
 */

export const UNIFIED_ROLES = [
  "inbox",
  "sent",
  "drafts",
  "archive",
  "junk",
  "trash",
] as const;

/** サイドバー上部に初めからある項目。統合フォルダと一緒に並び替えたり隠したりできる。 */
export const BUILTIN_VIEWS = [
  "inbox",
  "starred",
  "drafts",
  "outgoing",
] as const;

const distinct = (values: string[]) => new Set(values).size === values.length;

export const unifiedScope = z.object({
  all: z.boolean(),
  roles: z.array(z.enum(UNIFIED_ROLES)).max(UNIFIED_ROLES.length),
  mailboxIds: z.array(z.uuid()).max(500),
});

const word = z.string().max(200);
export const unifiedFilters = z.object({
  unread: z.boolean(),
  flagged: z.boolean(),
  hasAttachment: z.boolean(),
  from: word,
  to: word,
  subject: word,
  text: word,
  withinDays: z.number().int().min(1).max(3650).nullable(),
});

/** 並び順と隠す項目。決まった名前か、統合フォルダの ID。 */
const layoutKey = z.union([z.enum(BUILTIN_VIEWS), z.uuid()]);
export const sidebarLayout = z.object({
  order: z.array(layoutKey).max(300).refine(distinct),
  hidden: z.array(layoutKey).max(300).refine(distinct),
});

/** 重複を除き、順番を揃える (同じ内容は同じ形で保存する)。 */
export function normalizeScope(scope: UnifiedScope): UnifiedScope {
  return {
    all: scope.all,
    roles: UNIFIED_ROLES.filter((role) => scope.roles.includes(role)),
    mailboxIds: [...new Set(scope.mailboxIds.map((id) => id.toLowerCase()))],
  };
}

export function normalizeFilters(filters: UnifiedFilters): UnifiedFilters {
  return {
    ...filters,
    from: filters.from.trim(),
    to: filters.to.trim(),
    subject: filters.subject.trim(),
    text: filters.text.trim(),
  };
}

/**
 * フォルダが、統合フォルダの集める場所に入っているか。
 * 外側の問い合わせの mailboxes を参照する。
 */
export function scopeCondition(scope: UnifiedScope): SQL {
  if (scope.all) {
    return sql`(${mailboxes.specialUse} is distinct from 'trash' and ${mailboxes.specialUse} is distinct from 'junk')`;
  }
  const parts: SQL[] = [];
  if (scope.roles.length > 0) {
    parts.push(inArray(mailboxes.specialUse, scope.roles));
  }
  if (scope.mailboxIds.length > 0) {
    parts.push(inArray(mailboxes.id, scope.mailboxIds));
  }
  return parts.length === 0 ? sql`false` : (or(...parts) as SQL);
}

/** メールが、統合フォルダの条件に当てはまるか。外側の問い合わせの messages を参照する。 */
export function filterConditions(filters: UnifiedFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters.unread) conditions.push(eq(messages.seen, false));
  if (filters.flagged) conditions.push(eq(messages.flagged, true));
  if (filters.hasAttachment) conditions.push(eq(messages.hasAttachments, true));
  for (const field of ["from", "to", "subject"] as const) {
    const text = filters[field].trim();
    if (text !== "") {
      conditions.push(termCondition({ field, text, negated: false }));
    }
  }
  // 「含む文字」は検索欄と同じ書き方 (空白で区切ると、すべてを含むメール) で解釈する。
  for (const term of parseSearchQuery(filters.text).terms) {
    conditions.push(termCondition(term));
  }
  if (filters.withinDays !== null) {
    conditions.push(
      sql`${messages.receivedAt} >= now() - make_interval(days => ${filters.withinDays}::int)`,
    );
  }
  return conditions;
}

type Folder = { scope: UnifiedScope; filters: UnifiedFilters };

/** メール (外側の messages) が、集める場所のどれかのフォルダにある。 */
function inScope(scope: UnifiedScope): SQL {
  return sql`exists (
    select 1 from ${messageMailboxes}
    inner join ${mailboxes} on ${mailboxes.id} = ${messageMailboxes.mailboxId}
    where ${messageMailboxes.messageId} = ${messages.id} and ${scopeCondition(scope)}
  )`;
}

/** 統合フォルダに入る未読のメールの数。 */
export async function unifiedUnreadCount(
  db: Database,
  userId: string,
  folder: Folder,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(mailAccounts, eq(mailAccounts.id, messages.accountId))
    .where(
      and(
        eq(mailAccounts.userId, userId),
        eq(messages.seen, false),
        ...filterConditions(folder.filters),
        inScope(folder.scope),
      ),
    );
  return row?.count ?? 0;
}

/**
 * 統合フォルダに入るメールを会話ごとにまとめた表 (別名 heads)。
 * rn = 1 の行が会話の代表 (最も新しいメール) で、t_ で始まる列は、会話のうち
 * この統合フォルダに入る分をまとめた値。1 通が複数のフォルダにあっても 1 回だけ数え、
 * 添えるフォルダは受信トレイを優先し、「すべてのメール」やごみ箱は後回しにする。
 */
export function unifiedHeads(userId: string, folder: Folder): SQL {
  return sql`(
    select x.*,
      row_number() over (
        partition by x.account_id, x.thread_key
        order by x.received_at desc, x.id desc
      ) as rn,
      bool_and(x.seen) over p as t_seen,
      bool_or(x.flagged) over p as t_flagged,
      bool_or(x.has_attachments) over p as t_attachments,
      json_agg(x.id) over (
        partition by x.account_id, x.thread_key
        order by x.received_at, x.id
        rows between unbounded preceding and unbounded following
      ) as t_ids
    from (
      select distinct on (${messages.id})
        ${messages.id} as id,
        ${messages.accountId} as account_id,
        ${messages.threadKey} as thread_key,
        ${messages.receivedAt} as received_at,
        ${messages.seen} as seen,
        ${messages.flagged} as flagged,
        ${messages.hasAttachments} as has_attachments,
        ${mailboxes.id} as mailbox_id
      from ${messages}
      inner join ${mailAccounts} on ${mailAccounts.id} = ${messages.accountId}
      inner join ${messageMailboxes} on ${messageMailboxes.messageId} = ${messages.id}
      inner join ${mailboxes} on ${mailboxes.id} = ${messageMailboxes.mailboxId}
      where ${and(
        eq(mailAccounts.userId, userId),
        scopeCondition(folder.scope),
        ...filterConditions(folder.filters),
      )}
      order by ${messages.id},
        case
          when ${mailboxes.specialUse} = 'inbox' then 0
          when ${mailboxes.specialUse} in ('all', 'flagged') then 2
          when ${mailboxes.specialUse} in ('trash', 'junk') then 3
          else 1
        end,
        ${mailboxes.id}
    ) x
    window p as (partition by x.account_id, x.thread_key)
  ) heads`;
}

/** 本人の統合フォルダ 1 件。無ければ null。 */
export async function loadUnifiedFolder(
  db: Database,
  userId: string,
  id: string,
) {
  const [row] = await db
    .select()
    .from(unifiedFolders)
    .where(and(eq(unifiedFolders.id, id), eq(unifiedFolders.userId, userId)));
  return row ?? null;
}

/**
 * 集めるフォルダの指定から、その利用者のものでないフォルダを除く。
 * 他の利用者のフォルダを指定しても中身は見えない (一覧は利用者で絞る) が、
 * 他人の ID を保存したままにしない。
 */
export async function ownScope(
  db: Database,
  userId: string,
  scope: UnifiedScope,
): Promise<UnifiedScope> {
  const normalized = normalizeScope(scope);
  if (normalized.mailboxIds.length === 0) return normalized;
  const rows = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .innerJoin(mailAccounts, eq(mailAccounts.id, mailboxes.accountId))
    .where(
      and(
        eq(mailAccounts.userId, userId),
        inArray(mailboxes.id, normalized.mailboxIds),
      ),
    );
  const owned = new Set(rows.map((row) => row.id));
  return {
    ...normalized,
    mailboxIds: normalized.mailboxIds.filter((id) => owned.has(id)),
  };
}
