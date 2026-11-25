import { useSyncExternalStore } from "react";

/**
 * 表示や動作の設定。端末 (ブラウザー) ごとに localStorage へ保存する。
 * 画面の大きさや好みは端末によって違うので、サーバーには保存しない。
 */
export type Preferences = {
  /**
   * 画面の既定のフォント。default は Gen Interface JP、system は端末の画面のフォント、
   * sans / serif / mono はゴシック体・明朝体・等幅、custom は customFont の名前を使う。
   */
  font: "default" | "system" | "sans" | "serif" | "mono" | "custom";
  /** font が custom のときに使う、端末に入っているフォントの名前。 */
  customFont: string;
  /**
   * ゴシック体・明朝体・等幅として使う、端末に入っているフォントの名前。
   * 空なら、ブラウザーが選ぶフォント (CSS の sans-serif / serif / monospace) に任せる。
   * 画面の既定のフォントとメール本文のフォントの両方に効く。
   */
  sansFont: string;
  serifFont: string;
  monoFont: string;
  /** 画面全体の文字の大きさ (標準に対する %)。 */
  fontSize: number;
  /**
   * メール一覧の見た目。cards は差出人・件名・本文を重ねたカード、table は列に分けた表。
   * table は一覧に十分な幅がある画面 (幅 768px 以上) でだけ使い、狭い画面ではカードにする。
   */
  listLayout: "cards" | "table";
  /** メール一覧の行の間隔。 */
  density: "compact" | "standard" | "comfortable";
  /** メール一覧に出す本文の行数。0 なら出さない。 */
  previewLines: 0 | 1 | 2 | 3;
  /** メール一覧に、アカウントの色の点を出す。 */
  showAccountMark: boolean;
  /** 一覧などで、どのアカウントかを示す印。icon は設定したアイコン (無ければ色の点)、dot は常に色の点。 */
  accountMarkStyle: "icon" | "dot";
  /** メール一覧に、添付・スター・返信済みのマークを出す。 */
  showListIcons: boolean;
  /** メールを開いたときに既読にするタイミング。 */
  markRead: "immediately" | "delay" | "never";
  /** markRead が delay のときに待つ秒数。 */
  markReadDelay: number;
  /**
   * フォントの指定が無いメール本文に使うフォント (ブラウザーの「標準フォント」に当たる)。
   * custom は bodyCustomFont の名前を使う。
   */
  bodyFont: "sans" | "serif" | "mono" | "custom";
  /** bodyFont が custom のときに使う、端末に入っているフォントの名前。 */
  bodyCustomFont: string;
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
  sansFont: "",
  serifFont: "",
  monoFont: "",
  fontSize: 100,
  listLayout: "cards",
  density: "standard",
  previewLines: 2,
  showAccountMark: true,
  accountMarkStyle: "icon",
  showListIcons: true,
  markRead: "immediately",
  markReadDelay: 3,
  bodyFont: "sans",
  bodyCustomFont: "",
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
  font: ["default", "system", "sans", "serif", "mono", "custom"],
  fontSize: FONT_SIZES,
  listLayout: ["cards", "table"],
  density: ["compact", "standard", "comfortable"],
  previewLines: [0, 1, 2, 3],
  accountMarkStyle: ["icon", "dot"],
  markRead: ["immediately", "delay", "never"],
  markReadDelay: MARK_READ_DELAYS,
  bodyFont: ["sans", "serif", "mono", "custom"],
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
    result[key] = FONT_NAME_KEYS.has(key)
      ? cleanFontName(String(value))
      : value;
  }
  return result as Preferences;
}

/** フォントの名前を入れる項目。読むときに cleanFontName を通す。 */
const FONT_NAME_KEYS: ReadonlySet<keyof Preferences> = new Set([
  "customFont",
  "bodyCustomFont",
  "sansFont",
  "serifFont",
  "monoFont",
]);

/**
 * フォント名から、CSS の値を壊す文字を取り除く。
 * 引用符の中に入れて使うので、引用符・バックスラッシュ・タグの記号などは通さない。
 * 「M+ 1p」「Source Han Sans (JP)」のような名前は使えるよう、+ と () は残す。
 */
export function cleanFontName(name: string): string {
  return name
    .replace(/[^\p{L}\p{N} _.+()-]/gu, "")
    .trim()
    .slice(0, 100);
}

