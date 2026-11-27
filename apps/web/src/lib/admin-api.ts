/**
 * 管理画面 (/admin) とサーバーの通信。
 * 管理者は一般の利用者とは別のアカウントなので、セッショントークンも、2 段階認証・パスキーの
 * 途中の値も、一般の利用者のもの (lib/api.ts) とは別の場所に置く。
 */

import { ApiError, NetworkError, type Passkey } from "@/lib/api";
import { AUTH_STATE_HEADER, createAuthStateStore } from "@/lib/auth-state";
import type { PasskeyApi } from "@/lib/passkey";
import { apiUrl } from "@/lib/server-url";

const TOKEN_KEY = "orbit.admin.session-token";
const authState = createAuthStateStore("orbit.admin.auth-state.v1");

const AUTH_PREFIX = "/v1/admin/auth/";

export function getAdminToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setAdminToken(token: string | null) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 保存できなければ、再読み込みでログアウトになる。
  }
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** 管理者のセッション切れ (401) を受けたときに呼ばれる処理を登録する。 */
export function onAdminUnauthorized(
  listener: UnauthorizedListener,
): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** false にすると 401 でもログアウト扱いにしない (ログイン API 用)。 */
  handle401?: boolean;
};

async function adminFetch(
  path: string,
  { method = "GET", body, signal, handle401 = true }: RequestOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = getAdminToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const isAuthCall = path.startsWith(AUTH_PREFIX);
  if (isAuthCall) {
    const state = authState.header();
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
    throw new NetworkError();
  }
  if (isAuthCall) authState.absorb(response.headers.get(AUTH_STATE_HEADER));
  if (response.status === 401 && handle401) {
    setAdminToken(null);
    for (const listener of unauthorizedListeners) listener();
  }
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const record = (data ?? {}) as Record<string, unknown>;
    const code =
      typeof record.error === "string"
        ? record.error
        : typeof record.code === "string"
          ? record.code
          : null;
    throw new ApiError(response.status, code, data);
  }
  return response;
}

async function adminJson<T>(
  path: string,
  options?: RequestOptions,
): Promise<T> {
  const response = await adminFetch(path, options);
  return (await response.json()) as T;
}

/** 応答のヘッダーで返る署名付きの値を、Bearer トークンとして保存する。 */
function adoptToken(response: Response): boolean {
  const token = response.headers.get("set-auth-token");
  if (!token) return false;
  setAdminToken(token);
  return true;
}

// ---------------------------------------------------------------------------
// 初回セットアップとログイン
// ---------------------------------------------------------------------------

/** 管理者が 1 人もいない (初回セットアップの画面を出せる) か。 */
export async function fetchAdminSetup(
  signal?: AbortSignal,
): Promise<{ needed: boolean }> {
  return adminJson("/v1/admin/setup", { signal, handle401: false });
}

/** サーバーのログに出た合言葉を使って、最初の管理者を作る。 */
export async function setupAdmin(input: {
  code: string;
  username: string;
  name: string;
  password: string;
}): Promise<{ username: string }> {
  return adminJson("/v1/admin/setup", {
    method: "POST",
    body: input,
    handle401: false,
  });
}

export type AdminSignInResult = "signed-in" | "two-factor";

export async function adminSignIn(
  username: string,
  password: string,
): Promise<AdminSignInResult> {
  const response = await adminFetch(`${AUTH_PREFIX}sign-in/username`, {
    method: "POST",
    body: { username, password },
    handle401: false,
  });
  const data = (await response.json().catch(() => null)) as {
    twoFactorRedirect?: boolean;
  } | null;
  if (data?.twoFactorRedirect) return "two-factor";
  if (!adoptToken(response)) {
    throw new ApiError(response.status, "token_missing", null);
  }
  return "signed-in";
}

export async function adminVerifyTwoFactor(
  kind: "totp" | "backup",
  code: string,
  trustDevice: boolean,
): Promise<void> {
  const response = await adminFetch(
    kind === "totp"
      ? `${AUTH_PREFIX}two-factor/verify-totp`
      : `${AUTH_PREFIX}two-factor/verify-backup-code`,
    { method: "POST", body: { code, trustDevice }, handle401: false },
  );
  if (!adoptToken(response)) {
    throw new ApiError(response.status, "token_missing", null);
  }
}

export async function adminSignOut(): Promise<void> {
  try {
    await adminFetch(`${AUTH_PREFIX}sign-out`, {
      method: "POST",
      body: {},
      handle401: false,
    });
  } catch {
    // サーバーに届かなくても、この端末からはログアウトする。
  } finally {
    setAdminToken(null);
  }
}

export type Admin = { id: string; username: string; name: string };

export async function fetchAdminMe(signal?: AbortSignal): Promise<Admin> {
  const { admin } = await adminJson<{ admin: Admin }>("/v1/admin/me", {
    signal,
  });
  return admin;
}

// ---------------------------------------------------------------------------
// 利用者・招待・管理者
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
  twoFactorEnabled: boolean;
  createdAt: string;
};

