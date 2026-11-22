import { useSyncExternalStore } from "react";

/**
 * 表示や動作の設定。端末 (ブラウザー) ごとに localStorage へ保存する。
 * 画面の大きさや好みは端末によって違うので、サーバーには保存しない。
 */
export type Preferences = {
  /** 画面のフォント。custom は customFont の名前を使う。 */
  font: "default" | "system" | "serif" | "mono" | "custom";
  /** font が custom のときに使う、端末に入っているフォントの名前。 */
  customFont: string;
  /** 画面全体の文字の大きさ (標準に対する %)。 */
  fontSize: number;
  /** メール一覧の行の間隔。 */
  density: "compact" | "standard" | "comfortable";
  /** メール一覧に出す本文の行数。0 なら出さない。 */
  previewLines: 0 | 1 | 2 | 3;
  /** メール一覧に、アカウントの色の点を出す。 */
  showAccountMark: boolean;
  /** 一覧などで、どのアカウントかを示す印。icon は設定したアイコン (無ければ色の点)、dot は常に色の点。 */
  accountMarkStyle: "icon" | "dot";
  /** メール一覧に、添付・スター・返信済みの印を出す。 */
  showListIcons: boolean;
  /** 一覧の日付。auto は今日なら時刻だけ、datetime は常に日付と時刻。 */
  listDate: "auto" | "datetime";
  /** 時刻を 12 時間制 (午前 / 午後) で出す。 */
  hour12: boolean;
  /** メールを開いたときに既読にするタイミング。 */
  markRead: "immediately" | "delay" | "never";
  /** markRead が delay のときに待つ秒数。 */
  markReadDelay: number;
  /** メール本文のフォント。 */
  bodyFont: "sans" | "serif" | "mono";
  /** メール本文の文字の大きさ (px)。メール側で指定があれば、そちらが使われる。 */
  bodyFontSize: number;
  /** メール本文の行間。 */
  bodyLineHeight: number;
  /** 外部の画像。ask はメールごとに確認し、always は常に表示する。 */
  remoteImages: "ask" | "always";
  /**
   * メールの見出し (件名、差出人、宛先、日時)。collapsed は 2 行にまとめ、
   * expanded は差出人や宛先のアドレスまで出す。見出しのボタンで切り替えた状態を覚える。
   */
  messageHeader: "collapsed" | "expanded";
  /** メールの下に簡易返信欄を出す。 */
  quickReply: boolean;
  /** 画面の切り替えなどの動き。system は端末の設定に従う。 */
  motion: "system" | "off";
  /** 1 文字のショートカットキーを使う。 */
  shortcuts: boolean;
  /**
   * トラックパッドの横スクロール (2 本指の横の動き) でも、一覧の行をスワイプする。
   * 何をするかはサーバーに保存する設定 (lib/swipe.ts) で、ここは端末ごとのオン / オフ。
   */
  trackpadSwipe: boolean;
  /**
   * 開いているメールを左右にスワイプしたときの動き。navigate は一覧の前後のメールへ移り、
   * actions は一覧の行と同じ操作 (lib/swipe.ts の設定) を行う。off は何もしない。
   */
  messageSwipe: "navigate" | "actions" | "off";
};

export const DEFAULT_PREFERENCES: Preferences = {
  font: "default",
  customFont: "",
  fontSize: 100,
  density: "standard",
  previewLines: 2,
  showAccountMark: true,
  accountMarkStyle: "icon",
  showListIcons: true,
  listDate: "auto",
  hour12: false,
  markRead: "immediately",
  markReadDelay: 3,
  bodyFont: "sans",
  bodyFontSize: 14,
  bodyLineHeight: 1.6,
  remoteImages: "ask",
  messageHeader: "collapsed",
  quickReply: true,
  motion: "system",
  shortcuts: true,
  trackpadSwipe: true,
  messageSwipe: "navigate",
};

export const FONT_SIZES = [87.5, 93.75, 100, 106.25, 112.5, 125] as const;
export const BODY_FONT_SIZES = [12, 13, 14, 15, 16, 18, 20] as const;
export const BODY_LINE_HEIGHTS = [1.4, 1.6, 1.8, 2] as const;
export const MARK_READ_DELAYS = [1, 3, 5, 10] as const;

const KEY = "mail.preferences.v1";

