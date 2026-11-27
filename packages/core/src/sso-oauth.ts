import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { decryptText, encryptText } from "./credentials.js";
import { fetchOrExplain } from "./network-error.js";

/**
 * Orbit 自体のログインに使う外部の IdP (OAuth2 / OpenID Connect) とのやり取り。
 * 認可コードフロー (+ PKCE) でアクセストークンを受け取り、プロフィール (userinfo) を読む。
 *
 * ID トークンの署名は確かめない。代わりに、トークンとプロフィールはサーバーから IdP へ
 * 直接 (TLS で) 取りに行く。Mailcow のように OpenID Connect ではない OAuth2 の IdP にも
 * 同じ手順で対応するため。
 */

export type SsoTokenAuthMethod = "client_secret_basic" | "client_secret_post";

export type SsoEndpoints = {
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
};

export type SsoClient = {
  clientId: string;
  clientSecret: string;
  scopes: string[];
  tokenAuthMethod: SsoTokenAuthMethod;
  usePkce: boolean;
  subjectClaim: string;
  emailClaim: string;
  nameClaim: string;
  endpoints: SsoEndpoints;
};

/** IdP から読み取った利用者。 */
export type SsoProfile = {
  /** IdP の中で変わらない利用者 ID。 */
  subject: string;
  /** 小文字にそろえたメールアドレス。返らなければ null。 */
  email: string | null;
  name: string | null;
};

export type SsoErrorCode =
  | "discovery_failed"
  | "token_failed"
  | "profile_failed"
  | "no_subject";

export class SsoError extends Error {
  constructor(
    readonly code: SsoErrorCode,
    detail: string,
  ) {
    super(detail || code);
    this.name = "SsoError";
  }
}

const REQUEST_TIMEOUT_MS = 15_000;
const STATE_CONTEXT = "sso-login-state";
/** IdP でのログインに使える時間。 */
export const SSO_STATE_TTL_MS = 10 * 60_000;
/** プロフィールの値として受け付ける長さの上限。 */
const MAX_CLAIM_LENGTH = 320;

type Fetch = typeof fetch;

/**
 * 管理者が入力した IdP の URL が使えるか。https だけ (開発用に http を許すときを除く)。
 * 認証情報入りの URL は受け付けない。
 */
export function isUsableSsoUrl(
  value: string,
  options: { allowHttp: boolean },
): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return options.allowHttp && url.protocol === "http:";
}

/** OpenID Connect の設定 (…/.well-known/openid-configuration) から 3 つの URL を読む。 */
export async function discoverSsoEndpoints(
  discoveryUrl: string,
  options: { allowHttp: boolean; fetchFn?: Fetch },
): Promise<SsoEndpoints> {
  const response = await fetchOrExplain(
    options.fetchFn ?? fetch,
    discoveryUrl,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    "IdP の設定の URL",
  );
  if (!response.ok) {
    throw new SsoError(
      "discovery_failed",
      `IdP の設定を読めませんでした (HTTP ${response.status})`,
    );
  }
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const pick = (key: string) => {
    const value = body?.[key];
    return typeof value === "string" && isUsableSsoUrl(value, options)
      ? value
      : null;
  };
  const authorizationUrl = pick("authorization_endpoint");
  const tokenUrl = pick("token_endpoint");
  const userInfoUrl = pick("userinfo_endpoint");
  if (!authorizationUrl || !tokenUrl || !userInfoUrl) {
    throw new SsoError(
      "discovery_failed",
      "IdP の設定に、認可・トークン・プロフィールの URL がそろっていません",
    );
  }
  return { authorizationUrl, tokenUrl, userInfoUrl };
}

/** ログインを始めた端末が預かる合言葉 (binding) の指紋。state に入れて、戻ってきた端末と照合する。 */
export function ssoBindingHash(binding: string): string {
  return createHash("sha256").update(binding, "utf8").digest("base64url");
}

export type SsoState = {
  /** sso_providers の ID。 */
  provider: string;
  /** PKCE の検証値。PKCE を使わない IdP では null。 */
  verifier: string | null;
  /** 端末が預かる合言葉の指紋 (ssoBindingHash)。 */
  binding: string;
  /** login はログイン、link はログイン中の利用者に IdP を結び付ける。 */
  mode: "login" | "link";
  /** link のときの利用者。 */
  userId?: string;
  expiresAt: number;
};

/** state を暗号化する。サーバーに状態を持たずに、戻ってきた要求を確かめるため。 */
export function sealSsoState(state: SsoState, key: Buffer): string {
  return encryptText(JSON.stringify(state), key, STATE_CONTEXT);
}

/**
 * 戻ってきた state を開き、端末の合言葉と照合する。改ざん・期限切れ・別の端末で始めたものは null。
 */
export function openSsoState(
  value: string,
  binding: string,
  key: Buffer,
  now = Date.now(),
): SsoState | null {
  let state: SsoState;
  try {
    state = JSON.parse(decryptText(value, key, STATE_CONTEXT)) as SsoState;
  } catch {
    return null;
  }
  if (
    typeof state.provider !== "string" ||
    typeof state.binding !== "string" ||
    typeof state.expiresAt !== "number" ||
    (state.mode !== "login" && state.mode !== "link")
  ) {
    return null;
  }
  if (state.expiresAt < now) return null;
  const expected = Buffer.from(state.binding);
  const actual = Buffer.from(ssoBindingHash(binding));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  return state;
}

