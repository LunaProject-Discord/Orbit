import { createHash, randomBytes } from "node:crypto";
import { decryptText, encryptText } from "./credentials.js";

/**
 * Microsoft ID プラットフォーム (Entra ID) の OAuth2。
 * 認可コードフロー + PKCE で、Microsoft Graph 用のトークンを取得する。
 */

export type MicrosoftOAuthConfig = {
  clientId: string;
  clientSecret: string;
  /** common (組織 + 個人)、organizations、consumers、またはテナント ID。 */
  tenant: string;
};

/**
 * 要求する権限。offline_access はリフレッシュトークンの発行に必要。
 * Mail.Send は送信機能のために先に同意を取っておく (後から足すと再同意が要る)。
 */
export const MICROSOFT_SCOPES = [
  "offline_access",
  "https://graph.microsoft.com/User.Read",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
];

const STATE_CONTEXT = "microsoft-oauth-state";
const STATE_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

/** 環境変数から設定を読む。クライアント ID かシークレットが無ければ null (機能を無効にする)。 */
export function loadMicrosoftOAuthConfig(
  env: Record<string, string | undefined>,
): MicrosoftOAuthConfig | null {
  const clientId = env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = env.MICROSOFT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    tenant: env.MICROSOFT_TENANT?.trim() || "common",
  };
}

function endpoint(config: MicrosoftOAuthConfig, path: "authorize" | "token") {
  return `https://login.microsoftonline.com/${encodeURIComponent(config.tenant)}/oauth2/v2.0/${path}`;
}

type StatePayload = { userId: string; verifier: string; expiresAt: number };

/**
 * ログイン画面の URL を作る。state には利用者 ID と PKCE の検証値を暗号化して入れ、
 * サーバー側に状態を持たずに、戻ってきた要求が同じ利用者のものかを確かめる。
 */
export function createMicrosoftAuthorizeUrl(options: {
  config: MicrosoftOAuthConfig;
  redirectUri: string;
  userId: string;
  encryptionKey: Buffer;
  /** 再ログイン時など、ログイン画面に最初から入れておくメールアドレス。 */
  loginHint?: string | undefined;
  now?: number;
}): string {
  const verifier = randomBytes(32).toString("base64url");
  const payload: StatePayload = {
    userId: options.userId,
    verifier,
    expiresAt: (options.now ?? Date.now()) + STATE_TTL_MS,
  };
  const url = new URL(endpoint(options.config, "authorize"));
  url.search = new URLSearchParams({
    client_id: options.config.clientId,
    response_type: "code",
    response_mode: "query",
    redirect_uri: options.redirectUri,
    scope: MICROSOFT_SCOPES.join(" "),
    state: encryptText(
      JSON.stringify(payload),
      options.encryptionKey,
      STATE_CONTEXT,
    ),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    // 複数の Microsoft アカウントを追加できるよう、毎回アカウントを選ばせる。
    prompt: "select_account",
    ...(options.loginHint ? { login_hint: options.loginHint } : {}),
  }).toString();
  return url.toString();
}

/**
 * 戻ってきた state を検証し、PKCE の検証値を取り出す。
 * 改ざん、期限切れ、別の利用者が始めたものは null。
 */
export function openMicrosoftState(options: {
  state: string;
  userId: string;
  encryptionKey: Buffer;
  now?: number;
}): { verifier: string } | null {
  try {
    const payload = JSON.parse(
      decryptText(options.state, options.encryptionKey, STATE_CONTEXT),
    ) as StatePayload;
    if (payload.userId !== options.userId) return null;
    if (payload.expiresAt < (options.now ?? Date.now())) return null;
    return { verifier: payload.verifier };
  } catch {
    return null;
  }
}

export type MicrosoftTokens = {
  accessToken: string;
  /** 更新のたびに新しい値が返る。返らなければ、それまでの値を使い続ける。 */
  refreshToken: string | null;
  /** アクセストークンの期限 (ミリ秒の時刻)。 */
  expiresAt: number;
  scope: string;
};

export class MicrosoftOAuthError extends Error {
  constructor(
    /** invalid_grant など、Microsoft が返すエラーコード。 */
    readonly code: string,
    description: string,
    readonly status: number,
  ) {
    super(description || code);
    this.name = "MicrosoftOAuthError";
  }

  /** 利用者にもう一度ログインしてもらう必要があるか (取り消し、期限切れ、同意の撤回など)。 */
  get needsReauth() {
    return (
      this.code === "invalid_grant" ||
      this.code === "interaction_required" ||
      this.code === "consent_required"
    );
  }
}

type Fetch = typeof fetch;

async function requestToken(
  config: MicrosoftOAuthConfig,
  params: Record<string, string>,
  fetchFn: Fetch,
): Promise<MicrosoftTokens> {
  const response = await fetchFn(endpoint(config, "token"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      ...params,
    }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !body.access_token) {
    throw new MicrosoftOAuthError(
      body.error ?? "token_request_failed",
      // 説明の 2 行目以降は追跡用の ID なので、1 行目だけを使う。
      (body.error_description ?? "").split(/\r?\n/)[0] ?? "",
      response.status,
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    scope: body.scope ?? "",
  };
}

/** 認可コードをトークンに引き換える。 */
export function exchangeMicrosoftCode(
  config: MicrosoftOAuthConfig,
  options: { code: string; verifier: string; redirectUri: string },
  fetchFn: Fetch = fetch,
): Promise<MicrosoftTokens> {
  return requestToken(
    config,
    {
      grant_type: "authorization_code",
      code: options.code,
      code_verifier: options.verifier,
      redirect_uri: options.redirectUri,
    },
    fetchFn,
  );
}

/** リフレッシュトークンで新しいアクセストークンを取得する。 */
export function refreshMicrosoftToken(
  config: MicrosoftOAuthConfig,
  refreshToken: string,
  fetchFn: Fetch = fetch,
): Promise<MicrosoftTokens> {
  return requestToken(
    config,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: MICROSOFT_SCOPES.join(" "),
    },
    fetchFn,
  );
}

export type MicrosoftProfile = { email: string; displayName: string | null };

/** ログインしたアカウントのメールアドレスと表示名を Microsoft Graph から取得する。 */
export async function fetchMicrosoftProfile(
  accessToken: string,
  fetchFn: Fetch = fetch,
): Promise<MicrosoftProfile> {
  const response = await fetchFn(
    "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName",
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    mail?: string | null;
    userPrincipalName?: string | null;
    displayName?: string | null;
  };
  // メールボックスを持つアカウントは mail が入る。無い場合はサインイン名で代用する。
  const email = body.mail || body.userPrincipalName;
  if (!response.ok || !email) {
    throw new Error(
      `Microsoft アカウントの情報を取得できませんでした (HTTP ${response.status})。`,
    );
  }
  return { email, displayName: body.displayName || null };
}
