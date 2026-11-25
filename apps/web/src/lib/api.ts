/**
 * API サーバーとの通信。
 * Web / Tauri / Capacitor で同じ方式にするため Cookie は使わず、
 * セッショントークンを localStorage に置いて Authorization ヘッダーで送る。
 */

import type { AccountIconName } from "@/lib/account-icons";
import {
  AUTH_STATE_HEADER,
  absorbAuthState,
  authStateHeader,
  clearAuthState,
} from "@/lib/auth-state";
import type { DateStyle } from "@/lib/format";
import { isDefaultSort, type ListSort } from "@/lib/list-sort";
import { usesAppOAuth } from "@/lib/native/oauth";
import { reportReachable } from "@/lib/offline/network";
import { apiUrl } from "@/lib/server-url";

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

/**
 * ほかの Orbit のアプリから引き継いだログインを使う (スマホアプリのみ、lib/native/shared-config.ts)。
 * 有効かどうかは、このあとの利用者の確認 (fetchMe) で決まる。
 */
export function adoptSessionToken(token: string) {
  setToken(token);
}

/** この端末のログイン情報を消す (接続先サーバーを替えたときなど)。サーバーには知らせない。 */
export function forgetSession() {
  setToken(null);
  clearAuthState();
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
  // ログインまわりの呼び出しでは、手順の途中でサーバーから預かった値を返す (lib/auth-state.ts)。
  const isAuthCall = path.startsWith("/v1/auth/");
  if (isAuthCall) {
    const state = authStateHeader();
    if (state) headers[AUTH_STATE_HEADER] = state;
  }

  let response: Response;
  try {
    response = await fetch(`${apiUrl()}${path}`, {
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
  if (isAuthCall) absorbAuthState(response.headers.get(AUTH_STATE_HEADER));

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

export type User = {
  id: string;
  email: string;
  name: string;
  /** 管理者か (招待リンクを発行できる)。 */
  isAdmin?: boolean;
};

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
  /** 安全な再ネゴシエーションに対応していない古いサーバーへの接続を許している。 */
  allowLegacyTls: boolean;
  /**
   * 受信トレイ以外のフォルダの変化をすぐ受け取るために足す接続の本数の上限。
   * null は自動。IMAP のアカウントでだけ使う。
   */
  pushConnections: number | null;
  /** このアカウントに届いた新着メールを通知する。 */
  notifyNewMail: boolean;
  username: string;
  status: AccountStatus;
  lastError: string | null;
  /** このアカウントから送るメールの署名 (書式付き)。無ければ null。 */
  signatureHtml: string | null;
  /** サイドバーでの表示順 (小さいほど上)。並び替えていなければ null。 */
  sortOrder: number | null;
  /** 見分けるための色 ("#rrggbb")。null なら追加した順に割り当てる。 */
  color: string | null;
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
  /** 古い TLS のサーバーへの接続を許す (接続先を手で設定したときだけ効く)。 */
  allowLegacyTls?: boolean;
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
  /** 会話のキー。端末に保存してあった古い内容には無いことがある。 */
  threadKey?: string;
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
  /**
   * 代理で送った人 (Sender ヘッダー)、メーリングリストの ID、配信停止の URL (https / mailto)。
   * 端末に保存してあった古い内容には無いことがある。
   */
  sender?: Address[];
  listId?: string | null;
  listUnsubscribe?: string[];
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

/** アプリ内で付けられる役割。"none" は、役割なし (ふつうのフォルダ) として扱う。 */
export type MailboxRoleOverride =
  | "sent"
  | "drafts"
  | "archive"
  | "junk"
  | "trash"
  | "none";

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
  /**
   * メールサーバーが知らせてきた役割。specialUse は、これに利用者の上書き (roleOverride) を
   * 当てはめた「実際に使う役割」。
   */
  detectedSpecialUse?: Mailbox["specialUse"];
  /** アプリ内で付けた役割。"none" は役割なしとして扱う。付けていなければ null。 */
  roleOverride?: MailboxRoleOverride | null;
  /** アプリ内での表示名・アイコン (Lucide の名前か絵文字)・色 ("#rrggbb")。付けていなければ null。 */
  displayName?: string | null;
  icon?: string | null;
  color?: string | null;
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
  /** 本文の冒頭。分からないときと、まとめた通知では無い。 */
  preview?: string;
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

/** ログインの結果。two-factor は、続けて 2 段階認証のコードが要る。 */
export type SignInResult = "signed-in" | "two-factor";

/** 応答のヘッダーで返る署名付きの値を、Bearer トークンとして保存する。 */
function adoptToken(response: Response): boolean {
  const token = response.headers.get("set-auth-token");
  if (!token) return false;
  setToken(token);
  return true;
}

export async function signIn(
  email: string,
  password: string,
): Promise<SignInResult> {
  const response = await apiFetch("/v1/auth/sign-in/email", {
    method: "POST",
    body: { email, password },
    handle401: false,
  });
  const data = (await response.json().catch(() => null)) as {
    twoFactorRedirect?: boolean;
  } | null;
  // 2 段階認証が有効なら、ここではまだログインにならない
  // (このとき返るトークンは、サーバーがすぐに無効にしたセッションのものなので使わない)。
  if (data?.twoFactorRedirect) return "two-factor";
  // JSON の token ではなく、ヘッダーで返る署名付きの値を Bearer トークンとして使う。
  if (!adoptToken(response)) {
    throw new ApiError(response.status, "token_missing", null);
  }
  return "signed-in";
}

/**
 * 2 段階認証のコードを確かめてログインを終える。
 * kind は、認証アプリの 6 桁のコード (totp) か、バックアップコード (backup)。
 * trustDevice を付けると、この端末では 30 日間コードの入力を省略する。
 */
export async function verifyTwoFactorSignIn(
  kind: "totp" | "backup",
  code: string,
  trustDevice: boolean,
): Promise<void> {
  const response = await apiFetch(
    kind === "totp"
      ? "/v1/auth/two-factor/verify-totp"
      : "/v1/auth/two-factor/verify-backup-code",
    { method: "POST", body: { code, trustDevice }, handle401: false },
  );
  if (!adoptToken(response)) {
    throw new ApiError(response.status, "token_missing", null);
  }
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
// 招待 (管理者がリンクを発行し、開いた人が自分で利用者を作る)
// ---------------------------------------------------------------------------

export type Invitation = {
  id: string;
  /** 誰に渡したかの覚え書き。 */
  label: string | null;
  /** 指定されていれば、このメールアドレスでしか登録できない。 */
  email: string | null;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
  usedByEmail: string | null;
  usedByName: string | null;
};

export type Member = {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  createdAt: string;
};

/** 発行した招待と、このサーバーの利用者 (管理者だけが呼べる)。 */
export async function listInvitations(
  signal?: AbortSignal,
): Promise<{ invitations: Invitation[]; users: Member[] }> {
  return apiJson("/v1/invitations", { signal });
}

/** 招待を発行する。リンク (url) は、この応答でしか受け取れない。 */
export async function createInvitation(input: {
  label: string | null;
  email: string | null;
  expiresInDays: number;
}): Promise<{ invitation: Invitation; url: string }> {
  return apiJson("/v1/invitations", { method: "POST", body: input });
}

export async function deleteInvitation(id: string): Promise<void> {
  await apiFetch(`/v1/invitations/${id}`, { method: "DELETE" });
}

/** 招待リンクが使えるかを確かめる。使えなければ ApiError (404)。 */
export async function lookupInvitation(
  token: string,
  signal?: AbortSignal,
): Promise<{ email: string | null; expiresAt: string }> {
  return apiJson(`/v1/invitations/lookup?token=${encodeURIComponent(token)}`, {
    signal,
    handle401: false,
  });
}

/** 招待リンクから利用者を作る。このあと、通常の手順でログインする。 */
export async function acceptInvitation(input: {
  token: string;
  name: string;
  email: string;
  password: string;
}): Promise<void> {
  await apiFetch("/v1/invitations/accept", {
    method: "POST",
    body: input,
    handle401: false,
  });
}

// ---------------------------------------------------------------------------
// ログインまわりの設定 (パスワード、メールアドレス、2 段階認証、パスキー)
// ---------------------------------------------------------------------------

/** サーバーが、利用者へメールを送れるか (パスワードの再設定とメールアドレスの変更が使えるか)。 */
export async function fetchAuthFeatures(
  signal?: AbortSignal,
): Promise<{ mail: boolean }> {
  return apiJson<{ mail: boolean }>("/v1/auth-features", {
    signal,
    handle401: false,
  });
}

export type SecurityStatus = {
  email: string;
  twoFactorEnabled: boolean;
  passkeyCount: number;
  /** サーバーが利用者へメールを送れるか。 */
  mail: boolean;
};

export async function fetchSecurity(
  signal?: AbortSignal,
): Promise<SecurityStatus> {
  return apiJson<SecurityStatus>("/v1/security", { signal });
}

/** 自分の名前 (表示名) を変える。保存された名前 (前後の空白を除いたもの) が返る。 */
export async function changeName(name: string): Promise<string> {
  const data = await apiJson<{ name: string }>("/v1/security/name", {
    method: "PUT",
    body: { name },
  });
  return data.name;
}

/** 再設定のリンクをメールで送ってもらう。登録の無いアドレスでも、同じ応答が返る。 */
export async function requestPasswordReset(email: string): Promise<void> {
  await apiFetch("/v1/auth/request-password-reset", {
    method: "POST",
    body: { email },
    handle401: false,
  });
}

/** メールのリンクに付いていた合言葉で、新しいパスワードを設定する。 */
export async function resetPassword(
  token: string,
  newPassword: string,
): Promise<void> {
  await apiFetch("/v1/auth/reset-password", {
    method: "POST",
    body: { token, newPassword },
    handle401: false,
  });
}

/**
 * パスワードを変更する。revokeOtherSessions を付けると、ほかの端末をログアウトさせる
 * (この端末は、新しく発行されたセッションに切り替わる)。
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
  revokeOtherSessions: boolean,
): Promise<void> {
  const response = await apiFetch("/v1/auth/change-password", {
    method: "POST",
    body: { currentPassword, newPassword, revokeOtherSessions },
    handle401: false,
  });
  adoptToken(response);
}

/** ログインに使うメールアドレスの変更を申し込む (新しいアドレスへ確認のメールが届く)。 */
export async function requestEmailChange(
  newEmail: string,
  password: string,
): Promise<void> {
  await apiFetch("/v1/security/email", {
    method: "POST",
    body: { newEmail, password },
  });
}

export type TwoFactorSetup = {
  /** 認証アプリに読み込ませる otpauth:// の URI。 */
  totpURI: string;
  backupCodes: string[];
};

/** 2 段階認証の登録を始める。コードを 1 度確かめる (confirmTwoFactor) まで、有効にはならない。 */
export async function startTwoFactor(
  password: string,
): Promise<TwoFactorSetup> {
  return apiJson<TwoFactorSetup>("/v1/auth/two-factor/enable", {
    method: "POST",
    body: { password },
    handle401: false,
  });
}

/** 認証アプリのコードを確かめて、2 段階認証を有効にする。 */
export async function confirmTwoFactor(code: string): Promise<void> {
  const response = await apiFetch("/v1/auth/two-factor/verify-totp", {
    method: "POST",
    body: { code },
    handle401: false,
  });
  // 有効にすると、サーバーがセッションを作り直す。
  adoptToken(response);
}

export async function disableTwoFactor(password: string): Promise<void> {
  const response = await apiFetch("/v1/auth/two-factor/disable", {
    method: "POST",
    body: { password },
    handle401: false,
  });
  adoptToken(response);
}

/** バックアップコードを再発行 (前のコードは使えなくなる)。 */
export async function regenerateBackupCodes(
  password: string,
): Promise<string[]> {
  const { backupCodes } = await apiJson<{ backupCodes: string[] }>(
    "/v1/auth/two-factor/generate-backup-codes",
    { method: "POST", body: { password }, handle401: false },
  );
  return backupCodes;
}

export type Passkey = {
  id: string;
  name: string | null;
  /** singleDevice (その端末だけ) か multiDevice (端末の間で同期されるパスキー)。 */
  deviceType: string;
  backedUp: boolean;
  createdAt: string | null;
  aaguid: string | null;
};

export async function listPasskeys(signal?: AbortSignal): Promise<Passkey[]> {
  return apiJson<Passkey[]>("/v1/auth/passkey/list-user-passkeys", { signal });
}

/** パスキーの登録で、ブラウザーに渡す内容をサーバーからもらう。 */
export async function passkeyRegisterOptions(): Promise<unknown> {
  return apiJson<unknown>("/v1/auth/passkey/generate-register-options", {
    handle401: false,
  });
}

export async function passkeyRegister(
  response: unknown,
  name: string,
): Promise<Passkey> {
  return apiJson<Passkey>("/v1/auth/passkey/verify-registration", {
    method: "POST",
    body: { response, name },
    handle401: false,
  });
}

export async function renamePasskey(id: string, name: string): Promise<void> {
  await apiFetch("/v1/auth/passkey/update-passkey", {
    method: "POST",
    body: { id, name },
  });
}

export async function deletePasskey(id: string): Promise<void> {
  await apiFetch("/v1/auth/passkey/delete-passkey", {
    method: "POST",
    body: { id },
  });
}

/** パスキーでのログインで、ブラウザーに渡す内容をサーバーからもらう。 */
export async function passkeySignInOptions(): Promise<unknown> {
  return apiJson<unknown>("/v1/auth/passkey/generate-authenticate-options", {
    handle401: false,
  });
}

/** ブラウザーがパスキーで作った応答を確かめて、ログインする。 */
export async function passkeySignIn(response: unknown): Promise<void> {
  const result = await apiFetch("/v1/auth/passkey/verify-authentication", {
    method: "POST",
    body: { response },
    handle401: false,
  });
  if (!adoptToken(result)) {
    throw new ApiError(result.status, "token_missing", null);
  }
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
    {
      method: "POST",
      body: {
        ...(accountId ? { accountId } : {}),
        // スマホアプリとデスクトップ版では、ログイン後に Web 版のページからアプリへ戻してもらう。
        ...(usesAppOAuth() ? { app: true } : {}),
      },
    },
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

/**
 * 連絡先 (宛先のアドレス) ごと、会話ごとの署名。アカウントの署名より優先して使う。
 * 優先順位は lib/signatures.ts の resolveSignature を参照。
 */
export type SignatureRule = {
  id: string;
  kind: "contact" | "thread";
  /** 会話のあるアカウント。連絡先の決まりでは null (すべてのアカウントに効く)。 */
  accountId: string | null;
  /** 連絡先は小文字のメールアドレス、会話は会話のキー (threadKey)。 */
  key: string;
  /** 一覧に出す名前 (連絡先の名前、会話の件名)。 */
  label: string | null;
  /** 使う署名 (書式付き)。null は「署名を付けない」。 */
  signatureHtml: string | null;
  updatedAt: string;
};

/** 宛先の候補にする相手 (送受信したメールの相手)。 */
export type Contact = {
  /** 小文字のメールアドレス。 */
  address: string;
  /** いちばん新しいメールで使われていた名前。 */
  name: string | null;
  /** このアドレスへ送った回数 (宛先・Cc・Bcc)。 */
  sentCount: number;
  /** このアドレスから受け取った回数。 */
  receivedCount: number;
  /** 最後にやり取りした日時。 */
  lastAt: string | null;
  /** 並べる順の目安 (送った回数を重く、新しいほど重い)。 */
  score: number;
};

/**
 * 宛先の候補を、よくやり取りする順に取得する。q を渡すと名前かアドレスの一部で絞り込む。
 * 画面では lib/contacts.ts の useContactSuggestions を使う (全件を手元に持って絞り込む)。
 */
export async function getContacts(
  { q, limit }: { q?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<Contact[]> {
  const params = new URLSearchParams();
  if (q?.trim()) params.set("q", q.trim());
  if (limit !== undefined) params.set("limit", String(limit));
  const query = params.toString();
  const { contacts } = await apiJson<{ contacts: Contact[] }>(
    `/v1/contacts${query ? `?${query}` : ""}`,
    { signal },
  );
  return contacts;
}

export async function listSignatureRules(
  signal?: AbortSignal,
): Promise<SignatureRule[]> {
  const { rules } = await apiJson<{ rules: SignatureRule[] }>(
    "/v1/signatures",
    { signal },
  );
  return rules;
}

/** 連絡先の署名を決める。signatureHtml が null なら、その相手には署名を付けない。 */
export async function saveContactSignature(input: {
  address: string;
  label: string | null;
  signatureHtml: string | null;
}): Promise<SignatureRule> {
  const { rule } = await apiJson<{ rule: SignatureRule }>(
    "/v1/signatures/contact",
    { method: "PUT", body: input },
  );
  return rule;
}

/** 会話の署名を決める。signatureHtml が null なら、その会話では署名を付けない。 */
export async function saveThreadSignature(input: {
  accountId: string;
  threadKey: string;
  label: string | null;
  signatureHtml: string | null;
}): Promise<SignatureRule> {
  const { rule } = await apiJson<{ rule: SignatureRule }>(
    "/v1/signatures/thread",
    { method: "PUT", body: input },
  );
  return rule;
}

/** 連絡先や会話の署名の決まりを消す (1 つ下の優先順位の署名に戻る)。 */
export async function deleteSignatureRule(id: string): Promise<void> {
  await apiJson(`/v1/signatures/${id}`, { method: "DELETE" });
}

/** アカウントの表示名、色、アイコン、TLS の設定を変える。指定した項目だけが変わる。 */
export async function updateAccount(
  id: string,
  patch: {
    displayName?: string | null;
    color?: string | null;
    icon?: AccountIconName | null;
    allowLegacyTls?: boolean;
    pushConnections?: number | null;
    notifyNewMail?: boolean;
  },
): Promise<Account> {
  const { account } = await apiJson<{ account: Account }>(
    `/v1/accounts/${id}`,
    { method: "PATCH", body: patch },
  );
  return account;
}

export type ServerSecurity = "ssl" | "starttls" | "plain";

/** 自動で見つかった受信 / 送信サーバー。 */
export type DiscoveredServer = {
  host: string;
  port: number;
  security: ServerSecurity;
  username: string;
  /** password は通常のパスワード認証、oauth2 はサービスのログイン画面が要る。 */
  auth: "password" | "oauth2" | "other";
};

export type DiscoveredSettings = {
  /** 見つけた場所。 */
  source:
    | "preset"
    | "autoconfig"
    | "well-known"
    | "ispdb"
    | "mx"
    | "autodiscover"
    | "srv";
  provider: Account["provider"];
  imap: DiscoveredServer;
  smtp: DiscoveredServer;
};

/** メールアドレスのドメインから、IMAP / SMTP の設定を探す。見つからなければ null。 */
export async function discoverAccountSettings(
  email: string,
): Promise<DiscoveredSettings | null> {
  const { settings } = await apiJson<{ settings: DiscoveredSettings | null }>(
    "/v1/accounts/discover",
    { method: "POST", body: { email } },
  );
  return settings;
}

export type AccountServerInput = {
  imap: ServerSettings;
  smtp: ServerSettings;
  username: string;
  /** 省くと保存済みのパスワードを使う。 */
  password?: string;
  allowLegacyTls?: boolean;
};

export type ServerCheck =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "auth_failed"
        | "connection_failed"
        | "legacy_tls_required"
        | "host_not_found"
        | "host_not_allowed";
      detail?: string;
    };

export type ServerCheckResult = {
  ok: boolean;
  imap: ServerCheck;
  smtp: ServerCheck;
};

/** 接続先の変更を保存せずに、受信と送信へログインできるかを確かめる。 */
export async function testAccountServer(
  id: string,
  input: AccountServerInput,
): Promise<ServerCheckResult> {
  return apiJson<ServerCheckResult>(`/v1/accounts/${id}/server/test`, {
    method: "POST",
    body: input,
  });
}

/**
 * 接続先を変える。受信と送信の両方へログインできたときだけ保存される。
 * 確かめられなければ、結果を持った ServerCheckError を投げる。
 */
export async function updateAccountServer(
  id: string,
  input: AccountServerInput,
): Promise<Account> {
  try {
    const { account } = await apiJson<{ account: Account }>(
      `/v1/accounts/${id}/server`,
      { method: "PUT", body: input },
    );
    return account;
  } catch (error) {
    if (error instanceof ApiError && error.code === "verification_failed") {
      throw new ServerCheckError(error.body as ServerCheckResult);
    }
    throw error;
  }
}

export class ServerCheckError extends Error {
  constructor(readonly result: ServerCheckResult) {
    super("verification_failed");
    this.name = "ServerCheckError";
  }
}

export async function deleteAccount(id: string): Promise<void> {
  await apiFetch(`/v1/accounts/${id}`, { method: "DELETE" });
}

/** 一覧の並び順を問い合わせに加える。新しい順 (標準) なら何も付けない。 */
function setSortQuery(query: URLSearchParams, sort: ListSort | undefined) {
  if (!sort || isDefaultSort(sort)) return;
  query.set("sort", sort.key);
  query.set("order", sort.order);
}

export async function listMessages(
  params: {
    accountId?: string | null;
    /** 省略すると受信トレイ。 */
    mailboxId?: string | null;
    cursor?: string | null;
    limit?: number;
    /** 並び順。省略すると新しい順。 */
    sort?: ListSort;
  },
  signal?: AbortSignal,
): Promise<MessagePage> {
  const query = new URLSearchParams({ limit: String(params.limit ?? 50) });
  if (params.accountId) query.set("accountId", params.accountId);
  if (params.mailboxId) query.set("mailboxId", params.mailboxId);
  if (params.cursor) query.set("cursor", params.cursor);
  setSortQuery(query, params.sort);
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
    /** scope が folder のときに探す統合フォルダ (指定すると mailboxId より優先)。 */
    unifiedId?: string | null;
    cursor?: string | null;
    limit?: number;
    /** 並び順。省略すると新しい順。 */
    sort?: ListSort;
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
  if (params.unifiedId) query.set("unifiedId", params.unifiedId);
  if (params.cursor) query.set("cursor", params.cursor);
  setSortQuery(query, params.sort);
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

/** 統合フォルダが集めるフォルダの役割。 */
export type UnifiedRole =
  | "inbox"
  | "sent"
  | "drafts"
  | "archive"
  | "junk"
  | "trash";

/** 統合フォルダが集めるメールの場所。 */
export type UnifiedScope = {
  /** すべてのフォルダ (ごみ箱と迷惑メールを除く)。true なら下の 2 つは見ない。 */
  all: boolean;
  /** 全アカウントの、この役割のフォルダ。 */
  roles: UnifiedRole[];
  /** 個別に選んだフォルダ。 */
  mailboxIds: string[];
};

/** 統合フォルダに並べるメールの条件 (指定したものすべてに当てはまるメール)。 */
export type UnifiedFilters = {
  unread: boolean;
  flagged: boolean;
  hasAttachment: boolean;
  from: string;
  to: string;
  subject: string;
  /** 件名・差出人・宛先・本文のどこかに含む文字 (検索欄と同じ書き方)。 */
  text: string;
  /** 受信してからこの日数以内。null なら期間を問わない。 */
  withinDays: number | null;
};

/** 利用者が作った統合フォルダ。 */
export type UnifiedFolder = {
  id: string;
  name: string;
  /** アイコンの名前か絵文字。null なら既定のアイコン。 */
  icon: string | null;
  /** アイコンの色 ("#rrggbb")。null なら色を付けない。 */
  color: string | null;
  scope: UnifiedScope;
  filters: UnifiedFilters;
  createdAt: string;
  unreadCount: number;
};

export type UnifiedFolderInput = Pick<
  UnifiedFolder,
  "name" | "icon" | "color" | "scope" | "filters"
>;

/**
 * サイドバー上部の項目の並び順と、隠している項目。項目は、初めからあるものの名前
 * (inbox / starred / drafts / outgoing) か、統合フォルダの ID。
 */
export type SidebarLayout = { order: string[]; hidden: string[] };

/** 初めからある項目に付けた見た目。null は初期の設定のまま。 */
export type BuiltinStyle = {
  name: string | null;
  icon: string | null;
  color: string | null;
};

/**
 * サイドバーのカテゴリ (利用者が作る、アカウントや統合フォルダのまとまり)。
 * items は中に入れた項目 (初めからある項目の名前、統合フォルダの ID、アカウントの ID)。
 * 中での順番は、項目そのものの並び順に従う。
 */
export type SidebarCategory = { id: string; name: string; items: string[] };

export type UnifiedState = {
  folders: UnifiedFolder[];
  layout: SidebarLayout;
  /** 初めからある項目 (inbox など) に付けた名前・アイコン・色。変えていない項目は載らない。 */
  builtins: Record<string, BuiltinStyle>;
  /** サイドバーのカテゴリ (上から順)。 */
  categories: SidebarCategory[];
};

/** 初めからある項目の名前・アイコン・色を保存する。すべて null なら初期の設定に戻る。 */
export async function saveBuiltinStyle(
  view: string,
  style: BuiltinStyle,
): Promise<Record<string, BuiltinStyle>> {
  const { builtins } = await apiJson<{
    builtins: Record<string, BuiltinStyle>;
  }>(`/v1/unified/builtins/${view}`, { method: "PUT", body: style });
  return builtins;
}

/** 一覧の行を左右にスワイプしたときの操作。 */
export type SwipeAction =
  | "none"
  | "toggle_read"
  | "star"
  | "archive"
  | "delete"
  | "junk"
  | "move";

/** 左へスワイプしたときと、右へスワイプしたときの操作。どの端末でも同じになる。 */
export type SwipeSettings = { left: SwipeAction; right: SwipeAction };

/** 新着メールの通知に付けられるボタン。 */
export type NotificationAction =
  | "read"
  | "star"
  | "archive"
  | "delete"
  | "junk";

/** どの端末でも同じにする設定。 */
export type SharedSettings = {
  swipe: SwipeSettings;
  /** 通知に付けるボタン (出す順)。 */
  notificationActions: NotificationAction[];
  /** 日付と時刻の形式。保存していなければ null (標準の値)。 */
  dateFormat: DateStyle | null;
};

/** どの端末でも同じにする設定を取得する。 */
export async function getSettings(
  signal?: AbortSignal,
): Promise<SharedSettings> {
  return apiJson<SharedSettings>("/v1/settings", { signal });
}

export async function saveNotificationActions(
  actions: NotificationAction[],
): Promise<void> {
  await apiFetch("/v1/settings/notification-actions", {
    method: "PUT",
    body: { actions },
  });
}

export async function saveDateFormat(dateFormat: DateStyle): Promise<void> {
  await apiFetch("/v1/settings/date-format", {
    method: "PUT",
    body: dateFormat,
  });
}

export async function saveSwipeSettings(swipe: SwipeSettings): Promise<void> {
  await apiFetch("/v1/settings/swipe", { method: "PUT", body: swipe });
}

export async function listUnified(signal?: AbortSignal): Promise<UnifiedState> {
  return apiJson<UnifiedState>("/v1/unified", { signal });
}

export async function createUnifiedFolder(
  input: UnifiedFolderInput,
): Promise<UnifiedFolder> {
  const { folder } = await apiJson<{
    folder: Omit<UnifiedFolder, "unreadCount">;
  }>("/v1/unified", { method: "POST", body: input });
  return { ...folder, unreadCount: 0 };
}

export async function updateUnifiedFolder(
  id: string,
  input: Partial<UnifiedFolderInput>,
): Promise<void> {
  await apiFetch(`/v1/unified/${id}`, { method: "PATCH", body: input });
}

export async function deleteUnifiedFolder(id: string): Promise<void> {
  await apiFetch(`/v1/unified/${id}`, { method: "DELETE" });
}

export async function saveSidebarLayout(layout: SidebarLayout): Promise<void> {
  await apiFetch("/v1/unified/layout", { method: "PUT", body: layout });
}

/** サイドバーのカテゴリをまとめて保存する。 */
export async function saveSidebarCategories(
  categories: SidebarCategory[],
): Promise<void> {
  await apiFetch("/v1/unified/categories", {
    method: "PUT",
    body: { categories },
  });
}

/** 統合フォルダのメールの一覧。フォルダの一覧と同じ形で、会話ごとに 1 行。 */
export async function listUnifiedMessages(
  id: string,
  params: { cursor?: string | null; limit?: number; sort?: ListSort },
  signal?: AbortSignal,
): Promise<MessagePage> {
  const query = new URLSearchParams({ limit: String(params.limit ?? 50) });
  if (params.cursor) query.set("cursor", params.cursor);
  setSortQuery(query, params.sort);
  return apiJson<MessagePage>(`/v1/unified/${id}/messages?${query}`, {
    signal,
  });
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

/** フォルダの、アプリ内での役割・表示名・アイコン・色。null の項目は上書きしない。 */
export type MailboxOverrides = {
  role: MailboxRoleOverride | null;
  displayName: string | null;
  icon: string | null;
  color: string | null;
};

/**
 * フォルダの役割・表示名・アイコン・色を、アプリ内でだけ上書きする
 * (メールサーバー上のフォルダは変わらない。どの端末でも同じ内容になる)。
 */
export async function saveMailboxOverrides(
  mailboxId: string,
  overrides: MailboxOverrides,
): Promise<void> {
  await apiFetch(`/v1/mailboxes/${mailboxId}/overrides`, {
    method: "PUT",
    body: overrides,
  });
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

/** サーバーがスマホアプリへ通知 (FCM) を送れるか。古いサーバーは答えないので false。 */
export async function getNativePushAvailable(): Promise<boolean> {
  const { fcm } = await apiJson<{ fcm?: boolean }>("/v1/push/config");
  return fcm === true;
}

/** この端末 (スマホアプリ) を、新着メールの通知の送り先として登録する。 */
export async function savePushDevice(device: {
  platform: "android";
  token: string;
  name?: string;
}): Promise<void> {
  await apiFetch("/v1/push/devices", { method: "POST", body: device });
}

export async function deletePushDevice(token: string): Promise<void> {
  await apiFetch("/v1/push/devices", {
    method: "DELETE",
    body: { token },
    handle401: false,
  });
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
    xhr.open("POST", `${apiUrl()}/v1/attachments`);
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
