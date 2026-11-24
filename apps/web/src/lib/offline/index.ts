import { useSyncExternalStore } from "react";
import * as api from "@/lib/api";
import {
  type Account,
  type MailboxSummary,
  type MessageAction,
  type MessageDetail,
  type MessagePage,
  NetworkError,
  type SearchPage,
  type SendMailInput,
  type ServerDraft,
  type ThreadMessage,
  type UploadedAttachment,
} from "@/lib/api";
import { type ListScope, MailCache } from "@/lib/offline/mail-cache";
import { Inflight, type Memo, MemoCache } from "@/lib/offline/memo";
import { isOnline, subscribeOnline } from "@/lib/offline/network";
import { type QueuedSend, SendOutbox } from "@/lib/offline/outbox";
import {
  IndexedDbStore,
  type LocalStore,
  MemoryStore,
} from "@/lib/offline/store";

/**
 * オフライン対応の入口。
 *
 * - サーバーから取得した内容 (アカウント、フォルダ、一覧、本文、会話、下書き) を端末内に保存し、
 *   サーバーに届かないときは保存してある内容を返す。画面からは、@/lib/api の同名の関数の
 *   代わりにここの関数を呼ぶ。
 * - サーバーに届かないときに送信したメールを預かり、届くようになったら送る。
 *
 * 保存先は利用者ごとに分け、ログアウトで消す。保存先の実体は LocalStore で差し替えられる
 * (Web / Tauri / Capacitor は IndexedDB。端末の SQLite を使う場合は openOffline に渡す)。
 */

export type { ListScope } from "@/lib/offline/mail-cache";
export { useOnline } from "@/lib/offline/network";
export type { QueuedSend } from "@/lib/offline/outbox";

type Session = {
  userId: string;
  store: LocalStore;
  cache: MailCache;
  outbox: SendOutbox;
  /** 本文を保存してあるメッセージ (先読みの要否を調べるのに使う)。 */
  known: Set<string>;
  close: () => void;
};

let session: Promise<Session> | null = null;
let sessionUserId: string | null = null;

const databaseName = (userId: string) => `mail-offline-${userId}`;

async function defaultStore(userId: string): Promise<LocalStore> {
  if (typeof indexedDB === "undefined") return new MemoryStore();
  try {
    return await IndexedDbStore.open(databaseName(userId));
  } catch {
    // プライベートブラウズなどで使えない場合。開いている間だけメモリーに持つ。
    return new MemoryStore();
  }
}

// 送信待ちの一覧。保存先を開く前や、開き直す間も、画面から同じ形で読める。
let queued: QueuedSend[] = [];
const queuedListeners = new Set<() => void>();
function setQueued(next: QueuedSend[]) {
  queued = next;
  for (const listener of queuedListeners) listener();
}

/** ログインした利用者の保存先を開く。同じ利用者で開いていれば、何もしない。 */
export function openOffline(
  userId: string,
  createStore: (userId: string) => Promise<LocalStore> = defaultStore,
): Promise<void> {
  if (session && sessionUserId === userId) return session.then(() => {});
  closeOffline();
  sessionUserId = userId;
  session = (async () => {
    const store = await createStore(userId);
    const cache = new MailCache(store);
    const outbox = new SendOutbox(store, { send: api.sendMail });
    const unsubscribeOutbox = outbox.subscribe(() => setQueued(outbox.items()));
    const unsubscribeOnline = subscribeOnline(() => {
      if (isOnline()) outbox.retryNow();
    });
    const known = await cache.detailIds().catch(() => new Set<string>());
    await outbox.load().catch(() => {});
    void outbox.flush();
    void cache.prune().catch(() => {});
    // ブラウザーが空き容量の都合で消してしまわないよう、残すように頼む (断られても動く)。
    if (store.persistent) {
      void navigator.storage?.persist?.().catch(() => {});
    }
    return {
      userId,
      store,
      cache,
      outbox,
      known,
      close: () => {
        unsubscribeOutbox();
        unsubscribeOnline();
        outbox.stop();
        store.close();
      },
    };
  })();
  return session.then(() => {});
}

