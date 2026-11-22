import { createSign } from "node:crypto";
import type { PushMessage } from "./notifications.js";

/**
 * Firebase Cloud Messaging (FCM) で、スマホアプリへ新着メールの通知を送る。
 * FCM の HTTP v1 API を直接呼ぶ (Firebase の SDK は使わない)。
 * 認証は、Firebase のサービスアカウントの鍵で署名した JWT を Google のアクセストークンに
 * 引き換えて行う。
 */

/** FCM の設定。Firebase コンソールで発行する「サービスアカウントの秘密鍵」(JSON) から読む。 */
export type FcmConfig = {
  projectId: string;
  clientEmail: string;
  /** PEM 形式の秘密鍵。 */
  privateKey: string;
};

/**
 * 環境変数 FCM_SERVICE_ACCOUNT から設定を読む。未設定なら null で、スマホアプリへの通知は送らない。
 * 値は、サービスアカウントの JSON そのもの、またはそれを base64 にしたもの
 * (.env に 1 行で書きやすいので、base64 を勧める)。
 */
export function loadFcmConfig(
  env: Record<string, string | undefined>,
): FcmConfig | null {
  const raw = env.FCM_SERVICE_ACCOUNT?.trim();
  if (!raw) return null;
  const invalid = () =>
    new Error(
      "FCM_SERVICE_ACCOUNT を読み取れません。Firebase のサービスアカウントの JSON、またはそれを base64 にした値を指定してください。",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"),
    );
  } catch {
    throw invalid();
  }
  const account = (parsed ?? {}) as Record<string, unknown>;
  const { project_id, client_email, private_key } = account;
  if (
    typeof project_id !== "string" ||
    typeof client_email !== "string" ||
    typeof private_key !== "string" ||
    !project_id ||
    !client_email ||
    !private_key.includes("PRIVATE KEY")
  ) {
    throw invalid();
  }
  return {
    projectId: project_id,
    clientEmail: client_email,
    privateKey: private_key,
  };
}

/** 新着メールの通知の分類 (Android の通知チャンネル)。アプリ側の ID と合わせる。 */
export const FCM_CHANNEL_NEW_MAIL = "new-mail";
/** 届けられなかった通知を FCM が預かる時間 (端末がオフラインのとき)。 */
const TTL_SECONDS = 24 * 60 * 60;

/**
 * FCM に渡す 1 件分のメッセージ。
 * notification は付けず、data だけを送る。notification を付けると Android が自分で通知を出すが、
 * その通知にはボタンを付けられない。data だけにすると、アプリの受け口 (OrbitMessagingService) が
 * 起こされ、ボタン付きの通知をアプリが組み立てる。値は文字列のみ。
 */
export function toFcmMessage(token: string, message: PushMessage) {
  const { actions } = message;
  return {
    message: {
      token,
      data: {
        title: message.title,
        body: message.body,
        // 同じ tag の通知は置き換わる (再送で二重に出さない)。
        tag: message.tag,
        // 通知を押したときに開くメール。まとめた通知では空。
        messageId: message.messageId ?? "",
        // 通知の分類 (Android の通知チャンネル)。
        channel: FCM_CHANNEL_NEW_MAIL,
        ...(actions
          ? {
              actions: JSON.stringify(actions.buttons),
              actionUrl: actions.url,
              actionToken: actions.token,
            }
          : {}),
      },
      android: {
        ttl: `${TTL_SECONDS}s`,
        // 端末が休んでいても、すぐに届けてもらう。
        priority: "HIGH",
      },
    },
  };
}

/** FCM が断ったときのエラー。 */
export class FcmError extends Error {
  constructor(
    readonly status: number,
    /** FCM のエラーコード (UNREGISTERED、INVALID_ARGUMENT など)。取れなければ null。 */
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "FcmError";
  }

  /** 送り先がもう使えない (アプリの削除、トークンの失効)。サーバーの送り先を消してよい。 */
  get tokenGone(): boolean {
    return (
      this.status === 404 ||
      this.code === "UNREGISTERED" ||
      // トークンの形が正しくないとき。別のプロジェクトのトークンもここに来る。
      (this.status === 400 && this.code === "INVALID_ARGUMENT") ||
      (this.status === 403 && this.code === "SENDER_ID_MISMATCH")
    );
  }
}

const base64url = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");

/** サービスアカウントの鍵で署名した JWT (アクセストークンへの引き換え用)。 */
export function signServiceAccountJwt(
  config: FcmConfig,
  nowMs: number,
): string {
  const issuedAt = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: config.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: issuedAt,
      exp: issuedAt + 3600,
    }),
  );
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${claims}`)
    .sign(config.privateKey);
  return `${header}.${claims}.${base64url(signature)}`;
}

function fcmErrorCode(body: unknown): string | null {
  const error = (body as { error?: Record<string, unknown> } | null)?.error;
  if (!error) return null;
  const details = Array.isArray(error.details) ? error.details : [];
  for (const detail of details) {
    const code = (detail as { errorCode?: unknown } | null)?.errorCode;
    if (typeof code === "string") return code;
  }
  return typeof error.status === "string" ? error.status : null;
}

/** FCM へメッセージを送る。アクセストークンは期限が近づくまで使い回す。 */
export class FcmClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: FcmConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async accessToken(): Promise<string> {
    const now = this.now();
    if (this.token && this.token.expiresAt - 60_000 > now) {
      return this.token.value;
    }
    const response = await this.fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signServiceAccountJwt(this.config, now),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => null)) as {
      access_token?: unknown;
      expires_in?: unknown;
      error_description?: unknown;
    } | null;
    if (!response.ok || typeof body?.access_token !== "string") {
      throw new FcmError(
        response.status,
        null,
        `FCM のアクセストークンを取得できませんでした: ${
          typeof body?.error_description === "string"
            ? body.error_description
            : `HTTP ${response.status}`
        }`,
      );
    }
    const lifetime =
      typeof body.expires_in === "number" ? body.expires_in : 3600;
    this.token = { value: body.access_token, expiresAt: now + lifetime * 1000 };
    return this.token.value;
  }

  /** 端末 1 台へ通知 1 件を送る。断られたら FcmError を投げる。 */
  async send(deviceToken: string, message: PushMessage): Promise<void> {
    const accessToken = await this.accessToken();
    const response = await this.fetcher(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.config.projectId)}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(toFcmMessage(deviceToken, message)),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (response.ok) return;
    // アクセストークンが取り消されていたら、次の送信で取り直す。
    if (response.status === 401) this.token = null;
    const body: unknown = await response.json().catch(() => null);
    const detail = (body as { error?: { message?: unknown } } | null)?.error
      ?.message;
    throw new FcmError(
      response.status,
      fcmErrorCode(body),
      typeof detail === "string" ? detail : `HTTP ${response.status}`,
    );
  }
}
