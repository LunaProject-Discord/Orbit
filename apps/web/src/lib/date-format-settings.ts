import { useSyncExternalStore } from "react";
import { getSettings, saveDateFormat } from "@/lib/api";
import {
  DATE_FORMAT_MAX_LENGTH,
  type DateStyle,
  DEFAULT_DATE_STYLE,
  HOUR12_TIME_FORMATS,
} from "@/lib/format";

// ---------------------------------------------------------------------------
// 日付と時刻の形式。サーバーに保存してどの端末でも同じにし、前回の内容を端末にも残す。
// ---------------------------------------------------------------------------

const CACHE_KEY = "mail.date-format.v1";
/** 以前 (端末ごとの設定だったころ) の保存先。 */
const LEGACY_KEY = "mail.preferences.v1";

const FORMAT_KEYS = [
  "shortDateFormat",
  "monthDayFormat",
  "longDateFormat",
  "shortTimeFormat",
  "longTimeFormat",
] as const;

/** 保存してあった値を読む。形の合わない項目は標準の値にする。 */
export function parseDateStyle(saved: unknown): DateStyle {
  const record =
    typeof saved === "object" && saved !== null
      ? (saved as Record<string, unknown>)
      : {};
  const result: DateStyle = { ...DEFAULT_DATE_STYLE };
  if (record.listDate === "auto" || record.listDate === "datetime") {
    result.listDate = record.listDate;
  }
  for (const key of FORMAT_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      result[key] = value.slice(0, DATE_FORMAT_MAX_LENGTH);
    }
  }
  return result;
}

/**
 * 端末ごとの設定だったころに、この端末で選んでいた形式。
 * 標準のままなら null (サーバーへ移すものが無い)。
 */
export function legacyDateStyle(raw: string | null): DateStyle | null {
  let saved: unknown;
  try {
    saved = JSON.parse(raw ?? "null");
  } catch {
    return null;
  }
  if (typeof saved !== "object" || saved === null) return null;
  const record = saved as Record<string, unknown>;
  const style = parseDateStyle(record);
  // さらに前の「12 時間制」の設定は、時刻の書式を選んでいなければ書式に移す。
  if (
    record.hour12 === true &&
    record.shortTimeFormat === undefined &&
    record.longTimeFormat === undefined
  ) {
    Object.assign(style, HOUR12_TIME_FORMATS);
  }
  return sameStyle(style, DEFAULT_DATE_STYLE) ? null : style;
}

function sameStyle(a: DateStyle, b: DateStyle): boolean {
  return (
    a.listDate === b.listDate && FORMAT_KEYS.every((key) => a[key] === b[key])
  );
}

let current: DateStyle | null = null;
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

function read(): DateStyle {
  if (current) return current;
  const store = storage();
  const cached = store?.getItem(CACHE_KEY) ?? null;
  if (cached !== null) {
    try {
      current = parseDateStyle(JSON.parse(cached));
    } catch {
      current = DEFAULT_DATE_STYLE;
    }
  } else {
    // サーバーから届くまでは、この端末で前に選んでいた形式を使う。
    current =
      legacyDateStyle(store?.getItem(LEGACY_KEY) ?? null) ?? DEFAULT_DATE_STYLE;
  }
  return current;
}

function set(next: DateStyle) {
  if (current && sameStyle(current, next)) return;
  current = next;
  try {
    storage()?.setItem(CACHE_KEY, JSON.stringify(next));
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

/** いまの日付と時刻の形式。変わると、使っている部品を描き直す。 */
export function useDateStyle(): DateStyle {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_DATE_STYLE);
}

/** いまの日付と時刻の形式 (部品の外で文字を作るとき用)。 */
export function currentDateStyle(): DateStyle {
  return read();
}

/**
 * サーバーから設定を取得し直す (起動時と、ほかの端末で変えたとき)。
 * サーバーにまだ無く、この端末で前に形式を選んでいたなら、それをサーバーへ移す。
 */
export async function refreshDateStyle(
  load: () => Promise<{ dateFormat: unknown }> = getSettings,
  save: (style: DateStyle) => Promise<void> = saveDateFormat,
): Promise<void> {
  try {
    const { dateFormat } = await load();
    if (saving > 0) return;
    if (dateFormat === null || dateFormat === undefined) {
      const legacy = legacyDateStyle(storage()?.getItem(LEGACY_KEY) ?? null);
      if (legacy) {
        await changeDateStyle(legacy, save);
        return;
      }
    }
    set(parseDateStyle(dateFormat));
  } catch {
    // 取得できない間 (オフラインなど) は、前回の内容を使う。
  }
}

/**
 * 設定を変える。画面にはすぐ反映し、サーバーに保存できなければ元に戻す。
 * 保存できたかを返す。
 */
export async function changeDateStyle(
  patch: Partial<DateStyle>,
  save: (style: DateStyle) => Promise<void> = saveDateFormat,
): Promise<boolean> {
  const previous = read();
  const next = parseDateStyle({ ...previous, ...patch });
  set(next);
  saving += 1;
  try {
    await save(next);
    return true;
  } catch {
    // この後に選び直していなければ、保存できていた内容へ戻す。
    if (current === next) set(previous);
    return false;
  } finally {
    saving -= 1;
  }
}

/** テスト用: 保持している設定を捨てる。 */
export function resetDateStyleForTest() {
  current = null;
  saving = 0;
}