/** 保存先を閉じる (内容は残る)。 */
export function closeOffline(): void {
  const closing = session;
  session = null;
  sessionUserId = null;
  prefetchQueue.length = 0;
  clearOpenMemo();
  setQueued([]);
  void closing?.then((current) => current.close()).catch(() => {});
}

/** 利用者の保存先を消す (ログアウトしたとき)。 */
export async function clearOffline(userId: string): Promise<void> {
  const closing = session;
  closeOffline();
  await closing?.catch(() => {});
  if (typeof indexedDB !== "undefined") {
    await IndexedDbStore.delete(databaseName(userId));
  }
}

async function current(): Promise<Session | null> {
  try {
    return await session;
  } catch {
    return null;
  }
}

/**
 * サーバーから取得して端末に保存する。サーバーに届かなければ、保存してある内容を返す
 * (保存していなければ、届かなかったことをそのまま伝える)。
 */
async function withCache<T>(
  fetch: () => Promise<T>,
  save: (cache: MailCache, value: T) => Promise<void>,
  load: (cache: MailCache) => Promise<T | null | undefined>,
): Promise<T> {
  let value: T;
  try {
    value = await fetch();
  } catch (error) {
    if (!(error instanceof NetworkError)) throw error;
    const cache = (await current())?.cache;
    const saved = cache ? await load(cache).catch(() => null) : null;
    if (saved === null || saved === undefined) throw error;
    return saved;
  }
  const cache = (await current())?.cache;
  // 保存は待たない (保存できなくても、画面の表示には関係ない)。
  if (cache) void save(cache, value).catch(() => {});
  return value;
}

export function listAccounts(signal?: AbortSignal): Promise<Account[]> {
  return withCache(
    () => api.listAccounts(signal),
    (cache, accounts) => cache.saveAccounts(accounts),
    (cache) => cache.loadAccounts(),
  );
}

export function listAllMailboxes(
  signal?: AbortSignal,
): Promise<MailboxSummary[]> {
  return withCache(
    () => api.listAllMailboxes(signal),
    (cache, mailboxes) => cache.saveMailboxes(mailboxes),
    (cache) => cache.loadMailboxes(),
  );
}

/** 1 つのアカウントのフォルダ (移動先を選ぶときに使う)。 */
export async function listMailboxes(
  accountId: string,
  signal?: AbortSignal,
): Promise<api.Mailbox[]> {
  try {
    return await api.listMailboxes(accountId, signal);
  } catch (error) {
    if (!(error instanceof NetworkError)) throw error;
    const saved = await (await current())?.cache.loadMailboxes();
    if (!saved) throw error;
    return saved.filter((mailbox) => mailbox.accountId === accountId);
  }
}

export function listDrafts(signal?: AbortSignal): Promise<ServerDraft[]> {
  return withCache(
    () => api.listDrafts(signal),
    (cache, drafts) => cache.saveDrafts(drafts),
    (cache) => cache.loadDrafts(),
  );
}

const scopeOf = (params: Partial<ListScope>): ListScope => ({
  accountId: params.accountId ?? null,
  mailboxId: params.mailboxId ?? null,
});

export function listMessages(
  params: Partial<ListScope> & { cursor?: string | null; limit?: number },
  signal?: AbortSignal,
): Promise<MessagePage> {
  const scope = scopeOf(params);
  const cursor = params.cursor ?? null;
  return withCache(
    () => api.listMessages(params, signal),
    async (cache, page) => {
      await cache.savePage(scope, cursor, page);
      prefetchBodies(page.messages.flatMap((row) => row.threadMessageIds));
    },
    (cache) => cache.loadPage(scope, cursor, params.limit ?? 50),
  );
}

/**
 * 保存してある一覧の先頭ページ。サーバーの応答を待たずに表示するために使う。
 * 保存していなければ null。
 */
export async function cachedMessages(
  scope: ListScope,
  limit: number,
): Promise<MessagePage | null> {
  const cache = (await current())?.cache;
  if (!cache) return null;
  return cache.loadPage(scope, null, limit).catch(() => null);
}

