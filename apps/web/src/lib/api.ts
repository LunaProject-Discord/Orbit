/**
 * API サーバーとの通信。
 * Web / Tauri / Capacitor で同じ方式にするため Cookie は使わず、
 * セッショントークンを localStorage に置いて Authorization ヘッダーで送る。
 */

import type { AccountColorName } from "@/lib/account-colors";
import type { AccountIconName } from "@/lib/account-icons";
import { reportReachable } from "@/lib/offline/network";

export const API_URL = (
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"
).replace(/\/+$/, "");

const TOKEN_KEY = "mail.session-token";

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setToken(token: string | null) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // localStorage が使えない環境では保存を諦める (その場合は再読み込みでログアウトになる)。
  }
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** セッション切れ (401) を受けたときに呼ばれる処理を登録する。 */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

function handleUnauthorized() {
  setToken(null);
  for (const listener of unauthorizedListeners) listener();
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** API が返すエラーコード (auth_failed など)。取れなければ null。 */
    readonly code: string | null,
    readonly body: unknown,
  ) {
    super(code ?? `HTTP ${status}`);
    this.name = "ApiError";
  }
}

/** サーバーに届かなかった (オフライン、CORS、サーバー停止など)。 */
export class NetworkError extends Error {
  constructor() {
    super("network_error");
    this.name = "NetworkError";
  }
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** false にすると 401 でもログアウト扱いにしない (ログイン API 用)。 */
  handle401?: boolean;
};

export async function apiFetch(
  path: string,
  { method = "GET", body, signal, handle401 = true }: RequestOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    reportReachable(false);
    throw new NetworkError();
  }
  reportReachable(true);

  if (response.status === 401 && handle401) {
    handleUnauthorized();
  }
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    throw new ApiError(response.status, errorCodeOf(data), data);
  }
  return response;
}

function errorCodeOf(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  // 自前のルートは { error: "code" }、Better Auth は { code: "CODE" } を返す。
  if (typeof record.error === "string") return record.error;
  if (typeof record.code === "string") return record.code;
  return null;
}