export type AdminMember = {
  id: string;
  username: string;
  name: string;
  twoFactorEnabled: boolean;
  createdAt: string;
};

export async function listInvitations(
  signal?: AbortSignal,
): Promise<Invitation[]> {
  const { invitations } = await adminJson<{ invitations: Invitation[] }>(
    "/v1/admin/invitations",
    { signal },
  );
  return invitations;
}

/** 招待を発行する。リンク (url) は、この応答でしか受け取れない。 */
export async function createInvitation(input: {
  label: string | null;
  email: string | null;
  expiresInDays: number;
}): Promise<{ invitation: Invitation; url: string }> {
  return adminJson("/v1/admin/invitations", { method: "POST", body: input });
}

export async function deleteInvitation(id: string): Promise<void> {
  await adminFetch(`/v1/admin/invitations/${id}`, { method: "DELETE" });
}

export async function listMembers(signal?: AbortSignal): Promise<Member[]> {
  const { users } = await adminJson<{ users: Member[] }>("/v1/admin/users", {
    signal,
  });
  return users;
}

export async function listAdmins(signal?: AbortSignal): Promise<AdminMember[]> {
  const { admins } = await adminJson<{ admins: AdminMember[] }>(
    "/v1/admin/admins",
    { signal },
  );
  return admins;
}

// ---------------------------------------------------------------------------
// 自分のログインの設定 (パスワード、2 段階認証、パスキー)
// ---------------------------------------------------------------------------

export async function fetchAdminSecurity(signal?: AbortSignal): Promise<{
  twoFactorEnabled: boolean;
  passkeyCount: number;
  mail: boolean;
}> {
  const data = await adminJson<{
    twoFactorEnabled: boolean;
    passkeyCount: number;
  }>("/v1/admin/security", { signal });
  return { ...data, mail: false };
}

export async function changeAdminName(name: string): Promise<string> {
  const data = await adminJson<{ name: string }>("/v1/admin/security/name", {
    method: "PUT",
    body: { name },
  });
  return data.name;
}

export async function changeAdminPassword(
  currentPassword: string,
  newPassword: string,
  revokeOtherSessions: boolean,
): Promise<void> {
  const response = await adminFetch(`${AUTH_PREFIX}change-password`, {
    method: "POST",
    body: { currentPassword, newPassword, revokeOtherSessions },
    handle401: false,
  });
  adoptToken(response);
}

export async function startAdminTwoFactor(
  password: string,
): Promise<{ totpURI: string; backupCodes: string[] }> {
  return adminJson(`${AUTH_PREFIX}two-factor/enable`, {
    method: "POST",
    body: { password },
    handle401: false,
  });
}

export async function confirmAdminTwoFactor(code: string): Promise<void> {
  const response = await adminFetch(`${AUTH_PREFIX}two-factor/verify-totp`, {
    method: "POST",
    body: { code },
    handle401: false,
  });
  // 有効にすると、サーバーがセッションを作り直す。
  adoptToken(response);
}

export async function disableAdminTwoFactor(password: string): Promise<void> {
  const response = await adminFetch(`${AUTH_PREFIX}two-factor/disable`, {
    method: "POST",
    body: { password },
    handle401: false,
  });
  adoptToken(response);
}

export async function regenerateAdminBackupCodes(
  password: string,
): Promise<string[]> {
  const { backupCodes } = await adminJson<{ backupCodes: string[] }>(
    `${AUTH_PREFIX}two-factor/generate-backup-codes`,
    { method: "POST", body: { password }, handle401: false },
  );
  return backupCodes;
}

export async function listAdminPasskeys(
  signal?: AbortSignal,
): Promise<Passkey[]> {
  return adminJson<Passkey[]>(`${AUTH_PREFIX}passkey/list-user-passkeys`, {
    signal,
  });
}

export async function renameAdminPasskey(
  id: string,
  name: string,
): Promise<void> {
  await adminFetch(`${AUTH_PREFIX}passkey/update-passkey`, {
    method: "POST",
    body: { id, name },
  });
}

export async function deleteAdminPasskey(id: string): Promise<void> {
  await adminFetch(`${AUTH_PREFIX}passkey/delete-passkey`, {
    method: "POST",
    body: { id },
  });
}

/** パスキーの登録・ログインで使う、管理者の API。 */
export const adminPasskeyApi: PasskeyApi = {
  registerOptions: () =>
    adminJson<unknown>(`${AUTH_PREFIX}passkey/generate-register-options`, {
      handle401: false,
    }),
  register: (response, name) =>
    adminJson<Passkey>(`${AUTH_PREFIX}passkey/verify-registration`, {
      method: "POST",
      body: { response, name },
      handle401: false,
    }),
  signInOptions: () =>
    adminJson<unknown>(`${AUTH_PREFIX}passkey/generate-authenticate-options`, {
      handle401: false,
    }),
  signIn: async (response) => {
    const result = await adminFetch(
      `${AUTH_PREFIX}passkey/verify-authentication`,
      { method: "POST", body: { response }, handle401: false },
    );
    if (!adoptToken(result)) {
      throw new ApiError(result.status, "token_missing", null);
    }
  },
};