/** メールを検索する。サーバーに届かなければ、端末に保存してあるメールから探す。 */
export async function searchMessages(
  params: api.SearchParams &
    Partial<ListScope> & {
      /** scope が folder のときに探す統合フォルダ (オフラインでは絞り込めない)。 */
      unifiedId?: string | null;
      cursor?: string | null;
      limit?: number;
    },
  signal?: AbortSignal,
): Promise<SearchPage> {
  try {
    return await api.searchMessages(params, signal);
  } catch (error) {
    if (!(error instanceof NetworkError)) throw error;
    const cache = (await current())?.cache;
    if (!cache) throw error;
    return cache.search({ ...params, ...scopeOf(params) });
  }
}

// ---------------------------------------------------------------------------
// 開いたメールをすぐに表示するための控え
// ---------------------------------------------------------------------------

/** 取得した会話 (キーは threadKeyOf)。 */
const threadMemo = new MemoCache<ThreadMessage[]>(300);
/** 取得した本文。大きいことがあるので、会話より少なく持つ。 */
const detailMemo = new MemoCache<MessageDetail>(120);
const inflight = new Inflight();
/**
 * サーバーから取得してから、この時間のうちは取得し直さない
 * (カーソルを載せたときに取得した内容を、開いたときにもう一度取りに行かない)。
 */
export const OPEN_MEMO_FRESH_MS = 15_000;

const threadKeyOf = (id: string, mailboxId: string | null) =>
  `${id}|${mailboxId ?? ""}`;

function clearOpenMemo(): void {
  threadMemo.clear();
  detailMemo.clear();
  inflight.clear();
}

/** 控えてある会話。無ければ undefined。 */
export function peekThread(
  id: string,
  mailboxId: string | null,
): Memo<ThreadMessage[]> | undefined {
  return threadMemo.get(threadKeyOf(id, mailboxId));
}

/** 控えてある本文。無ければ undefined。 */
export function peekMessage(id: string): Memo<MessageDetail> | undefined {
  return detailMemo.get(id);
}

/** サーバーから取得したばかりで、取得し直さなくてよいか。 */
export function isFresh(memo: Memo<unknown> | undefined): boolean {
  return memo?.network === true && Date.now() - memo.at < OPEN_MEMO_FRESH_MS;
}

/** 会話の行 (一覧の 1 行) のうち、開く準備に使う値。 */
type ConversationRow = Pick<
  api.MessageSummary,
  "id" | "mailboxId" | "threadCount" | "threadMessageIds"
>;

/**
 * 端末の保存先にある会話を読み出す (サーバーには問い合わせない)。
 * 会話として保存したものだけを見る (一覧の行から組み立てるのは時間がかかるため)。
 * 会話として保存していなくても、一覧の行 (row) と保存してある本文から組み立てられれば、そうする。
 */
export async function loadSavedThread(
  id: string,
  mailboxId: string | null,
  row?: ConversationRow | null,
): Promise<ThreadMessage[] | null> {
  const key = threadKeyOf(id, mailboxId);
  const memo = threadMemo.get(key);
  if (memo) return memo.value;
  const cache = (await current())?.cache;
  const saved = await cache?.loadSavedThread(id, mailboxId).catch(() => null);
  if (saved) {
    threadMemo.set(key, saved, false);
    return saved;
  }
  // 会話のメールがすべてこのフォルダにあり (threadCount と同じ数)、どれも本文を保存してあれば、そこから組み立てる。
  if (
    !row ||
    row.id !== id ||
    row.threadCount !== row.threadMessageIds.length ||
    !row.threadMessageIds.includes(id)
  ) {
    return null;
  }
  const details = await Promise.all(
    row.threadMessageIds.map((memberId) => loadSavedMessage(memberId)),
  );
  if (details.some((detail) => !detail)) return null;
  const thread = (details as MessageDetail[])
    .map((detail) => threadMessageOf(detail, row.mailboxId))
    // 会話は古い順に並べる (サーバーの応答と同じ)。
    .sort(
      (a, b) =>
        Date.parse(a.receivedAt) - Date.parse(b.receivedAt) ||
        a.id.localeCompare(b.id),
    );
  threadMemo.set(key, thread, false);
  return thread;
}