async function apiJson<T>(path: string, options?: RequestOptions): Promise<T> {
  const response = await apiFetch(path, options);
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

export type User = { id: string; email: string; name: string };

export type Address = { name?: string; address: string };

export type AccountStatus = "active" | "auth_required" | "error" | "disabled";

export type Account = {
  id: string;
  email: string;
  displayName: string | null;
  provider: "gmail" | "microsoft" | "icloud" | "generic";
  authType: "oauth2" | "password";
  /** imap は IMAP / SMTP、graph は Microsoft Graph (Exchange Online、Outlook.com)。 */
  protocol: "imap" | "graph";
  /** IMAP / SMTP の接続先。protocol が graph のときは null。 */
  imapHost: string | null;
  imapPort: number | null;
  imapSecure: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  username: string;
  status: AccountStatus;
  lastError: string | null;
  /** このアカウントから送るメールの署名 (書式付き)。無ければ null。 */
  signatureHtml: string | null;
  /** サイドバーでの表示順 (小さいほど上)。並び替えていなければ null。 */
  sortOrder: number | null;
  /** 画面でアカウントを見分ける色の名前。選んでいなければ null (並び順から決まる)。 */
  color: AccountColorName | null;
  /** 画面でアカウントに付けるアイコンの名前。選んでいなければ null (色の点を出す)。 */
  icon: AccountIconName | null;
  createdAt: string;
};

export type ServerSettings = { host: string; port: number; secure: boolean };

export type CreateAccountInput = {
  email: string;
  displayName?: string;
  provider: Account["provider"];
  /** 接続先。provider が gmail か icloud なら省略でき、サーバーが決まった値を使う。 */
  imap?: ServerSettings;
  smtp?: ServerSettings;
  /** 省略するとメールアドレスを使う。 */
  username?: string;
  password: string;
};

/** ログイン画面へ移動して追加するサービス (OAuth2)。 */
export type OAuthProvider = "google" | "microsoft";

export type MessageSummary = {
  id: string;
  accountId: string;
  mailboxId: string;
  threadKey: string;
  subject: string;
  from: Address[];
  to: Address[];
  receivedAt: string;
  snippet: string;
  /** 本文をまだ取り込んでいない (フォルダの一覧でだけ入る)。 */
  bodyPending?: boolean;
  hasAttachments: boolean;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  /** 検索結果でだけ入る。語が件名にも snippet にも無いときの、本文の該当箇所。 */
  excerpt?: string | null;
  /** 会話 (スレッド) に含まれるメッセージの数。ほかのフォルダにある自分の返信なども数える。 */
  threadCount: number;
  /**
   * 会話のうち、このフォルダにあるメッセージ (このメッセージ自身を含む)。
   * 一覧の 1 行は会話 1 つを表し、既読やスターはこれらをまとめた値、操作もこれらが対象になる。
   */
  threadMessageIds: string[];
  /** 下書きフォルダにある、このアプリの下書きの控えなら、その下書きの ID。 */
  draftId?: string | null;
};

/** 会話 (スレッド) に含まれるメッセージ 1 通分。本文は含まない。 */
export type ThreadMessage = {
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
  /** このメッセージがあるフォルダ。 */
  mailboxIds: string[];
};

export type Attachment = {
  id: string;
  filename: string | null;
  contentType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
};

export type MessageDetail = {
  id: string;
  accountId: string;
  threadKey: string;
  subject: string;
  from: Address[];
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  sentAt: string | null;
  receivedAt: string;
  snippet: string;
  size: number;
  hasAttachments: boolean;
  bodyText: string | null;
  bodyHtml: string | null;
  /** 本文は後から取得される。取得前は null。 */
  bodyFetchedAt: string | null;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  attachments: Attachment[];
};

export type Mailbox = {
  id: string;
  /** 親フォルダ。最上位なら null。 */
  parentId: string | null;
  /** IMAP ではフォルダのパス、Microsoft Graph ではフォルダの ID。 */
  path: string;
  name: string;
  specialUse:
    | "inbox"
    | "sent"
    | "drafts"
    | "trash"
    | "junk"
    | "archive"
    | "all"
    | "flagged"
    | null;
  /** 同じ親を持つフォルダの中での表示順 (小さいほど上)。並び替えていなければ null。 */
  sortOrder: number | null;
};

/** フォルダ一覧用。全アカウント分をまとめて取得する。 */
export type MailboxSummary = Mailbox & {
  accountId: string;
  /** 同期が一度終わっていれば、その時刻。 */
  lastSyncedAt: string | null;
  totalCount: number;
  unreadCount: number;
};

/** メッセージへの操作。idempotencyKey は操作ごとに作る一意な ID (再送しても二重に実行されない)。 */
export type MessageAction = { idempotencyKey: string; messageIds: string[] } & (
  | { action: "set_flags"; seen?: boolean; flagged?: boolean }
  | {
      action: "move";
      /** 移動先のフォルダ。destination とどちらか一方を指定する。 */
      mailboxId?: string;
      /** 移動先を役割で指定する。 */
      destination?: "inbox" | "archive" | "trash" | "junk";
    }
  | { action: "delete" }
);

/** 送信するメール。idempotencyKey は送信ごとに作る一意な ID (再送しても二重に送られない)。 */
export type SendMailInput = {
  idempotencyKey: string;
  accountId: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  text: string;
  /** 書式付きの本文。 */
  html?: string;
  /** uploadAttachment で受け取ってもらったファイルの ID。 */
  attachmentIds?: string[];
  mode: "new" | "reply" | "forward";
  /** 返信・転送の元になったメッセージ。 */
  sourceMessageId?: string;
};

/** サーバーに受け取ってもらった、送信用の添付ファイル。 */
export type UploadedAttachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
};

