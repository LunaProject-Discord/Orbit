import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * メールアカウントの認証情報。暗号化して mail_accounts.credentials_encrypted に保存する。
 * OAuth2 ではリフレッシュトークンだけを保存し、アクセストークンは都度取得する。
 */
export type MailCredentials =
  | { type: "password"; password: string }
  | { type: "oauth2"; refreshToken: string };

const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** 環境変数の値 (base64 の 32 バイト) を AES-256 の鍵として読み込む。 */
export function loadEncryptionKey(value: string | undefined): Buffer {
  if (!value) {
    throw new Error(
      "CREDENTIALS_ENCRYPTION_KEY が設定されていません。リポジトリのルートで `pnpm env:init` を実行してください。",
    );
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      "CREDENTIALS_ENCRYPTION_KEY は base64 で表した 32 バイトの値にしてください。",
    );
  }
  return key;
}

/**
 * 文字列を AES-256-GCM で暗号化する。
 * context は追加認証データで、復号時に同じ値を渡さないと復号できない。
 */
export function encryptText(
  plaintext: string,
  key: Buffer,
  context: string,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    VERSION,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptText(
  encrypted: string,
  key: Buffer,
  context: string,
): string {
  const [version, iv, tag, ciphertext] = encrypted.split(":");
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
    throw new Error("暗号文の形式が正しくありません。");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64"),
  );
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (cause) {
    // Node.js の既定のメッセージでは原因が分からないので、言い換える。
    throw new Error(
      "認証情報を復号できません。CREDENTIALS_ENCRYPTION_KEY が保存時と異なる可能性があります。",
      { cause },
    );
  }
}

/**
 * 認証情報を暗号化する。
 * context (利用者 ID) を追加認証データにして、暗号文を別の利用者の行へ
 * 付け替えても復号できないようにする。
 */
export function encryptCredentials(
  credentials: MailCredentials,
  key: Buffer,
  context: string,
): string {
  return encryptText(JSON.stringify(credentials), key, context);
}

export function decryptCredentials(
  encrypted: string,
  key: Buffer,
  context: string,
): MailCredentials {
  return JSON.parse(decryptText(encrypted, key, context)) as MailCredentials;
}
