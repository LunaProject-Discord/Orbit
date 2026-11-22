import { useMemo, useSyncExternalStore } from "react";
import { invokeDesktop, isDesktopApp } from "@/lib/desktop/app";
import { isNativeApp, loadAppShell } from "@/lib/native/app";
import { cleanFontName } from "@/lib/preferences";

/**
 * この端末に入っているフォントの一覧。取れる環境は限られる。
 * - デスクトップ版 (Tauri): アプリ側のコマンド list_fonts で OS のフォントを調べる (どの OS でも取れる)。
 * - Chrome / Edge などの Chromium 系のブラウザー (PC): Local Font Access API (queryLocalFonts)。
 *   利用者の許可が要り、最初の 1 回はボタンを押した操作の中で呼ぶ必要がある。
 * - Android アプリ: アプリ側 (AppShell プラグインの listFonts) が端末のフォントのファイルを調べる。
 *   WebView は端末のフォントを名前では指定できないことが多いので、ファイルを @font-face で読み込んで使う
 *   (fontFaceCss)。起動のたびに調べ直さずに済むよう、一覧は localStorage にも置く。
 * - Firefox、Safari、スマホのブラウザー: 取れない。
 *   このときは、ブラウザーが選ぶフォント (総称ファミリー) だけで動かす。
 */
export type FontFace = {
  /** 端末の中のフォントのファイルのパス。 */
  path: string;
  /** このファイルで出せる太さの範囲 (太さが 1 つなら同じ値)。 */
  weightMin: number;
  weightMax: number;
  italic: boolean;
};

export type LocalFont = {
  /** CSS の font-family に書く名前。 */
  family: string;
  /** 一覧に出す名前 (日本語の名前があればそちら)。 */
  label: string;
  /** 等幅かどうか。分からない環境では null。 */
  monospace: boolean | null;
  /** 読み込むファイル。名前だけでは使えない環境 (Android アプリ) でだけ入る。 */
  faces?: readonly FontFace[];
};

/** 一覧をどこから取れるか。none は取れない環境。 */
export type FontListSupport = "desktop" | "native" | "browser" | "none";

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
  if (isNativeApp()) return "native";
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
    faces?: unknown;
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
    const faces = normalizeFaces(item.faces);
    const existing = byFamily.get(family);
    if (!existing) {
      byFamily.set(family, {
        family,
        label,
        monospace,
        ...(faces.length > 0 ? { faces } : {}),
      });
    } else if (monospace !== null && existing.monospace !== true) {
      existing.monospace = monospace;
    }
  }
  return [...byFamily.values()].sort((a, b) =>
    a.label.localeCompare(b.label, "ja"),
  );
}

/** CSS の URL にそのまま入れられるパスだけを通す。 */
const SAFE_FONT_PATH = /^\/[A-Za-z0-9_./-]+$/;

function normalizeFaces(raw: unknown): FontFace[] {
  if (!Array.isArray(raw)) return [];
  const faces: FontFace[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    if (typeof item !== "object" || item === null) continue;
    const { path, weightMin, weightMax, italic } = item;
    if (typeof path !== "string" || !SAFE_FONT_PATH.test(path)) continue;
    if (path.includes("..")) continue;
    const min = clampWeight(weightMin);
    const max = Math.max(min, clampWeight(weightMax));
    faces.push({
      path,
      weightMin: min,
      weightMax: max,
      italic: italic === true,
    });
  }
  return faces;
}

function clampWeight(value: unknown): number {
  return typeof value === "number" && value >= 1 && value <= 1000
    ? Math.round(value)
    : 400;
}

/**
 * フォントのファイルを読み込むための @font-face の規則。
 * families を渡すと、その名前のフォントの分だけ返す。ファイルを持たないフォントの分は返さない。
 * 規則を置いただけではファイルは読み込まれず、実際にそのフォントで文字を描くときに読み込まれる。
 */