/** まだ送り終えていないメール (送信待ち、送信中、失敗)。 */
export type OutgoingMail = {
  id: string;
  accountId: string;
  status: "pending" | "processing" | "failed";
  attempts: number;
  /** 失敗の理由。送信待ちで入っていれば、やり直しを待っている。 */
  lastError: string | null;
  createdAt: string;
  mode: "new" | "reply" | "forward";
  sourceMessageId: string | null;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  text: string;
  html: string | null;
  attachments: UploadedAttachment[];
};

/**
 * メールサーバーへ反映できなかった操作 (既読、スター、移動、削除、送信したメールの控えの保存)。
 * 画面には先に反映していたので、サーバーの状態に戻したうえで知らせる。
 */
export type FailedOperation = {
  id: string;
  accountId: string;
  kind:
    | "set_flags"
    | "move"
    | "delete"
    | "append"
    | "mailbox_create"
    | "mailbox_rename"
    | "mailbox_delete";
  /** 対象のメールの数 (フォルダへの操作では 1)。 */
  count: number;
  /** フォルダへの操作の対象 (作成と名前の変更では、付けようとした名前)。 */
  mailboxName: string | null;
  /** set_flags で変えようとした内容。変えなかった項目は null。 */
  seen: boolean | null;
  flagged: boolean | null;
  answered: boolean | null;
  /** move の移動先のフォルダ。 */
  destinationMailboxId: string | null;
  /** メールサーバーなどから返った失敗の理由。 */
  error: string | null;
  createdAt: string;
  failedAt: string;
};

/** 端末に出す通知 1 件分 (新着メール)。 */
export type MailNotification = {
  title: string;
  body: string;
  /** 同じ値の通知は置き換わる。 */
  tag: string;
  /** 押したときに開くメール。まとめた通知では null。 */
  messageId: string | null;
};

/** 宛先の欄 1 つ分。確定した宛先と、入力途中の文字列。 */
export type RecipientField = { list: Address[]; text: string };

/** サーバーに保存してある下書き。どの端末からも続きを書ける。 */
export type ServerDraft = {
  /** 端末が決めた ID。送信するときの idempotencyKey にもなる。 */
  id: string;
  accountId: string;
  to: RecipientField;
  cc: RecipientField;
  bcc: RecipientField;
  subject: string;
  html: string;
  /** 本文の冒頭 (一覧用)。 */
  snippet: string;
  attachments: UploadedAttachment[];
  mode: "new" | "reply" | "forward";
  sourceMessageId: string | null;
  /** 保存のたびに増える番号。 */
  revision: number;
  updatedAt: string;
};

export type SaveDraftInput = {
  accountId: string;
  to: RecipientField;
  cc: RecipientField;
  bcc: RecipientField;
  subject: string;
  html: string;
  text: string;
  attachmentIds: string[];
  mode: "new" | "reply" | "forward";
  sourceMessageId: string | null;
  /** この端末が元にした revision。まだサーバーに保存していなければ null。 */
  baseRevision: number | null;
};

export type MessagePage = {
  messages: MessageSummary[];
  nextCursor: string | null;
};

// ---------------------------------------------------------------------------
// 認証
// ---------------------------------------------------------------------------

export async function signIn(email: string, password: string): Promise<void> {
  const response = await apiFetch("/v1/auth/sign-in/email", {
    method: "POST",
    body: { email, password },
    handle401: false,
  });
  // JSON の token ではなく、ヘッダーで返る署名付きの値を Bearer トークンとして使う。
  const token = response.headers.get("set-auth-token");
  if (!token) {
    throw new ApiError(response.status, "token_missing", null);
  }
  setToken(token);
}

export async function signOut(): Promise<void> {
  try {
    await apiFetch("/v1/auth/sign-out", {
      method: "POST",
      body: {},
      handle401: false,
    });
  } catch {
    // サーバーに届かなくても、この端末からはログアウトする。
  } finally {
    setToken(null);
  }
}

export async function fetchMe(signal?: AbortSignal): Promise<User> {
  const { user } = await apiJson<{ user: User }>("/v1/me", { signal });
  return user;
}

// ---------------------------------------------------------------------------
// メールアカウントとメッセージ
// ---------------------------------------------------------------------------

