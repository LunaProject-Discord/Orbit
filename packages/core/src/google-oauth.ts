import { createHash, randomBytes } from "node:crypto";
import { decryptText, encryptText } from "./credentials.js";
import { fetchOrExplain } from "./network-error.js";

/**
 * Google の OAuth2。認可コードフロー + PKCE で、Gmail の IMAP / SMTP に
 * XOAUTH2 でログインするためのトークンを取得する。
 */

export type GoogleOAuthConfig = {
  clientId: string;
  clientSecret: string;
};

/** IMAP / SMTP に XOAUTH2 でログインするための権限。Gmail のメール全体が対象になる。 */
export const GMAIL_SCOPE = "https://mail.google.com/";

/** 要求する権限。openid と email は、ログインしたアカウントのメールアドレスを知るために使う。 */
export const GOOGLE_SCOPES = ["openid", "email", GMAIL_SCOPE];

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

const STATE_CONTEXT = "google-oauth-state";
const STATE_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

/** 環境変数から設定を読む。クライアント ID かシークレットが無ければ null (機能を無効にする)。 */
export function loadGoogleOAuthConfig(
  env: Record<string, string | undefined>,
): GoogleOAuthConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

type StatePayload = { userId: string; verifier: string; expiresAt: number };

/**
 * ログイン画面の URL を作る。state には利用者 ID と PKCE の検証値を暗号化して入れ、
 * サーバー側に状態を持たずに、戻ってきた要求が同じ利用者のものかを確かめる。
 */
export function createGoogleAuthorizeUrl(options: {
  config: GoogleOAuthConfig;
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
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: options.config.clientId,
    response_type: "code",
    redirect_uri: options.redirectUri,
    scope: GOOGLE_SCOPES.join(" "),
    state: encryptText(
      JSON.stringify(payload),
      options.encryptionKey,
      STATE_CONTEXT,
    ),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    // リフレッシュトークンを受け取るために必要。
    access_type: "offline",
    // consent を付けないと、2 回目以降のログインではリフレッシュトークンが返らない。
    // select_account は、複数の Google アカウントを追加できるよう毎回選ばせるため。
    prompt: "select_account consent",
    ...(options.loginHint ? { login_hint: options.loginHint } : {}),
  }).toString();
  return url.toString();
}

/**
 * 戻ってきた state を検証し、PKCE の検証値を取り出す。
 * 改ざん、期限切れ、別の利用者が始めたものは null。
 */
export function openGoogleState(options: {
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

export type GoogleTokens = {
  accessToken: string;
  /** 更新では通常返らない。返らなければ、それまでの値を使い続ける。 */
  refreshToken: string | null;
  /** アクセストークンの期限 (ミリ秒の時刻)。 */
  expiresAt: number;
  /** 利用者が実際に許可した権限 (空白区切り)。 */
  scope: string;
};

export class GoogleOAuthError extends Error {
  constructor(
    /** invalid_grant など、Google が返すエラーコード。 */
    readonly code: string,
    description: string,
    readonly status: number,
  ) {
    super(description || code);
    this.name = "GoogleOAuthError";
  }

  /**
   * 利用者にもう一度ログインしてもらう必要があるか。
   * invalid_grant は、リフレッシュトークンの取り消しや期限切れ
   * (公開ステータスが「テスト中」のアプリでは 7 日) で返る。
   */
  get needsReauth() {
    return this.code === "invalid_grant";
  }
}

/** 利用者が Gmail へのアクセスを許可したか (同意画面では権限ごとに外せる)。 */
export function hasGmailScope(scope: string): boolean {
  return scope.split(/\s+/).includes(GMAIL_SCOPE);
}

type Fetch = typeof fetch;

async function requestToken(
  config: GoogleOAuthConfig,
  params: Record<string, string>,
  fetchFn: Fetch,
): Promise<GoogleTokens> {
  const response = await fetchOrExplain(
    fetchFn,
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...params,
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    "Google のログインサーバー",
  );
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !body.access_token) {
    throw new GoogleOAuthError(
      body.error ?? "token_request_failed",
      body.error_description ?? "",
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
export function exchangeGoogleCode(
  config: GoogleOAuthConfig,
  options: { code: string; verifier: string; redirectUri: string },
  fetchFn: Fetch = fetch,
): Promise<GoogleTokens> {
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
export function refreshGoogleToken(
  config: GoogleOAuthConfig,
  refreshToken: string,
  fetchFn: Fetch = fetch,
): Promise<GoogleTokens> {
  return requestToken(
    config,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    fetchFn,
  );
}

/** ログインしたアカウントのメールアドレスを取得する。 */
export async function fetchGoogleEmail(
  accessToken: string,
  fetchFn: Fetch = fetch,
): Promise<string> {
  const response = await fetchOrExplain(
    fetchFn,
    USERINFO_URL,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    "Google",
  );
  const body = (await response.json().catch(() => ({}))) as {
    email?: string;
  };
  if (!response.ok || !body.email) {
    throw new Error(
      `Google アカウントの情報を取得できませんでした (HTTP ${response.status})。`,
    );
  }
  return body.email;
}

/** アクセストークンを期限のどれだけ前に取り直すか。 */
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * リフレッシュトークンからアクセストークンを取得し、期限が近づくまで使い回す。
 * 同期ワーカーが IMAP と SMTP に接続するたびに呼ぶ。
 */
export class GoogleAccessTokenSource {
  private current: { token: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;

  constructor(
    private readonly config: GoogleOAuthConfig,
    private readonly refreshToken: string,
    private readonly fetchFn: Fetch = fetch,
  ) {}

  /** 有効なアクセストークンを返す。失敗したら GoogleOAuthError などを投げる。 */
  get(now = Date.now()): Promise<string> {
    if (this.current && this.current.expiresAt - REFRESH_MARGIN_MS > now) {
      return Promise.resolve(this.current.token);
    }
    // 同期用と送信用の接続が同時に求めても、取得は 1 回にまとめる。
    this.pending ??= refreshGoogleToken(
      this.config,
      this.refreshToken,
      this.fetchFn,
    )
      .then((tokens) => {
        this.current = {
          token: tokens.accessToken,
          expiresAt: tokens.expiresAt,
        };
        return tokens.accessToken;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  /**
   * サーバーに拒否されたトークンを捨てる。次の get() で取り直す。
   * 取得した直後のトークンが拒否されたのなら false を返す (取り直しても通らない)。
   */
  invalidate(now = Date.now()): boolean {
    const current = this.current;
    this.current = null;
    if (!current) return false;
    // アクセストークンの寿命は 1 時間。残りがほぼ満額なら、取得した直後。
    return current.expiresAt - now < 3600_000 - 2 * 60_000;
  }
}
