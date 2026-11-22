/**
 * パスキー (WebAuthn) の登録とログイン。
 * ブラウザーとのやり取りは @simplewebauthn/browser に任せ、サーバーとは lib/api.ts で話す。
 */
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnError,
} from "@simplewebauthn/browser";
import {
  type Passkey,
  passkeyRegister,
  passkeyRegisterOptions,
  passkeySignIn,
  passkeySignInOptions,
} from "@/lib/api";
import { isBundledApp } from "@/lib/server-url";

/**
 * この環境でパスキーを使えるか。
 * パスキーは Web のドメインに結び付く。スマホ版・デスクトップ版の画面はアプリ内の別のオリジン
 * (https://localhost、tauri://localhost など) で動くので、Web で登録したパスキーを使えない。
 * そのため同梱アプリでは出さない。
 */
export function passkeySupported(): boolean {
  if (typeof window === "undefined") return false;
  if (isBundledApp()) return false;
  return browserSupportsWebAuthn();
}

/** 利用者が取りやめた (ブラウザーの画面を閉じた、時間切れ)。 */
export class PasskeyCancelled extends Error {
  constructor() {
    super("passkey_cancelled");
    this.name = "PasskeyCancelled";
  }
}

/** この認証器には、もうこのアカウントのパスキーがある。 */
export class PasskeyAlreadyRegistered extends Error {
  constructor() {
    super("passkey_already_registered");
    this.name = "PasskeyAlreadyRegistered";
  }
}

function translate(error: unknown): unknown {
  if (error instanceof WebAuthnError) {
    if (error.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") {
      return new PasskeyAlreadyRegistered();
    }
    if (error.code === "ERROR_CEREMONY_ABORTED") return new PasskeyCancelled();
  }
  // ブラウザーは、取りやめと時間切れを NotAllowedError で知らせる。
  if (error instanceof Error && error.name === "NotAllowedError") {
    return new PasskeyCancelled();
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new PasskeyCancelled();
  }
  return error;
}

type CreationOptions = Parameters<typeof startRegistration>[0]["optionsJSON"];
type RequestOptions = Parameters<typeof startAuthentication>[0]["optionsJSON"];

/** この端末 (または鍵) にパスキーを作って、アカウントに登録する。 */
export async function registerPasskey(name: string): Promise<Passkey> {
  const optionsJSON = (await passkeyRegisterOptions()) as CreationOptions;
  let response: Awaited<ReturnType<typeof startRegistration>>;
  try {
    response = await startRegistration({ optionsJSON });
  } catch (error) {
    throw translate(error);
  }
  const { clientExtensionResults: _ignored, ...body } = response;
  return passkeyRegister(body, name);
}

/** パスキーでログインする。成功するとセッショントークンが保存される。 */
export async function signInWithPasskey(): Promise<void> {
  const optionsJSON = (await passkeySignInOptions()) as RequestOptions;
  let response: Awaited<ReturnType<typeof startAuthentication>>;
  try {
    response = await startAuthentication({ optionsJSON });
  } catch (error) {
    throw translate(error);
  }
  const { clientExtensionResults: _ignored, ...body } = response;
  await passkeySignIn(body);
}