export async function listAccounts(signal?: AbortSignal): Promise<Account[]> {
  const { accounts } = await apiJson<{ accounts: Account[] }>("/v1/accounts", {
    signal,
  });
  return accounts;
}

export async function createAccount(
  input: CreateAccountInput,
): Promise<Account> {
  const { account } = await apiJson<{ account: Account }>("/v1/accounts", {
    method: "POST",
    body: input,
  });
  return account;
}

/**
 * Google または Microsoft のログイン画面の URL を取得する。
 * accountId を渡すと、そのアカウントの再ログインになる。
 */
export async function startOAuthLogin(
  provider: OAuthProvider,
  accountId?: string,
): Promise<string> {
  const { url } = await apiJson<{ url: string }>(
    `/v1/accounts/${provider}/authorize`,
    { method: "POST", body: accountId ? { accountId } : {} },
  );
  return url;
}

/** ログイン画面から戻ってきた code と state を渡して、アカウントを追加する。 */
export async function completeOAuthLogin(
  provider: OAuthProvider,
  code: string,
  state: string,
): Promise<Account> {
  const { account } = await apiJson<{ account: Account }>(
    `/v1/accounts/${provider}/complete`,
    { method: "POST", body: { code, state } },
  );
  return account;
}

/**
 * アカウントのログインし直しに使うサービス。パスワードで追加したアカウントは null
 * (ログイン画面へ移動する方法では直せない)。
 */
export function oauthProviderOf(
  account: Pick<Account, "protocol" | "provider" | "authType">,
): OAuthProvider | null {
  if (account.protocol === "graph") return "microsoft";
  if (account.provider === "gmail" && account.authType === "oauth2") {
    return "google";
  }
  return null;
}

/** アカウントの署名を変える。null なら署名なしにする。 */
export async function updateAccountSignature(
  id: string,
  signatureHtml: string | null,
): Promise<Account> {
  const { account } = await apiJson<{ account: Account }>(
    `/v1/accounts/${id}`,
    { method: "PATCH", body: { signatureHtml } },
  );
  return account;
}

/** アカウントの表示名、色、アイコンを変える。指定した項目だけが変わる。 */
export async function updateAccount(
  id: string,
  patch: {
    displayName?: string | null;
    color?: AccountColorName | null;
    icon?: AccountIconName | null;
  },
): Promise<Account> {
  const { account } = await apiJson<{ account: Account }>(
    `/v1/accounts/${id}`,
    { method: "PATCH", body: patch },
  );
  return account;
}

export async function deleteAccount(id: string): Promise<void> {
  await apiFetch(`/v1/accounts/${id}`, { method: "DELETE" });
}

export async function listMessages(
  params: {
    accountId?: string | null;
    /** 省略すると受信トレイ。 */
    mailboxId?: string | null;
    cursor?: string | null;
    limit?: number;
  },
  signal?: AbortSignal,
): Promise<MessagePage> {
  const query = new URLSearchParams({ limit: String(params.limit ?? 50) });
  if (params.accountId) query.set("accountId", params.accountId);
  if (params.mailboxId) query.set("mailboxId", params.mailboxId);
  if (params.cursor) query.set("cursor", params.cursor);
  return apiJson<MessagePage>(`/v1/messages?${query}`, { signal });
}

/** 検索欄の入力以外の絞り込み条件。 */
export type SearchFilters = {
  from: string;
  to: string;
  subject: string;
  /** 期間の始まりと終わり (YYYY-MM-DD、どちらもその日を含む)。空なら指定なし。 */
  since: string;
  until: string;
  hasAttachment: boolean;
  unread: boolean;
  flagged: boolean;
};

export type SearchParams = {
  /** 検索欄の入力。from: や is:unread などの書き方も使える。 */
  text: string;
  filters: SearchFilters;
  /** all は全フォルダ (ごみ箱と迷惑メールを除く)、folder は表示中のフォルダだけ。 */
  scope: "all" | "folder";
};

export type SearchPage = MessagePage & {
  /** 一覧で目立たせる語。 */
  terms: string[];
};

