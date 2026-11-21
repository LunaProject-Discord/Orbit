/**
 * API サーバーとの通信。
 * Web / Tauri / Capacitor で同じ方式にするため Cookie は使わず、
 * セッショントークンを localStorage に置いて Authorization ヘッダーで送る。
 */

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
    throw new NetworkError();
  }

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
  createdAt: string;
};

export type ServerSettings = { host: string; port: number; secure: boolean };

export type CreateAccountInput = {
  email: string;
  displayName?: string;
  provider: Account["provider"];
  imap: ServerSettings;
  smtp: ServerSettings;
  username: string;
  password: string;
};

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
  hasAttachments: boolean;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
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
 * Microsoft のログイン画面の URL を取得する。
 * accountId を渡すと、そのアカウントの再ログインになる。
 */
export async function startMicrosoftLogin(accountId?: string): Promise<string> {
  const { url } = await apiJson<{ url: string }>(
    "/v1/accounts/microsoft/authorize",
    { method: "POST", body: accountId ? { accountId } : {} },
  );
  return url;
}

/** Microsoft のログイン画面から戻ってきた code と state を渡して、アカウントを追加する。 */
export async function completeMicrosoftLogin(
  code: string,
  state: string,
): Promise<Account> {
  const { account } = await apiJson<{ account: Account }>(
    "/v1/accounts/microsoft/complete",
    { method: "POST", body: { code, state } },
  );
  return account;
}

export async function deleteAccount(id: string): Promise<void> {
  await apiFetch(`/v1/accounts/${id}`, { method: "DELETE" });
}

export async function listMessages(
  params: { accountId?: string | null; cursor?: string | null; limit?: number },
  signal?: AbortSignal,
): Promise<MessagePage> {
  const query = new URLSearchParams({ limit: String(params.limit ?? 50) });
  if (params.accountId) query.set("accountId", params.accountId);
  if (params.cursor) query.set("cursor", params.cursor);
  return apiJson<MessagePage>(`/v1/messages?${query}`, { signal });
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

/** 操作をサーバーへ送る。サーバーはすぐに反映して応答し、メールサーバーへは後から反映する。 */
export async function sendMessageAction(action: MessageAction): Promise<void> {
  await apiFetch("/v1/messages/actions", { method: "POST", body: action });
}