/** 本文から、会話の中の 1 通の形を作る。 */
function threadMessageOf(
  detail: MessageDetail,
  mailboxId: string,
): ThreadMessage {
  return {
    id: detail.id,
    accountId: detail.accountId,
    threadKey: detail.threadKey,
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
    mailboxIds: [mailboxId],
  };
}

/** 端末の保存先にある本文を読み出す (サーバーには問い合わせない)。 */
export async function loadSavedMessage(
  id: string,
): Promise<MessageDetail | null> {
  const memo = detailMemo.get(id);
  if (memo) return memo.value;
  const active = await current();
  if (!active?.known.has(id)) return null;
  const saved = await active.cache.loadDetail(id).catch(() => undefined);
  if (!saved) return null;
  detailMemo.set(id, saved, false);
  return saved;
}

export function getMessage(
  id: string,
  signal?: AbortSignal,
): Promise<MessageDetail> {
  return inflight.run(
    `message|${id}`,
    () =>
      withCache(
        () =>
          api.getMessage(id).then((detail) => {
            detailMemo.set(id, detail, true);
            return detail;
          }),
        async (cache, detail) => {
          await cache.saveDetail(detail);
          (await current())?.known.add(detail.id);
        },
        (cache) => cache.loadDetail(id),
      ),
    signal,
  );
}

export function getThread(
  id: string,
  mailboxId: string | null,
  signal?: AbortSignal,
): Promise<ThreadMessage[]> {
  const key = threadKeyOf(id, mailboxId);
  return inflight.run(
    `thread|${key}`,
    () =>
      withCache(
        () =>
          api.getThread(id, mailboxId).then((thread) => {
            threadMemo.set(key, thread, true);
            return thread;
          }),
        (cache, thread) => cache.saveThread(id, mailboxId, thread),
        (cache) => cache.loadThread(id, mailboxId),
      ),
    signal,
  );
}

/** 先に用意しておく本文の数 (会話の新しいものから)。 */
const WARM_DETAILS = 3;

/**
 * 開きそうなメール (カーソルを載せた行、押し始めた行、前後の行) の会話と本文を、
 * 開く前にメモリーへ用意しておく。端末に保存してあればそこから読み、
 * 無ければ (network が true のとき) サーバーから取得する。
 */
export function warmConversation(row: ConversationRow, network = true): void {
  const key = threadKeyOf(row.id, row.mailboxId);
  const memo = threadMemo.get(key);
  // 端末にあるものをまず用意し、サーバーからの取得は並行して進める。
  if (!memo) void loadSavedThread(row.id, row.mailboxId, row).catch(() => {});
  if (network && isOnline() && !isFresh(memo)) {
    void getThread(row.id, row.mailboxId).catch(() => {});
  }
  // 会話の行の threadMessageIds は、このフォルダにある分。新しいものほど開かれやすい。
  const ids = [row.id, ...row.threadMessageIds.filter((id) => id !== row.id)];
  for (const id of ids.slice(0, WARM_DETAILS)) {
    if (detailMemo.get(id)) continue;
    void loadSavedMessage(id)
      .then((saved) => {
        if (!saved?.bodyFetchedAt && network && isOnline()) {
          return getMessage(id);
        }
      })
      .catch(() => {});
  }
}

/** 画面で行った操作を、控えにも反映する。 */
function applyActionToMemo(action: MessageAction): void {
  const ids = new Set(action.messageIds);
  if (action.action === "set_flags") {
    const patch = <T extends { id: string; seen: boolean; flagged: boolean }>(
      item: T,
    ): T =>
      ids.has(item.id)
        ? {
            ...item,
            seen: action.seen ?? item.seen,
            flagged: action.flagged ?? item.flagged,
          }
        : item;
    threadMemo.update((thread) =>
      thread.some((item) => ids.has(item.id)) ? thread.map(patch) : thread,
    );
    detailMemo.update((detail) => patch(detail));
    return;
  }
  // 移動や削除は、会話の中身が変わる。次に開いたときにサーバーから取り直す。
  threadMemo.update((thread) =>
    thread.some((item) => ids.has(item.id)) ? null : thread,
  );
}

