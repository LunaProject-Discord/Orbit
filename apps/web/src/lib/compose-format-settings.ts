import { useSyncExternalStore } from "react";
import {
  type Account,
  type ComposeFormat,
  getSettings,
  saveComposeFormat,
} from "@/lib/api";

// ---------------------------------------------------------------------------
// メールを書くときの既定の形式 (書式付きかテキストか)。サーバーに保存してどの端末でも同じにし、
// 前回の内容を端末にも残す (オフラインで開いたときにも使えるように)。
// アカウントごとの指定 (Account.composeFormat) があれば、そちらが優先。
// ---------------------------------------------------------------------------

const CACHE_KEY = "mail.compose-format.v1";

let current: ComposeFormat | null = null;
/** 保存の途中で届いた取得結果に、選んだばかりの設定を上書きされないようにする。 */
let saving = 0;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function read(): ComposeFormat {
  if (current !== null) return current;
  current = storage()?.getItem(CACHE_KEY) === "text" ? "text" : "html";
  return current;
}

function set(next: ComposeFormat) {
  if (current === next) return;
  current = next;
  try {
    storage()?.setItem(CACHE_KEY, next);
  } catch {
    // 保存できなくても、このページを開いている間は有効。
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** メールを書くときの既定の形式。変わると、使っている部品を描き直す。 */
export function useDefaultComposeFormat(): ComposeFormat {
  return useSyncExternalStore(subscribe, read, () => "html" as const);
}

/** メールを書くときの既定の形式 (部品の外で使うとき用)。 */
export function currentDefaultComposeFormat(): ComposeFormat {
  return read();
}

/** このアカウントから書くときの形式。アカウントの指定が無ければ既定に従う。 */
export function composeFormatFor(
  account: Pick<Account, "composeFormat"> | null | undefined,
): ComposeFormat {
  return account?.composeFormat ?? read();
}

/** サーバーから設定を取得し直す (起動時と、ほかの端末で変えたとき)。 */
export async function refreshComposeFormat(
  load: () => Promise<{ composeFormat?: ComposeFormat }> = getSettings,
): Promise<void> {
  try {
    const { composeFormat } = await load();
    if (saving > 0) return;
    set(composeFormat === "text" ? "text" : "html");
  } catch {
    // 取得できない間 (オフラインなど) は、前回の内容を使う。
  }
}

/**
 * 既定の形式を変える。画面にはすぐ反映し、サーバーに保存できなければ元に戻す。
 * 保存できたかを返す。
 */
export async function changeDefaultComposeFormat(
  format: ComposeFormat,
  save: (format: ComposeFormat) => Promise<void> = saveComposeFormat,
): Promise<boolean> {
  const previous = read();
  set(format);
  saving += 1;
  try {
    await save(format);
    return true;
  } catch {
    if (current === format) set(previous);
    return false;
  } finally {
    saving -= 1;
  }
}

/** テスト用: 保持している設定を捨てる。 */
export function resetComposeFormatForTest() {
  current = null;
  saving = 0;
}
