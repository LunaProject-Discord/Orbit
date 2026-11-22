/**
 * ログインの手順の途中で、サーバーから預かる値。
 *
 * サーバー (Better Auth) は、2 段階認証やパスキーの途中の値を Cookie に置く作りだが、
 * このアプリは Cookie を使わない。代わりに、サーバーが X-Auth-State ヘッダーで返した値を
 * ここに預かり、次の呼び出しで同じヘッダーに載せて返す (サーバー側は apps/api の lib/auth-state.ts)。
 *   - two_factor: パスワードは通ったが、コードの入力がまだのログイン (10 分)
 *   - trust_device: 「この端末では 30 日間コードを尋ねない」の印
 *   - better-auth-passkey: パスキーの登録・ログインで照合する値の控え (5 分)
 * 値はサーバーが署名しているので、書き換えても通らない。
 */

const KEY = "mail.auth-state.v1";

export const AUTH_STATE_HEADER = "X-Auth-State";

type Stored = Record<string, { value: string; expiresAt: number | null }>;

function read(): Stored {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const stored: Stored = {};
    const now = Date.now();
    for (const [name, entry] of Object.entries(value)) {
      if (!entry || typeof entry !== "object") continue;
      const { value: text, expiresAt } = entry as Record<string, unknown>;
      if (typeof text !== "string") continue;
      if (expiresAt !== null && typeof expiresAt !== "number") continue;
      if (expiresAt !== null && expiresAt <= now) continue;
      stored[name] = { value: text, expiresAt };
    }
    return stored;
  } catch {
    return {};
  }
}

function write(stored: Stored) {
  try {
    if (Object.keys(stored).length === 0) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // 保存できなければ、2 段階認証の途中の値を次の呼び出しへ渡せない (ログインし直しになる)。
  }
}

/** サーバーへ返すヘッダーの値。預かっている値が無ければ null。 */
export function authStateHeader(): string | null {
  const pairs = Object.entries(read()).map(
    ([name, entry]) => `${name}=${entry.value}`,
  );
  return pairs.length > 0 ? pairs.join("; ") : null;
}

/** サーバーが返したヘッダーの値を預かる (期限が 0 以下のものは消す)。 */
export function absorbAuthState(header: string | null) {
  if (!header) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(header);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const stored = read();
  for (const [name, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== "object") continue;
    const { value, maxAge } = entry as Record<string, unknown>;
    if (typeof value !== "string") continue;
    if (typeof maxAge === "number" && maxAge <= 0) {
      delete stored[name];
    } else {
      stored[name] = {
        value,
        expiresAt:
          typeof maxAge === "number" ? Date.now() + maxAge * 1000 : null,
      };
    }
  }
  write(stored);
}

/** 預かっている値をすべて消す (接続先サーバーを替えたとき)。 */
export function clearAuthState() {
  write({});
}