/** サーバーに同期済みのメールを検索する。結果は新しい順で、続きは cursor で取得する。 */
export async function searchMessages(
  params: SearchParams & {
    accountId?: string | null;
    /** scope が folder のときに探すフォルダ。省略すると受信トレイ。 */
    mailboxId?: string | null;
    cursor?: string | null;
    limit?: number;
  },
  signal?: AbortSignal,
): Promise<SearchPage> {
  const { filters } = params;
  const query = new URLSearchParams({
    q: params.text,
    scope: params.scope,
    limit: String(params.limit ?? 50),
  });
  if (params.accountId) query.set("accountId", params.accountId);
  if (params.mailboxId) query.set("mailboxId", params.mailboxId);
  if (params.cursor) query.set("cursor", params.cursor);
  if (filters.from.trim()) query.set("from", filters.from.trim());
  if (filters.to.trim()) query.set("to", filters.to.trim());
  if (filters.subject.trim()) query.set("subject", filters.subject.trim());
  if (filters.since) query.set("since", filters.since);
  if (filters.until) query.set("until", filters.until);
  if (filters.hasAttachment) query.set("hasAttachment", "true");
  if (filters.unread) query.set("unread", "true");
  if (filters.flagged) query.set("flagged", "true");
  try {
    // 日付の条件は、この端末のタイムゾーンでの 0 時を区切りにしてもらう。
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timeZone) query.set("timeZone", timeZone);
  } catch {
    // 取得できなければ、サーバーの既定 (UTC) で区切られる。
  }
  return apiJson<SearchPage>(`/v1/messages/search?${query}`, { signal });
}

export async function getMessage(
  id: string,
  signal?: AbortSignal,
): Promise<MessageDetail> {
  const { message } = await apiJson<{ message: MessageDetail }>(
    `/v1/messages/${id}`,
    { signal },
  );
  return message;
}

/**
 * メッセージが属する会話 (スレッド) を、古い順に取得する。
 * mailboxId は表示中のフォルダ (そこにあるメッセージは、ごみ箱などでも会話に含まれる)。
 */
export async function getThread(
  id: string,
  mailboxId: string | null,
  signal?: AbortSignal,
): Promise<ThreadMessage[]> {
  const query = mailboxId ? `?mailboxId=${mailboxId}` : "";
  const { messages } = await apiJson<{ messages: ThreadMessage[] }>(
    `/v1/messages/${id}/thread${query}`,
    { signal },
  );
  return messages;
}

export async function listMailboxes(
  accountId: string,
  signal?: AbortSignal,
): Promise<Mailbox[]> {
  const { mailboxes } = await apiJson<{ mailboxes: Mailbox[] }>(
    `/v1/accounts/${accountId}/mailboxes`,
    { signal },
  );
  return mailboxes;
}

/** 全アカウントのフォルダを、未読数を付けて取得する。 */
export async function listAllMailboxes(
  signal?: AbortSignal,
): Promise<MailboxSummary[]> {
  const { mailboxes } = await apiJson<{ mailboxes: MailboxSummary[] }>(
    "/v1/mailboxes",
    { signal },
  );
  return mailboxes;
}

/** フォルダの並び順を保存する。ids は、同じ親を持つフォルダを上から順に並べたもの。 */
export async function saveMailboxOrder(mailboxIds: string[]): Promise<void> {
  await apiFetch("/v1/mailboxes/order", {
    method: "PUT",
    body: { mailboxIds },
  });
}

/**
 * フォルダを作る。メールサーバーに作ってから取り込むので、画面に出るまで少し間がある。
 * parentId が null なら最上位に作る。
 */
export async function createMailbox(
  accountId: string,
  parentId: string | null,
  name: string,
): Promise<void> {
  await apiFetch("/v1/mailboxes", {
    method: "POST",
    body: { accountId, parentId, name },
  });
}

/** フォルダの名前を変える。 */
export async function renameMailbox(
  mailboxId: string,
  name: string,
): Promise<void> {
  await apiFetch(`/v1/mailboxes/${mailboxId}`, {
    method: "PATCH",
    body: { name },
  });
}

