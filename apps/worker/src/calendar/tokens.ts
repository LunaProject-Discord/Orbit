import {
  decryptCredentials,
  encryptCredentials,
  GoogleAccessTokenSource,
  type GoogleOAuthConfig,
  GoogleOAuthError,
  MICROSOFT_CALENDAR_SCOPES,
  type MicrosoftOAuthConfig,
  MicrosoftOAuthError,
  refreshMicrosoftToken,
} from "@orbit/core";
import { accounts, type Database } from "@orbit/db";
import { and, eq } from "drizzle-orm";
import {
  type AccountRow,
  type CalendarAuth,
  CalendarAuthError,
} from "./provider.js";

/**
 * Microsoft のカレンダー用のトークンの更新で求める権限。メールの権限 (MICROSOFT_SCOPES) は含めない
 * (メールの同期は、今までどおりメールの権限だけで更新する)。
 */
export const MICROSOFT_CALENDAR_REFRESH_SCOPES = [
  "offline_access",
  "https://graph.microsoft.com/User.Read",
  ...MICROSOFT_CALENDAR_SCOPES,
];

/** アクセストークンは、期限のこれだけ前に取り直す。 */
const TOKEN_MARGIN_MS = 5 * 60_000;

export type CalendarAuthOptions = {
  google: GoogleOAuthConfig | null;
  microsoft: MicrosoftOAuthConfig | null;
  fetchFn?: typeof fetch;
  /**
   * 新しいリフレッシュトークンを DB に保存した (メール無しの Microsoft アカウントだけ)。
   * 同期側は自分が持つ行の credentialsEncrypted を差し替え、接続し直しにならないようにする。
   */
  onCredentialsSaved?: (credentialsEncrypted: string) => void;
};

/**
 * カレンダーの同期に使う認証を作る。設定が無いなど、続けても通らないときは CalendarAuthError を投げる。
 * - Google: アカウントごとに GoogleAccessTokenSource を作る (更新でリフレッシュトークンは通常返らない)。
 * - Microsoft: 更新のたびに DB の最新の認証情報を読み、カレンダーの権限で更新する。
 *   新しいリフレッシュトークンは、メール無し (mailEnabled=false) のときだけ保存する。
 *   メールありのときはメールの同期が自分のトークンを保存するので、こちらは書かない
 *   (credentialsEncrypted が変わると、メールの同期が接続し直すため)。
 * - パスワード (CalDAV): 復号したパスワードをそのまま使う。
 */
export function createCalendarAuth(
  db: Database,
  encryptionKey: Buffer,
  account: AccountRow,
  options: CalendarAuthOptions,
): CalendarAuth {
  const fetchFn = options.fetchFn ?? fetch;
  const credentials = decryptCredentials(
    account.credentialsEncrypted,
    encryptionKey,
    account.userId,
  );
  if (credentials.type === "password") {
    return {
      type: "password",
      username: account.username,
      password: credentials.password,
    };
  }
  if (account.provider === "gmail") {
    const config = options.google;
    if (!config) {
      throw new CalendarAuthError(
        "サーバーに Google のログイン (GOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET) が設定されていません。",
      );
    }
    const source = new GoogleAccessTokenSource(
      config,
      credentials.refreshToken,
      fetchFn,
    );
    return {
      type: "oauth2",
      async getAccessToken(force = false) {
        if (force) source.invalidate();
        try {
          return await source.get();
        } catch (error) {
          if (error instanceof GoogleOAuthError && error.needsReauth) {
            throw new CalendarAuthError(
              `Google の認証に失敗しました。再ログインが必要です: ${error.message}`,
              { needsReauth: true, cause: error },
            );
          }
          throw error;
        }
      },
    };
  }
  if (account.protocol === "graph") {
    const config = options.microsoft;
    if (!config) {
      throw new CalendarAuthError(
        "MICROSOFT_CLIENT_ID と MICROSOFT_CLIENT_SECRET が同期ワーカーに設定されていません。",
      );
    }
    return new MicrosoftCalendarTokens(
      db,
      encryptionKey,
      account.id,
      config,
      fetchFn,
      options.onCredentialsSaved,
    );
  }
  throw new CalendarAuthError(
    "このアカウントの OAuth2 では、カレンダーの同期に対応していません。",
  );
}

