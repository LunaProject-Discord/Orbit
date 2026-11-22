import { applyActions } from "@/lib/actions";
import type {
  Account,
  Address,
  MailboxSummary,
  MessageAction,
  MessageDetail,
  MessagePage,
  MessageSummary,
  SearchPage,
  SearchParams,
  ServerDraft,
  ThreadMessage,
} from "@/lib/api";
import {
  buildSearch,
  highlightTerms,
  isEmptySearch,
  matchSearch,
} from "@/lib/offline/search-local";
import type { LocalStore, WriteOp } from "@/lib/offline/store";

/** 表示する一覧。mailboxId が null なら受信トレイ (accountId も null なら全アカウント分)。 */
export type ListScope = { accountId: string | null; mailboxId: string | null };

/** 検索用に持つ、メール 1 通分の内容 (本文は文字だけ)。 */
type IndexDoc = {
  id: string;
  accountId: string;
  subject: string;
  from: Address[];
  to: Address[];
  cc: Address[];
  receivedAt: string;
  snippet: string;
  hasAttachments: boolean;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  body: string | null;
};

type StoredAttachment = { blob: Blob; cachedAt: number };

/** 検索用に持つ本文の長さの上限。 */
const MAX_INDEX_BODY = 20_000;
/** 端末に持つ本文の数の上限。超えたら、受信が古いものから消す。 */
export const MAX_DETAILS = 3_000;
/** 端末に持つ添付ファイル 1 件の大きさと、件数の上限。 */
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const MAX_ATTACHMENTS = 60;

const rowKey = (row: Pick<MessageSummary, "mailboxId" | "id">) =>
  `${row.mailboxId}|${row.id}`;