/** フォルダを、中のメールごとメールサーバーから削除する。 */
export async function deleteMailbox(mailboxId: string): Promise<void> {
  await apiFetch(`/v1/mailboxes/${mailboxId}`, { method: "DELETE" });
}

/** 並び替えたフォルダを、既定の順に戻す。 */
export async function resetMailboxOrder(mailboxIds: string[]): Promise<void> {
  await apiFetch("/v1/mailboxes/order/reset", {
    method: "POST",
    body: { mailboxIds },
  });
}

/** フォルダの未読のメールを、すべて既読にする。 */
export async function markMailboxRead(mailboxId: string): Promise<void> {
  await apiFetch(`/v1/mailboxes/${mailboxId}/read`, { method: "POST" });
}

/** 次の定期確認を待たずに、アカウントの全フォルダをいますぐ確認させる。 */
export async function syncAccountNow(accountId: string): Promise<void> {
  await apiFetch(`/v1/accounts/${accountId}/sync`, { method: "POST" });
}

/** アカウントの並び順を保存する。 */
export async function saveAccountOrder(accountIds: string[]): Promise<void> {
  await apiFetch("/v1/accounts/order", {
    method: "PUT",
    body: { accountIds },
  });
}

/**
 * 表示中のフォルダをサーバーへ知らせる。サーバーは知らせが届いている間、
 * そのフォルダとアカウントを短い間隔で同期する。
 */
export async function sendFocus(
  accountId: string | null,
  mailboxId: string | null,
): Promise<void> {
  await apiFetch("/v1/focus", {
    method: "POST",
    body: { accountId, mailboxId },
  });
}

/**
 * 見ているメール (カーソルを載せた行、画面に見えている行) の本文を、取り込みの順番を
 * 待たずに取得するようサーバーへ頼む。取得が終わると、変更の知らせで一覧と本文が更新される。
 */
export async function prefetchBodies(
  ids: string[],
  reason: "hover" | "visible",
): Promise<void> {
  await apiFetch("/v1/messages/prefetch", {
    method: "POST",
    body: { ids, reason },
  });
}

/** 操作をサーバーへ送る。サーバーはすぐに反映して応答し、メールサーバーへは後から反映する。 */
export async function sendMessageAction(action: MessageAction): Promise<void> {
  await apiFetch("/v1/messages/actions", { method: "POST", body: action });
}

/**
 * メールを送信する。サーバーは受け付けるとすぐに応答し、実際の送信は後から行う。
 * 送信の結果は listOutgoing で確かめる (送り終えたものは一覧から消える)。
 */
export async function sendMail(input: SendMailInput): Promise<void> {
  await apiFetch("/v1/messages/send", { method: "POST", body: input });
}

export async function listOutgoing(
  signal?: AbortSignal,
): Promise<OutgoingMail[]> {
  const { outgoing } = await apiJson<{ outgoing: OutgoingMail[] }>(
    "/v1/messages/outgoing",
    { signal },
  );
  return outgoing;
}

/** 送信待ちのメールを取り消す、または失敗したメールを一覧から消す。 */
export async function deleteOutgoing(id: string): Promise<void> {
  await apiFetch(`/v1/messages/outgoing/${id}`, { method: "DELETE" });
}

export async function listFailures(
  signal?: AbortSignal,
): Promise<FailedOperation[]> {
  const { failures } = await apiJson<{ failures: FailedOperation[] }>(
    "/v1/messages/failures",
    { signal },
  );
  return failures;
}

/**
 * 失敗した操作を、もう一度メールサーバーへ反映する。
 * 対象のメールがもう無ければ、ApiError (status 410) で失敗する。
 */
export async function retryFailure(id: string): Promise<void> {
  await apiFetch(`/v1/messages/failures/${id}/retry`, { method: "POST" });
}

/** 失敗した操作を、やり直さずに一覧から消す。 */
export async function dismissFailure(id: string): Promise<void> {
  await apiFetch(`/v1/messages/failures/${id}`, { method: "DELETE" });
}