const SANS = '"Gen Interface JP", ui-sans-serif, system-ui, sans-serif';
const HEADING = `"Gen Interface JP Display", ${SANS}`;
const SYSTEM = "system-ui, sans-serif";
// 種類ごとのフォントを指定していないときは、OS ごとの代表的な日本語フォントを並べ、
// どれも無ければブラウザーが選ぶフォント (総称ファミリー) に任せる。
const GOTHIC =
  '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "YuGothic", "Noto Sans JP", "Noto Sans CJK JP", Meiryo, sans-serif';
const SERIF =
  '"Noto Serif JP", "Yu Mincho", "YuMincho", "Hiragino Mincho ProN", serif';
const MONO =
  'ui-monospace, "SFMono-Regular", Consolas, "Noto Sans Mono CJK JP", monospace';

type GenericFont = "sans" | "serif" | "mono";
type GenericFontNames = Pick<
  Preferences,
  "sansFont" | "serifFont" | "monoFont"
>;

/** 名前を指定したフォントを先頭に置く。名前が空なら、続きだけを返す。 */
function withFont(name: string, fallback: string): string {
  const cleaned = cleanFontName(name);
  return cleaned ? `"${cleaned}", ${fallback}` : fallback;
}

/**
 * ゴシック体・明朝体・等幅の font-family。種類ごとのフォントを設定していれば先頭に置く
 * (その端末に無いフォントでも、続きのフォントで表示できる)。
 */
export function genericFontFamily(
  kind: GenericFont,
  preferences: Partial<GenericFontNames> = {},
): string {
  switch (kind) {
    case "serif":
      return withFont(preferences.serifFont ?? "", SERIF);
    case "mono":
      return withFont(preferences.monoFont ?? "", MONO);
    default:
      return withFont(preferences.sansFont ?? "", GOTHIC);
  }
}

/** 画面のフォント (本文用・見出し用・等幅) の font-family。 */
export function appFontFamily(
  preferences: Pick<Preferences, "font" | "customFont"> &
    Partial<GenericFontNames>,
): { sans: string; heading: string; mono: string } {
  const mono = genericFontFamily("mono", preferences);
  const same = (family: string) => ({ sans: family, heading: family, mono });
  switch (preferences.font) {
    case "system":
      return same(SYSTEM);
    case "sans":
    case "serif":
    case "mono":
      return same(genericFontFamily(preferences.font, preferences));
    case "custom": {
      const name = cleanFontName(preferences.customFont);
      if (!name) return { sans: SANS, heading: HEADING, mono };
      return same(`"${name}", ${SANS}`);
    }
    default:
      return { sans: SANS, heading: HEADING, mono };
  }
}

type BodyFontPreferences = Pick<Preferences, "bodyFont"> &
  Partial<GenericFontNames & Pick<Preferences, "bodyCustomFont">>;

/** フォントの指定が無いメール本文に使う font-family。 */
export function bodyFontFamily(preferences: BodyFontPreferences): string {
  // 本文のゴシック体は、指定が無ければ今までどおり端末の画面のフォントにする。
  const sans = withFont(preferences.sansFont ?? "", SYSTEM);
  switch (preferences.bodyFont) {
    case "serif":
    case "mono":
      return genericFontFamily(preferences.bodyFont, preferences);
    case "custom":
      return withFont(preferences.bodyCustomFont ?? "", sans);
    default:
      return sans;
  }
}

/** メール本文 (iframe の中) に付けるスタイル。 */
export function bodyStyle(
  preferences: BodyFontPreferences &
    Pick<Preferences, "bodyFontSize" | "bodyLineHeight">,
): string {
  return `font-family:${bodyFontFamily(preferences)};font-size:${preferences.bodyFontSize}px;line-height:${preferences.bodyLineHeight}`;
}

/**
 * メール本文 (iframe の中) に足すスタイルの規則。
 * 等幅のフォントを設定していれば、フォントの指定が無い等幅の部分 (pre、code など) に使う。
 * メール側のスタイルより前に置くので、メール側の指定があれば、そちらが使われる。
 */
export function bodyExtraCss(preferences: Partial<GenericFontNames>): string {
  if (!cleanFontName(preferences.monoFont ?? "")) return "";
  return `pre,code,kbd,samp,tt,listing,plaintext,xmp{font-family:${genericFontFamily("mono", preferences)}}`;
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
