/**
 * Better Auth が Cookie で持つ一時的な値を、ヘッダーで受け渡す。
 *
 * この API は Cookie を使わない (Web / Tauri / Capacitor で同じ方式にするため、画面は
 * credentials: "omit" で呼ぶ)。しかし 2 段階認証とパスキーは、手順の途中の値を Cookie に置く:
 *   - two_factor: パスワードは通ったが、コードの入力がまだのログイン
 *   - trust_device: 「この端末では 30 日間コードを尋ねない」の印
 *   - better-auth-passkey: パスキーの登録・ログインで照合する値 (チャレンジ) の控え
 * そこで、応答の Set-Cookie を X-Auth-State ヘッダーへ写して画面に預け、画面は次の呼び出しで
 * 同じヘッダーに載せて返す。サーバーはそれを Cookie として Better Auth に渡す。
 * 値はどれも Better Auth が署名しているので、画面側で書き換えても通らない。
 *
 * セッションの Cookie は対象にしない (セッションは Authorization: Bearer で渡す)。
 */

export const AUTH_STATE_HEADER = "X-Auth-State";

/** 画面が預かる値。maxAge (秒) が 0 以下なら「消す」。null は「画面を閉じるまで」。 */
export type AuthStateEntry = { value: string; maxAge: number | null };
export type AuthState = Record<string, AuthStateEntry>;

/** Cookie の名前に使える文字 (RFC 6265 の token)。 */
const NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Cookie の値に使える文字 (空白、引用符、カンマ、セミコロン、バックスラッシュ以外の表示できる ASCII)。 */
const VALUE_PATTERN = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;
const MAX_HEADER_LENGTH = 4096;

/** セッションそのものを表す Cookie か (Bearer トークンで渡すので、ヘッダーでは受け渡さない)。 */
function isSessionCookie(name: string): boolean {
  return (
    name.endsWith("session_token") ||
    name.endsWith("session_data") ||
    name.endsWith("dont_remember")
  );
}

/**
 * 画面から届いた X-Auth-State (「名前=値; 名前=値」) を、Cookie ヘッダーの値にする。
 * 形のおかしいものとセッションの Cookie は捨てる。
 */
export function authStateToCookie(header: string | null): string | null {
  if (!header || header.length > MAX_HEADER_LENGTH) return null;
  const pairs: string[] = [];
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!NAME_PATTERN.test(name) || !VALUE_PATTERN.test(value)) continue;
    if (isSessionCookie(name)) continue;
    pairs.push(`${name}=${value}`);
  }
  return pairs.length > 0 ? pairs.join("; ") : null;
}

/** 応答の Set-Cookie から、画面に預ける値を取り出す。 */
export function authStateFromSetCookies(setCookies: string[]): AuthState {
  const state: AuthState = {};
  for (const line of setCookies) {
    const [pair = "", ...attributes] = line.split(";");
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!NAME_PATTERN.test(name) || !VALUE_PATTERN.test(value)) continue;
    if (isSessionCookie(name)) continue;
    let maxAge: number | null = null;
    for (const attribute of attributes) {
      const [key = "", raw = ""] = attribute.split("=");
      const lower = key.trim().toLowerCase();
      if (lower === "max-age") {
        const seconds = Number(raw.trim());
        if (Number.isFinite(seconds)) maxAge = Math.trunc(seconds);
      } else if (lower === "expires" && maxAge === null) {
        // Expires は値に "=" を含まないが、カンマを含む。分割した残りではなく元の文字列から読む。
        const expires = Date.parse(
          attribute.slice(attribute.indexOf("=") + 1).trim(),
        );
        if (Number.isFinite(expires)) {
          maxAge = Math.trunc((expires - Date.now()) / 1000);
        }
      }
    }
    state[name] = {
      value: maxAge !== null && maxAge <= 0 ? "" : value,
      maxAge,
    };
  }
  return state;
}

/** X-Auth-State を Cookie に写したリクエストを作る。 */
export function withAuthStateCookie(request: Request): Request {
  const cookie = authStateToCookie(request.headers.get(AUTH_STATE_HEADER));
  const headers = new Headers(request.headers);
  headers.delete(AUTH_STATE_HEADER);
  // ブラウザーが付けた Cookie は使わない (この API は Cookie で利用者を見分けない)。
  if (cookie) headers.set("Cookie", cookie);
  else headers.delete("Cookie");
  return new Request(request, { headers });
}

/** 応答の Set-Cookie を X-Auth-State に写す。Set-Cookie 自体は返さない。 */
export function withAuthStateHeader(response: Response): Response {
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length === 0) return response;
  const headers = new Headers(response.headers);
  headers.delete("Set-Cookie");
  const state = authStateFromSetCookies(setCookies);
  if (Object.keys(state).length > 0) {
    headers.set(AUTH_STATE_HEADER, JSON.stringify(state));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