/** Web Push の公開鍵。null なら、サーバーは Web Push を送らない。 */
export async function getPushPublicKey(): Promise<string | null> {
  const { publicKey } = await apiJson<{ publicKey: string | null }>(
    "/v1/push/config",
  );
  return publicKey;
}

/** このブラウザーを、新着メールの通知 (Web Push) の送り先として登録する。 */
export async function savePushSubscription(subscription: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}): Promise<void> {
  await apiFetch("/v1/push/subscriptions", {
    method: "POST",
    body: subscription,
  });
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
  await apiFetch("/v1/push/subscriptions", {
    method: "DELETE",
    body: { endpoint },
    handle401: false,
  });
}

export async function listDrafts(signal?: AbortSignal): Promise<ServerDraft[]> {
  const { drafts } = await apiJson<{ drafts: ServerDraft[] }>("/v1/drafts", {
    signal,
  });
  return drafts;
}

/**
 * 下書きを保存する (無ければ作る)。他の端末が先に書き換えていたら 409、
 * 他の端末で送信・破棄されていたら 410 の ApiError になる。
 */
export async function saveDraft(
  id: string,
  input: SaveDraftInput,
): Promise<ServerDraft> {
  const { draft } = await apiJson<{ draft: ServerDraft }>(`/v1/drafts/${id}`, {
    method: "PUT",
    body: input,
  });
  return draft;
}

/** 下書きを破棄する。付けていたファイルもサーバーから消える。 */
export async function deleteDraft(id: string): Promise<void> {
  await apiFetch(`/v1/drafts/${id}`, { method: "DELETE" });
}

/**
 * 送信するメールに付けるファイルをサーバーへ送る。進み具合 (0〜1) を onProgress で受け取れる。
 * 戻り値の abort で中止できる (中止すると promise は AbortError で失敗する)。
 */
export function uploadAttachment(
  file: File,
  onProgress: (ratio: number) => void,
): { promise: Promise<UploadedAttachment>; abort: () => void } {
  // fetch では送信の進み具合が分からないので、XMLHttpRequest を使う。
  const xhr = new XMLHttpRequest();
  const promise = new Promise<UploadedAttachment>((resolve, reject) => {
    xhr.open("POST", `${API_URL}/v1/attachments`);
    const token = getToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader(
      "Content-Type",
      file.type || "application/octet-stream",
    );
    xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onerror = () => {
      reportReachable(false);
      reject(new NetworkError());
    };
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    xhr.onload = () => {
      const data: unknown = xhr.response;
      if (xhr.status === 401) handleUnauthorized();
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((data as { attachment: UploadedAttachment }).attachment);
      } else {
        reject(new ApiError(xhr.status, errorCodeOf(data), data));
      }
    };
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

/** 作成画面で外した添付ファイルを、サーバーからも消す。 */
export async function deleteAttachment(id: string): Promise<void> {
  await apiFetch(`/v1/attachments/${id}`, { method: "DELETE" });
}

/**
 * 受信したメールの添付ファイルの実体を取得する。
 * サーバーがまだ持っていなければ、メールサーバーから取得し終えるまで待つ。
 */
export async function fetchAttachment(
  messageId: string,
  attachmentId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await apiFetch(
    `/v1/messages/${messageId}/attachments/${attachmentId}`,
    { signal },
  );
  return response.blob();
}

/**
 * 受信したメールの添付ファイルを、送信用の添付ファイルとして複製してもらう (転送用)。
 * 戻り値は、sendMail の attachmentIds に指定できる添付ファイル。
 */
export async function forwardAttachments(
  messageId: string,
  attachmentIds: string[],
  signal?: AbortSignal,
): Promise<UploadedAttachment[]> {
  const { attachments } = await apiJson<{ attachments: UploadedAttachment[] }>(
    "/v1/attachments/forward",
    { method: "POST", body: { messageId, attachmentIds }, signal },
  );
  return attachments;
}