const choices: {
  [K in keyof Preferences]?: readonly Preferences[K][];
} = {
  font: ["default", "system", "serif", "mono", "custom"],
  fontSize: FONT_SIZES,
  density: ["compact", "standard", "comfortable"],
  previewLines: [0, 1, 2, 3],
  accountMarkStyle: ["icon", "dot"],
  listDate: ["auto", "datetime"],
  markRead: ["immediately", "delay", "never"],
  markReadDelay: MARK_READ_DELAYS,
  bodyFont: ["sans", "serif", "mono"],
  bodyFontSize: BODY_FONT_SIZES,
  bodyLineHeight: BODY_LINE_HEIGHTS,
  remoteImages: ["ask", "always"],
  messageHeader: ["collapsed", "expanded"],
  motion: ["system", "off"],
  messageSwipe: ["navigate", "actions", "off"],
};

/** 保存してあった値を読む。形の合わない項目や知らない値は、標準の値にする。 */
export function parsePreferences(raw: string | null): Preferences {
  let saved: unknown;
  try {
    saved = JSON.parse(raw ?? "null");
  } catch {
    saved = null;
  }
  if (typeof saved !== "object" || saved === null) return DEFAULT_PREFERENCES;
  const result: Record<string, unknown> = { ...DEFAULT_PREFERENCES };
  for (const key of Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[]) {
    const value = (saved as Record<string, unknown>)[key];
    if (typeof value !== typeof DEFAULT_PREFERENCES[key]) continue;
    const allowed = choices[key] as readonly unknown[] | undefined;
    if (allowed && !allowed.includes(value)) continue;
    result[key] = key === "customFont" ? cleanFontName(String(value)) : value;
  }
  return result as Preferences;
}

/** フォント名から、CSS の値を壊す文字を取り除く。 */
export function cleanFontName(name: string): string {
  return name
    .replace(/[^\p{L}\p{N} _.-]/gu, "")
    .trim()
    .slice(0, 100);
}

const SANS = '"Gen Interface JP", ui-sans-serif, system-ui, sans-serif';
const HEADING = `"Gen Interface JP Display", ${SANS}`;
const SYSTEM = "system-ui, sans-serif";
const SERIF =
  '"Noto Serif JP", "Yu Mincho", "YuMincho", "Hiragino Mincho ProN", serif';
const MONO =
  'ui-monospace, "SFMono-Regular", Consolas, "Noto Sans Mono CJK JP", monospace';

/** 画面のフォント (本文用と見出し用) の font-family。 */
export function appFontFamily(
  preferences: Pick<Preferences, "font" | "customFont">,
): { sans: string; heading: string } {
  switch (preferences.font) {
    case "system":
      return { sans: SYSTEM, heading: SYSTEM };
    case "serif":
      return { sans: SERIF, heading: SERIF };
    case "mono":
      return { sans: MONO, heading: MONO };
    case "custom": {
      const name = cleanFontName(preferences.customFont);
      if (!name) return { sans: SANS, heading: HEADING };
      const family = `"${name}", ${SANS}`;
      return { sans: family, heading: family };
    }
    default:
      return { sans: SANS, heading: HEADING };
  }
}

/** メール本文 (iframe の中) に付けるスタイル。 */
export function bodyStyle(
  preferences: Pick<
    Preferences,
    "bodyFont" | "bodyFontSize" | "bodyLineHeight"
  >,
): string {
  const family =
    preferences.bodyFont === "serif"
      ? SERIF
      : preferences.bodyFont === "mono"
        ? MONO
        : SYSTEM;
  return `font-family:${family};font-size:${preferences.bodyFontSize}px;line-height:${preferences.bodyLineHeight}`;
}

let current: Preferences | null = null;
const listeners = new Set<() => void>();

function read(): Preferences {
  if (current) return current;
  try {
    current = parsePreferences(window.localStorage.getItem(KEY));
  } catch {
    current = DEFAULT_PREFERENCES;
  }
  return current;
}

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // ほかのタブで変えた設定も反映する。
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== KEY) return;
    current = null;
    emit();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** いまの設定。変わると、使っている部品を描き直す。 */
export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_PREFERENCES);
}

/** 設定の一部を変えて保存する。 */
export function updatePreferences(patch: Partial<Preferences>) {
  current = parsePreferences(JSON.stringify({ ...read(), ...patch }));
  try {
    window.localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // 保存できなくても、このページを開いている間は有効。
  }
  emit();
}

/** すべての設定を標準に戻す。 */
export function resetPreferences() {
  current = DEFAULT_PREFERENCES;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // 消せなくても、このページを開いている間は標準の値になる。
  }
  emit();
}