/** 一覧の並び順 (新しい順)。a が b より後ろなら正。 */
function compare(
  a: { receivedAt: string; id: string },
  b: { receivedAt: string; id: string },
): number {
  const [at, bt] = [Date.parse(a.receivedAt), Date.parse(b.receivedAt)];
  if (at !== bt) return at < bt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** サーバーの一覧と同じ形の、続きの位置。 */
function cursorOf(row: { receivedAt: string; id: string }): string {
  return `${new Date(row.receivedAt).toISOString()}_${row.id}`;
}

function parseCursor(
  cursor: string | null | undefined,
): { receivedAt: string; id: string } | null {
  if (!cursor) return null;
  const index = cursor.lastIndexOf("_");
  if (index < 0) return null;
  const receivedAt = cursor.slice(0, index);
  if (Number.isNaN(Date.parse(receivedAt))) return null;
  return { receivedAt, id: cursor.slice(index + 1) };
}

function plainText(detail: MessageDetail): string | null {
  const text =
    detail.bodyText ??
    detail.bodyHtml
      ?.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ") ??
    null;
  return text === null ? null : text.slice(0, MAX_INDEX_BODY);
}

function indexDoc(detail: MessageDetail): IndexDoc {
  return {
    id: detail.id,
    accountId: detail.accountId,
    subject: detail.subject,
    from: detail.from,
    to: detail.to,
    cc: detail.cc,
    receivedAt: detail.receivedAt,
    snippet: detail.snippet,
    hasAttachments: detail.hasAttachments,
    seen: detail.seen,
    flagged: detail.flagged,
    answered: detail.answered,
    draft: detail.draft,
    body: plainText(detail),
  };
}

/** 検索結果に添えるフォルダの優先順 (サーバーの検索と同じ)。 */
function mailboxRank(mailbox: MailboxSummary | undefined): number {
  switch (mailbox?.specialUse) {
    case "inbox":
      return 0;
    case "all":
    case "flagged":
      return 2;
    case "trash":
    case "junk":
      return 3;
    default:
      return 1;
  }
}

/**
 * 端末内に置く、メールの控え。サーバーから取得した内容をそのまま保存し、
 * サーバーに届かないときは、ここから同じ形で返す。
 */
export class MailCache {
  constructor(readonly store: LocalStore) {}

  // -------------------------------------------------------------------------
  // アカウント、フォルダ、下書き
  // -------------------------------------------------------------------------

  saveAccounts(accounts: Account[]): Promise<void> {
    return this.putMeta("accounts", accounts);
  }

  loadAccounts(): Promise<Account[] | undefined> {
    return this.store.get("meta", "accounts");
  }

  async saveMailboxes(mailboxes: MailboxSummary[]): Promise<void> {
    const before = await this.loadMailboxes();
    const ops: WriteOp[] = [
      { type: "put", table: "meta", key: "mailboxes", value: mailboxes },
    ];
    // 無くなったフォルダの一覧は、もう表示することが無いので消す。
    const ids = new Set(mailboxes.map((mailbox) => mailbox.id));
    for (const mailbox of before ?? []) {
      if (ids.has(mailbox.id)) continue;
      ops.push({ type: "delete", table: "meta", key: `synced:${mailbox.id}` });
      for (const row of await this.rowsOf(mailbox.id)) {
        ops.push({ type: "delete", table: "rows", key: rowKey(row) });
      }
    }
    await this.store.write(ops);
  }

  loadMailboxes(): Promise<MailboxSummary[] | undefined> {
    return this.store.get("meta", "mailboxes");
  }

  saveDrafts(drafts: ServerDraft[]): Promise<void> {
    return this.putMeta("drafts", drafts);
  }

  loadDrafts(): Promise<ServerDraft[] | undefined> {
    return this.store.get("meta", "drafts");
  }

  private putMeta(key: string, value: unknown): Promise<void> {
    return this.store.write([{ type: "put", table: "meta", key, value }]);
  }

  // -------------------------------------------------------------------------
  // 一覧
  // -------------------------------------------------------------------------

  private rowsOf(mailboxId: string): Promise<MessageSummary[]> {
    return this.store.list<MessageSummary>("rows", `${mailboxId}|`);
  }

  /** 一覧が表すフォルダ。受信トレイの指定は、保存してあるフォルダの一覧から求める。 */
  private async scopeMailboxIds(scope: ListScope): Promise<string[]> {
    if (scope.mailboxId) return [scope.mailboxId];
    return ((await this.loadMailboxes()) ?? [])
      .filter(
        (mailbox) =>
          mailbox.specialUse === "inbox" &&
          (!scope.accountId || mailbox.accountId === scope.accountId),
      )
      .map((mailbox) => mailbox.id);
  }

  /**
   * サーバーから取得した一覧の 1 ページを保存する。
   * そのページが表す範囲にあった古い行のうち、ページに無いもの (移動や削除で
   * 無くなったもの) は消す。
   */
  async savePage(
    scope: ListScope,
    cursor: string | null,
    page: MessagePage,
  ): Promise<void> {
    const mailboxIds = new Set(await this.scopeMailboxIds(scope));
    for (const row of page.messages) mailboxIds.add(row.mailboxId);
    const upper = parseCursor(cursor);
    const last = page.messages.at(-1);
    const lower = page.nextCursor && last ? last : null;
    const kept = new Set(page.messages.map(rowKey));

    const ops: WriteOp[] = [];
    for (const mailboxId of mailboxIds) {
      for (const row of await this.rowsOf(mailboxId)) {
        if (kept.has(rowKey(row))) continue;
        if (scope.accountId && row.accountId !== scope.accountId) continue;
        if (cursor && !upper) continue;
        // ページの範囲: 開始位置より後ろで、最後の行まで (続きが無ければ末尾まで)。
        if (upper && compare(upper, row) >= 0) continue;
        if (lower && compare(lower, row) < 0) continue;
        ops.push({ type: "delete", table: "rows", key: rowKey(row) });
      }
      if (!cursor) {
        ops.push({
          type: "put",
          table: "meta",
          key: `synced:${mailboxId}`,
          value: Date.now(),
        });
      }
    }
    for (const row of page.messages) {
      ops.push({ type: "put", table: "rows", key: rowKey(row), value: row });
    }
    await this.store.write(ops);
  }

  /**
   * 保存してある一覧を 1 ページ返す。そのフォルダを一度も保存していなければ null。
   */
  async loadPage(
    scope: ListScope,
    cursor: string | null,
    limit: number,
  ): Promise<MessagePage | null> {
    const mailboxIds = await this.scopeMailboxIds(scope);
    let known = false;
    const rows: MessageSummary[] = [];
    for (const mailboxId of mailboxIds) {
      if ((await this.store.get("meta", `synced:${mailboxId}`)) !== undefined) {
        known = true;
      }
      rows.push(...(await this.rowsOf(mailboxId)));
    }
    if (!known) return null;
    const after = parseCursor(cursor);
    const sorted = rows
      .filter((row) => !after || compare(after, row) < 0)
      .sort(compare);
    const messages = sorted.slice(0, limit);
    const last = messages.at(-1);
    return {
      messages,
      nextCursor: last && sorted.length > limit ? cursorOf(last) : null,
    };
  }

  // -------------------------------------------------------------------------
  // 本文、会話、添付ファイル
  // -------------------------------------------------------------------------

  async saveDetail(detail: MessageDetail): Promise<void> {
    await this.store.write([
      { type: "put", table: "details", key: detail.id, value: detail },
      { type: "put", table: "texts", key: detail.id, value: indexDoc(detail) },
    ]);
  }

  loadDetail(id: string): Promise<MessageDetail | undefined> {
    return this.store.get("details", id);
  }

  /** 本文を保存してあるメッセージの ID。 */
  async detailIds(): Promise<Set<string>> {
    return new Set(await this.store.keys("details"));
  }

  saveThread(
    id: string,
    mailboxId: string | null,
    thread: ThreadMessage[],
  ): Promise<void> {
    return this.store.write([
      {
        type: "put",
        table: "threads",
        key: `${id}|${mailboxId ?? ""}`,
        value: thread,
      },
    ]);
  }

  /**
   * 保存してある会話を返す。会話として保存していなくても、一覧の行と本文があれば、
   * そこから組み立てる (そのフォルダにある分だけになる)。
   */
  async loadThread(
    id: string,
    mailboxId: string | null,
  ): Promise<ThreadMessage[] | null> {
    const saved = await this.store.get<ThreadMessage[]>(
      "threads",
      `${id}|${mailboxId ?? ""}`,
    );
    if (saved) return saved;

    const rows = mailboxId
      ? await this.rowsOf(mailboxId)
      : await this.store.list<MessageSummary>("rows");
    const row = rows.find(
      (item) => item.id === id || item.threadMessageIds.includes(id),
    );
    const ids = row ? row.threadMessageIds : [id];
    const thread: ThreadMessage[] = [];
    for (const memberId of ids) {
      const doc = await this.store.get<IndexDoc>("texts", memberId);
      if (doc) {
        const { body: _body, ...rest } = doc;
        thread.push({ ...rest, mailboxIds: row ? [row.mailboxId] : [] });
      } else if (row && memberId === row.id) {
        thread.push({
          id: row.id,
          accountId: row.accountId,
          subject: row.subject,
          from: row.from,
          to: row.to,
          cc: [],
          receivedAt: row.receivedAt,
          snippet: row.snippet,
          hasAttachments: row.hasAttachments,
          seen: row.seen,
          flagged: row.flagged,
          answered: row.answered,
          draft: false,
          mailboxIds: [row.mailboxId],
        });
      }
    }
    if (thread.length === 0) return null;
    return thread.sort((a, b) => compare(b, a));
  }

  async saveAttachment(
    messageId: string,
    attachmentId: string,
    blob: Blob,
  ): Promise<void> {
    if (blob.size > MAX_ATTACHMENT_BYTES) return;
    const value: StoredAttachment = { blob, cachedAt: Date.now() };
    await this.store.write([
      {
        type: "put",
        table: "attachments",
        key: `${messageId}|${attachmentId}`,
        value,
      },
    ]);
  }

  async loadAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<Blob | undefined> {
    const saved = await this.store.get<StoredAttachment>(
      "attachments",
      `${messageId}|${attachmentId}`,
    );
    return saved?.blob;
  }

  // -------------------------------------------------------------------------
  // 操作の反映
  // -------------------------------------------------------------------------

  /**
   * 画面で行った操作 (既読、スター、移動、削除) を、保存してある内容にも反映する。
   * サーバーへ送る前でも、オフラインで開き直したときに操作後の状態で表示できる。
   */
  async applyAction(action: MessageAction): Promise<void> {
    const ids = new Set(action.messageIds);
    const ops: WriteOp[] = [];

    const rows = (await this.store.list<MessageSummary>("rows")).filter((row) =>
      row.threadMessageIds.some((id) => ids.has(id)),
    );
    const after = new Map(
      applyActions(rows, [action]).map((row) => [rowKey(row), row]),
    );
    for (const row of rows) {
      const next = after.get(rowKey(row));
      if (!next) ops.push({ type: "delete", table: "rows", key: rowKey(row) });
      else if (next !== row) {
        ops.push({ type: "put", table: "rows", key: rowKey(row), value: next });
      }
    }

    if (action.action === "set_flags") {
      const flags = {
        ...(action.seen === undefined ? {} : { seen: action.seen }),
        ...(action.flagged === undefined ? {} : { flagged: action.flagged }),
      };
      for (const id of ids) {
        for (const table of ["details", "texts"] as const) {
          const value = await this.store.get<object>(table, id);
          if (value) {
            ops.push({
              type: "put",
              table,
              key: id,
              value: { ...value, ...flags },
            });
          }
        }
      }
      for (const key of await this.store.keys("threads")) {
        const thread = await this.store.get<ThreadMessage[]>("threads", key);
        if (!thread?.some((message) => ids.has(message.id))) continue;
        ops.push({
          type: "put",
          table: "threads",
          key,
          value: thread.map((message) =>
            ids.has(message.id) ? { ...message, ...flags } : message,
          ),
        });
      }
    }
    await this.store.write(ops);
  }

  // -------------------------------------------------------------------------
  // 検索
  // -------------------------------------------------------------------------

  /** 保存してあるメールを検索する。結果の形はサーバーの検索と同じ。 */
  async search(
    params: SearchParams &
      ListScope & { cursor?: string | null; limit?: number },
  ): Promise<SearchPage> {
    const search = buildSearch(params.text, params.filters);
    const terms = highlightTerms(search);
    if (isEmptySearch(search)) return { messages: [], nextCursor: null, terms };

    const mailboxes = new Map(
      ((await this.loadMailboxes()) ?? []).map((mailbox) => [
        mailbox.id,
        mailbox,
      ]),
    );
    const inScope = (row: MessageSummary): boolean => {
      if (params.accountId && row.accountId !== params.accountId) return false;
      const mailbox = mailboxes.get(row.mailboxId);
      if (params.scope === "folder") {
        return params.mailboxId
          ? row.mailboxId === params.mailboxId
          : mailbox?.specialUse === "inbox";
      }
      return mailbox?.specialUse !== "trash" && mailbox?.specialUse !== "junk";
    };
    const preferred = params.scope === "folder" ? params.mailboxId : null;
    const rank = (mailboxId: string) =>
      mailboxId === preferred ? -1 : mailboxRank(mailboxes.get(mailboxId));

    const docs = new Map(
      (await this.store.list<IndexDoc>("texts")).map((doc) => [doc.id, doc]),
    );
    const found = new Map<string, MessageSummary>();
    for (const row of await this.store.list<MessageSummary>("rows")) {
      if (!inScope(row)) continue;
      for (const id of row.threadMessageIds) {
        const known = found.get(id);
        if (known && rank(known.mailboxId) <= rank(row.mailboxId)) continue;
        const doc = docs.get(id);
        // 本文を保存していないメールは、一覧の行にある内容だけで探す。
        const source = doc ?? (id === row.id ? row : null);
        if (!source) continue;
        const match = matchSearch(
          {
            subject: source.subject,
            from: source.from,
            recipients: doc ? [...doc.to, ...doc.cc] : source.to,
            snippet: source.snippet,
            body: doc?.body ?? null,
            receivedAt: source.receivedAt,
            hasAttachments: source.hasAttachments,
            seen: source.seen,
            flagged: source.flagged,
          },
          search,
        );
        if (!match) continue;
        found.set(id, {
          id,
          accountId: row.accountId,
          mailboxId: row.mailboxId,
          threadKey: row.threadKey,
          subject: source.subject,
          from: source.from,
          to: source.to,
          receivedAt: source.receivedAt,
          snippet: source.snippet,
          hasAttachments: source.hasAttachments,
          seen: source.seen,
          flagged: source.flagged,
          answered: source.answered,
          excerpt: match.excerpt,
          // 検索結果は会話にまとめず、当てはまったメールを 1 通ずつ返す。
          threadCount: 1,
          threadMessageIds: [id],
        });
      }
    }

    const after = parseCursor(params.cursor);
    const limit = params.limit ?? 50;
    const sorted = [...found.values()]
      .filter((row) => !after || compare(after, row) < 0)
      .sort(compare);
    const messages = sorted.slice(0, limit);
    const last = messages.at(-1);
    return {
      messages,
      nextCursor: last && sorted.length > limit ? cursorOf(last) : null,
      terms,
    };
  }

  // -------------------------------------------------------------------------
  // 整理
  // -------------------------------------------------------------------------

  /** 端末に持つ本文と添付ファイルが増えすぎていたら、古いものから消す。 */
  async prune(maxDetails = MAX_DETAILS): Promise<void> {
    const ops: WriteOp[] = [];
    const docs = await this.store.list<IndexDoc>("texts");
    if (docs.length > maxDetails) {
      for (const doc of docs.sort(compare).slice(maxDetails)) {
        ops.push({ type: "delete", table: "details", key: doc.id });
        ops.push({ type: "delete", table: "texts", key: doc.id });
      }
    }
    const keys = await this.store.keys("attachments");
    if (keys.length > MAX_ATTACHMENTS) {
      const entries: { key: string; cachedAt: number }[] = [];
      for (const key of keys) {
        const saved = await this.store.get<StoredAttachment>(
          "attachments",
          key,
        );
        entries.push({ key, cachedAt: saved?.cachedAt ?? 0 });
      }
      entries.sort((a, b) => b.cachedAt - a.cachedAt);
      for (const entry of entries.slice(MAX_ATTACHMENTS)) {
        ops.push({ type: "delete", table: "attachments", key: entry.key });
      }
    }
    await this.store.write(ops);
  }
}
