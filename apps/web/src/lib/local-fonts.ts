import { useSyncExternalStore } from "react";
import { invokeDesktop, isDesktopApp } from "@/lib/desktop/app";
import { cleanFontName } from "@/lib/preferences";

/**
 * この端末に入っているフォントの一覧。取れる環境は限られる。
 * - デスクトップ版 (Tauri): アプリ側のコマンド list_fonts で OS のフォントを調べる (どの OS でも取れる)。
 * - Chrome / Edge などの Chromium 系のブラウザー (PC): Local Font Access API (queryLocalFonts)。
 *   利用者の許可が要り、最初の 1 回はボタンを押した操作の中で呼ぶ必要がある。
 * - Firefox、Safari、スマホのブラウザー、Android アプリ (WebView): 取れない。
 *   このときは、ブラウザーが選ぶフォント (総称ファミリー) だけで動かす。
 */
export type LocalFont = {
  /** CSS の font-family に書く名前。 */
  family: string;
  /** 一覧に出す名前 (日本語の名前があればそちら)。 */
  label: string;
  /** 等幅かどうか。分からない環境では null。 */
  monospace: boolean | null;
};

/** 一覧をどこから取れるか。none は取れない環境。 */
export type FontListSupport = "desktop" | "browser" | "none";

export type LocalFontsState = {
  /**
   * idle は未取得、denied は利用者かブラウザーの設定で拒否された、
   * error はそれ以外の理由で取れなかった。
   */
  status: "idle" | "loading" | "ready" | "denied" | "error";
  fonts: readonly LocalFont[];
};

type FontData = { family: string };
type FontWindow = {
  queryLocalFonts?: () => Promise<FontData[]>;
};

export function fontListSupport(): FontListSupport {
  if (typeof window === "undefined") return "none";
  if (isDesktopApp()) return "desktop";
  return typeof (window as unknown as FontWindow).queryLocalFonts === "function"
    ? "browser"
    : "none";
}

/** 取ってきた一覧を、名前順の重複の無い一覧に整える。使えない名前は捨てる。 */
export function normalizeFonts(
  raw: readonly {
    family?: unknown;
    label?: unknown;
    monospace?: unknown;
  }[],
): LocalFont[] {
  const byFamily = new Map<string, LocalFont>();
  for (const item of raw) {
    if (typeof item.family !== "string") continue;
    // 縦書き用の別名 (@ で始まる) は、横書きの画面では使わない。
    if (item.family.startsWith("@")) continue;
    // 設定に保存できる名前 (cleanFontName を通しても変わらない名前) だけを出す。
    const family = item.family.trim();
    if (!family || cleanFontName(family) !== family) continue;
    const label =
      typeof item.label === "string" && item.label.trim()
        ? item.label.trim()
        : family;
    const monospace =
      typeof item.monospace === "boolean" ? item.monospace : null;
    const existing = byFamily.get(family);
    if (!existing) {
      byFamily.set(family, { family, label, monospace });
    } else if (monospace !== null && existing.monospace !== true) {
      existing.monospace = monospace;
    }
  }
  return [...byFamily.values()].sort((a, b) =>
    a.label.localeCompare(b.label, "ja"),
  );
}

/** 検索語 (空白区切り、大文字小文字を区別しない) にすべて合うフォントだけを返す。 */
export function searchFonts(
  fonts: readonly LocalFont[],
  query: string,
): readonly LocalFont[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return fonts;
  return fonts.filter((font) => {
    const text = `${font.label} ${font.family}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

const IDLE: LocalFontsState = { status: "idle", fonts: [] };
let state: LocalFontsState = IDLE;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setState(next: LocalFontsState) {
  state = next;
  for (const listener of listeners) listener();
}

async function fetchFonts(support: FontListSupport): Promise<LocalFontsState> {
  if (support === "desktop") {
    const fonts = await invokeDesktop<LocalFont[]>("list_fonts");
    return Array.isArray(fonts)
      ? { status: "ready", fonts: normalizeFonts(fonts) }
      : { status: "error", fonts: [] };
  }
  if (support === "browser") {
    try {
      const fonts = await (window as unknown as FontWindow).queryLocalFonts?.();
      // 許可を拒否すると、エラーではなく空の一覧が返るブラウザーがある。
      if (!fonts || fonts.length === 0) return { status: "denied", fonts: [] };
      return { status: "ready", fonts: normalizeFonts(fonts) };
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      return {
        status:
          name === "NotAllowedError" || name === "SecurityError"
            ? "denied"
            : "error",
        fonts: [],
      };
    }
  }
  return { status: "error", fonts: [] };
}

/**
 * フォントの一覧を取る。ブラウザーでは許可を尋ねることがあるので、
 * ボタンを押したときなど、利用者の操作の中で呼ぶ。取得済みなら何もしない。
 */
export function loadLocalFonts(): Promise<void> {
  if (state.status === "ready") return Promise.resolve();
  if (loading) return loading;
  const support = fontListSupport();
  if (support === "none") return Promise.resolve();
  setState({ status: "loading", fonts: [] });
  loading = fetchFonts(support)
    .then(setState, () => setState({ status: "error", fonts: [] }))
    .finally(() => {
      loading = null;
    });
  return loading;
}

/**
 * 尋ねずに取れるときだけ、先に一覧を取っておく
 * (デスクトップ版と、すでに許可してあるブラウザー)。
 */
export async function preloadLocalFonts(): Promise<void> {
  const support = fontListSupport();
  if (support === "desktop") return loadLocalFonts();
  if (support !== "browser") return;
  try {
    const permission = await navigator.permissions.query({
      name: "local-fonts" as PermissionName,
    });
    if (permission.state === "granted") await loadLocalFonts();
  } catch {
    // 許可の状態を調べられなければ、利用者が一覧を開いたときに尋ねる。
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** フォントの一覧の状態。変わると、使っている部品を描き直す。 */
export function useLocalFonts(): LocalFontsState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => IDLE,
  );
}

const subscribeNever = () => () => {};

/** 一覧をどこから取れるか。サーバーでの描画と最初の描画では none。 */
export function useFontListSupport(): FontListSupport {
  return useSyncExternalStore(
    subscribeNever,
    fontListSupport,
    () => "none" as const,
  );
}

/** テスト用: 取得済みの一覧を捨てる。 */
export function resetLocalFontsForTest() {
  state = IDLE;
  loading = null;
}
