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
    xhr.onerror = () => reject(new NetworkError());
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