export function fontFaceCss(
  fonts: readonly LocalFont[],
  fileUrl: (path: string) => string,
  families?: ReadonlySet<string>,
): string {
  let css = "";
  for (const font of fonts) {
    if (!font.faces || (families && !families.has(font.family))) continue;
    for (const face of font.faces) {
      const weight =
        face.weightMin === face.weightMax
          ? `${face.weightMin}`
          : `${face.weightMin} ${face.weightMax}`;
      css += `@font-face{font-family:"${font.family}";src:url("${fileUrl(face.path)}");font-weight:${weight};font-style:${face.italic ? "italic" : "normal"};font-display:swap}`;
    }
  }
  return css;
}

type CapacitorWindow = {
  Capacitor?: { convertFileSrc?: (path: string) => string };
};

/** 端末の中のファイルを、アプリの画面から読める URL にする (Android アプリ)。 */
export function nativeFileUrl(path: string): string {
  const converted = (
    window as unknown as CapacitorWindow
  ).Capacitor?.convertFileSrc?.(path);
  // 変換できなければ、Capacitor の決まった形の URL を自分で組み立てる。
  const url =
    converted && converted !== path
      ? converted
      : `${window.location.origin}/_capacitor_file_${path}`;
  // CSS の文字列に入れるので、引用符などを含む URL は使わない。
  return /^[A-Za-z0-9_.:/-]+$/.test(url) ? url : "";
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

/** Android アプリで調べた一覧の控え。起動してすぐ、選んであるフォントを読み込めるようにする。 */
const NATIVE_CACHE_KEY = "mail.native-fonts.v1";

function readNativeCache(): LocalFont[] {
  try {
    const saved = JSON.parse(
      window.localStorage.getItem(NATIVE_CACHE_KEY) ?? "null",
    );
    return Array.isArray(saved) ? normalizeFonts(saved) : [];
  } catch {
    return [];
  }
}

function writeNativeCache(fonts: readonly LocalFont[]) {
  try {
    window.localStorage.setItem(NATIVE_CACHE_KEY, JSON.stringify(fonts));
  } catch {
    // 保存できなくても、次の起動で調べ直すまで選んだフォントが出ないだけ。
  }
}
let loading: Promise<void> | null = null;
/** いまの一覧が控えから読んだもので、まだ調べ直していない。 */
let stale = false;
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
  if (support === "native") {
    try {
      const { AppShell } = await loadAppShell();
      const { fonts } = await AppShell.listFonts();
      if (!Array.isArray(fonts)) return { status: "error", fonts: [] };
      const normalized = normalizeFonts(fonts);
      writeNativeCache(normalized);
      return { status: "ready", fonts: normalized };
    } catch {
      return { status: "error", fonts: [] };
    }
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
  if (state.status === "ready" && !stale) return Promise.resolve();
  if (loading) return loading;
  const support = fontListSupport();
  if (support === "none") return Promise.resolve();
  // 控えの一覧を出している間は、調べ直しが済むまでその一覧を出し続ける。
  const previous = state;
  if (!stale) setState({ status: "loading", fonts: [] });
  loading = fetchFonts(support)
    .then(
      (next) => {
        stale = false;
        setState(
          next.status === "ready" || !previous.fonts.length ? next : previous,
        );
      },
      () =>
        setState(
          previous.fonts.length ? previous : { status: "error", fonts: [] },
        ),
    )
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
  if (support === "native") {
    if (state.status === "idle") {
      const cached = readNativeCache();
      if (cached.length > 0) {
        stale = true;
        setState({ status: "ready", fonts: cached });
      }
    }
    return loadLocalFonts();
  }
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

/**
 * 端末のフォントのファイルを読み込む @font-face の規則 (Android アプリ)。
 * ほかの環境では、フォントを名前で指定できるので空になる。
 * families を渡すと、その名前のフォントの分だけにする (毎回同じ中身の配列でよい)。
 */
export function useFontFaceCss(families?: readonly string[]): string {
  const { fonts } = useLocalFonts();
  const key = families?.join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: 配列は中身 (key) で比べる
  return useMemo(
    () => fontFaceCss(fonts, nativeFileUrl, families && new Set(families)),
    [fonts, key],
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
  stale = false;
}