/** 受信したメールの添付ファイル。一度取得した小さなファイルは、オフラインでも開ける。 */
export function fetchAttachment(
  messageId: string,
  attachmentId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  return withCache(
    () => api.fetchAttachment(messageId, attachmentId, signal),
    (cache, blob) => cache.saveAttachment(messageId, attachmentId, blob),
    (cache) => cache.loadAttachment(messageId, attachmentId),
  );
}

/** 画面で行った操作を、端末に保存してある内容にも反映する。 */
export function applyActionLocally(action: MessageAction): void {
  applyActionToMemo(action);
  void current()
    .then((active) => active?.cache.applyAction(action))
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// 本文の先読み
// ---------------------------------------------------------------------------

const prefetchQueue: string[] = [];
let prefetching = false;
/** 先読みの間隔。画面の操作による通信を待たせないよう、少しずつ進める。 */
const PREFETCH_GAP_MS = 150;

/**
 * 一覧に出たメールの本文を、開く前に端末へ保存しておく (オフラインで読めるようにする)。
 * すでに保存してあるものは取得しない。
 */
function prefetchBodies(ids: string[]): void {
  for (const id of ids) {
    if (!prefetchQueue.includes(id)) prefetchQueue.push(id);
  }
  if (prefetching) return;
  prefetching = true;
  void (async () => {
    try {
      for (;;) {
        const active = await current();
        const id = prefetchQueue.shift();
        if (!active || id === undefined) return;
        if (active.known.has(id)) continue;
        // 取得できなかったものも、この画面を開いている間は繰り返さない。
        active.known.add(id);
        try {
          const detail = await api.getMessage(id);
          await active.cache.saveDetail(detail);
        } catch (error) {
          if (error instanceof NetworkError) {
            // 届かない間は続けても無駄なので、次に一覧を取得できたときにやり直す。
            active.known.delete(id);
            prefetchQueue.length = 0;
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, PREFETCH_GAP_MS));
      }
    } finally {
      prefetching = false;
    }
  })();
}

// ---------------------------------------------------------------------------
// 送信
// ---------------------------------------------------------------------------

/**
 * メールを送信する。サーバーに届かなければ端末で預かり、届くようになったら自動で送る。
 * 戻り値は、すぐにサーバーへ渡せたか (sent)、端末で預かったか (queued)。
 */
export async function sendMailOrQueue(
  input: SendMailInput,
  attachments: UploadedAttachment[],
): Promise<"sent" | "queued"> {
  const outbox = (await current())?.outbox;
  const canQueue = outbox?.available === true;
  if (canQueue && !isOnline()) {
    await outbox.enqueue(input, attachments);
    // 接続の判定が古いだけかもしれないので、すぐに 1 回は送ってみる。
    void outbox.flush();
    return "queued";
  }
  try {
    await api.sendMail(input);
    return "sent";
  } catch (error) {
    if (!(error instanceof NetworkError) || !canQueue) throw error;
    await outbox.enqueue(input, attachments);
    void outbox.flush();
    return "queued";
  }
}

/** 端末で預かっているメールを取り除く。送っている最中で取り除けなければ false。 */
export async function removeQueuedSend(id: string): Promise<boolean> {
  const outbox = (await current())?.outbox;
  return outbox ? outbox.remove(id) : false;
}

/** 預かっていたメールをサーバーへ渡せたときに呼ばれる処理を登録する。 */
export function onQueuedSendDelivered(listener: () => void): () => void {
  let unsubscribe: (() => void) | null = null;
  let cancelled = false;
  void current().then((active) => {
    if (!cancelled && active) unsubscribe = active.outbox.onSent(listener);
  });
  return () => {
    cancelled = true;
    unsubscribe?.();
  };
}

function subscribeQueued(listener: () => void): () => void {
  queuedListeners.add(listener);
  return () => queuedListeners.delete(listener);
}

const noQueued: QueuedSend[] = [];

/** 端末で預かっている、接続後に送るメール (古い順)。 */
export function useQueuedSends(): QueuedSend[] {
  return useSyncExternalStore(
    subscribeQueued,
    () => queued,
    () => noQueued,
  );
}