/** PKCE の検証値と、IdP に渡す値 (S256)。 */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

/** IdP のログイン画面の URL。 */
export function buildSsoAuthorizeUrl(options: {
  client: Pick<SsoClient, "clientId" | "scopes" | "endpoints">;
  redirectUri: string;
  state: string;
  /** PKCE の challenge。使わないなら null。 */
  challenge: string | null;
}): string {
  const url = new URL(options.client.endpoints.authorizationUrl);
  // 設定の URL に元から付いているクエリは残す。
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.client.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  if (options.client.scopes.length > 0) {
    url.searchParams.set("scope", options.client.scopes.join(" "));
  }
  url.searchParams.set("state", options.state);
  if (options.challenge) {
    url.searchParams.set("code_challenge", options.challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

/** client_secret_basic の値 (RFC 6749 2.3.1 に従い、URL エンコードしてから base64)。 */
function basicCredentials(clientId: string, clientSecret: string): string {
  const encode = (value: string) =>
    encodeURIComponent(value).replace(/%20/g, "+");
  return Buffer.from(`${encode(clientId)}:${encode(clientSecret)}`).toString(
    "base64",
  );
}

/** 認可コードをアクセストークンに換える。 */
export async function exchangeSsoCode(options: {
  client: SsoClient;
  code: string;
  redirectUri: string;
  verifier: string | null;
  fetchFn?: Fetch;
}): Promise<{ accessToken: string }> {
  const { client } = options;
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
  });
  if (options.verifier) params.set("code_verifier", options.verifier);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (client.tokenAuthMethod === "client_secret_basic") {
    headers.Authorization = `Basic ${basicCredentials(client.clientId, client.clientSecret)}`;
  } else {
    params.set("client_id", client.clientId);
    params.set("client_secret", client.clientSecret);
  }
  const response = await fetchOrExplain(
    options.fetchFn ?? fetch,
    client.endpoints.tokenUrl,
    {
      method: "POST",
      headers,
      body: params.toString(),
      // 別の場所へ転送されたら、シークレットを送らずに失敗にする。
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    "IdP のトークンの URL",
  );
  const body = (await response.json().catch(() => null)) as {
    access_token?: unknown;
    error?: unknown;
    error_description?: unknown;
  } | null;
  if (!response.ok || typeof body?.access_token !== "string") {
    const code = typeof body?.error === "string" ? body.error : "";
    const description =
      typeof body?.error_description === "string" ? body.error_description : "";
    throw new SsoError(
      "token_failed",
      [`HTTP ${response.status}`, code, description].filter(Boolean).join(" "),
    );
  }
  return { accessToken: body.access_token };
}

/** プロフィールから項目を読む。"a.b" のように書くと入れ子の項目を読む。 */
export function readSsoClaim(
  profile: Record<string, unknown>,
  path: string,
): unknown {
  let value: unknown = profile;
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    if (!Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function claimText(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > MAX_CLAIM_LENGTH) return null;
  // 制御文字は受け付けない。
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を弾くための正規表現
  if (/[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

/** メールアドレスらしい形か (細かい検証はしない)。 */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** プロフィール (userinfo) を読み、利用者 ID・メールアドレス・名前を取り出す。 */
export function parseSsoProfile(
  body: Record<string, unknown>,
  claims: Pick<SsoClient, "subjectClaim" | "emailClaim" | "nameClaim">,
): SsoProfile {
  const subject = claimText(readSsoClaim(body, claims.subjectClaim));
  if (!subject) {
    throw new SsoError(
      "no_subject",
      `プロフィールに利用者 ID (${claims.subjectClaim}) がありません`,
    );
  }
  const email = claimText(readSsoClaim(body, claims.emailClaim));
  const name = claimText(readSsoClaim(body, claims.nameClaim));
  return {
    subject,
    email: email && looksLikeEmail(email) ? email.toLowerCase() : null,
    name,
  };
}

/** アクセストークンでプロフィールを読む。 */
export async function fetchSsoProfile(options: {
  client: SsoClient;
  accessToken: string;
  fetchFn?: Fetch;
}): Promise<SsoProfile> {
  const response = await fetchOrExplain(
    options.fetchFn ?? fetch,
    options.client.endpoints.userInfoUrl,
    {
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        Accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    "IdP のプロフィールの URL",
  );
  const body = (await response.json().catch(() => null)) as unknown;
  if (
    !response.ok ||
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    throw new SsoError(
      "profile_failed",
      `プロフィールを読めませんでした (HTTP ${response.status})`,
    );
  }
  return parseSsoProfile(body as Record<string, unknown>, options.client);
}

/** メールアドレスのドメインが許可されているか。domains が空なら、どのドメインでもよい。 */
export function ssoEmailDomainAllowed(
  email: string,
  domains: readonly string[],
): boolean {
  if (domains.length === 0) return true;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return domains.some((allowed) => allowed.toLowerCase() === domain);
}