/** Microsoft のカレンダー用のアクセストークン。 */
class MicrosoftCalendarTokens {
  readonly type = "oauth2";
  private current: { value: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;

  constructor(
    private readonly db: Database,
    private readonly encryptionKey: Buffer,
    private readonly accountId: string,
    private readonly config: MicrosoftOAuthConfig,
    private readonly fetchFn: typeof fetch,
    private readonly onCredentialsSaved?: (
      credentialsEncrypted: string,
    ) => void,
  ) {}

  getAccessToken(force = false): Promise<string> {
    const cached = this.current;
    if (!force && cached && cached.expiresAt - TOKEN_MARGIN_MS > Date.now()) {
      return Promise.resolve(cached.value);
    }
    // 同時に複数の呼び出しが来ても、取り直しは 1 回にまとめる。
    this.pending ??= this.refresh().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async refresh(): Promise<string> {
    // メールの同期がリフレッシュトークンを入れ替えていることがあるので、毎回 DB の最新を読む。
    const [row] = await this.db
      .select({
        userId: accounts.userId,
        mailEnabled: accounts.mailEnabled,
        credentialsEncrypted: accounts.credentialsEncrypted,
      })
      .from(accounts)
      .where(eq(accounts.id, this.accountId));
    if (!row) throw new CalendarAuthError("アカウントが見つかりません。");
    const credentials = decryptCredentials(
      row.credentialsEncrypted,
      this.encryptionKey,
      row.userId,
    );
    if (credentials.type !== "oauth2") {
      throw new CalendarAuthError(
        "このアカウントには OAuth2 の認証情報がありません。",
      );
    }
    let tokens: Awaited<ReturnType<typeof refreshMicrosoftToken>>;
    try {
      tokens = await refreshMicrosoftToken(
        this.config,
        credentials.refreshToken,
        this.fetchFn,
        MICROSOFT_CALENDAR_REFRESH_SCOPES,
      );
    } catch (error) {
      if (error instanceof MicrosoftOAuthError && error.needsReauth) {
        // AADSTS65001 は、求めた権限 (カレンダー) に同意していないこと。
        const consentRequired =
          error.code === "consent_required" ||
          error.message.includes("AADSTS65001");
        throw new CalendarAuthError(
          consentRequired
            ? `カレンダーへのアクセスの同意が必要です: ${error.message}`
            : `Microsoft の認証に失敗しました。再ログインが必要です: ${error.message}`,
          { needsReauth: true, consentRequired, cause: error },
        );
      }
      throw error;
    }
    this.current = { value: tokens.accessToken, expiresAt: tokens.expiresAt };
    if (
      !row.mailEnabled &&
      tokens.refreshToken &&
      tokens.refreshToken !== credentials.refreshToken
    ) {
      const credentialsEncrypted = encryptCredentials(
        { type: "oauth2", refreshToken: tokens.refreshToken },
        this.encryptionKey,
        row.userId,
      );
      // 読んだあとに本人の再ログインなどで入れ替わっていたら、上書きしない。
      const saved = await this.db
        .update(accounts)
        .set({ credentialsEncrypted })
        .where(
          and(
            eq(accounts.id, this.accountId),
            eq(accounts.mailEnabled, false),
            eq(accounts.credentialsEncrypted, row.credentialsEncrypted),
          ),
        )
        .returning({ id: accounts.id });
      if (saved.length > 0) this.onCredentialsSaved?.(credentialsEncrypted);
    }
    return tokens.accessToken;
  }
}
