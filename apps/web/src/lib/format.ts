import type { Address } from "@/lib/api";

/** 日時の出し方 (設定で変えられる)。 */
export type DateStyle = {
  /** auto は今日なら時刻だけ、datetime は常に日付と時刻。 */
  listDate: "auto" | "datetime";
  /** 時刻を 12 時間制 (午前 / 午後) で出す。 */
  hour12: boolean;
};

const defaultStyle: DateStyle = { listDate: "auto", hour12: false };

const dayFormat = new Intl.DateTimeFormat("ja-JP", {
  month: "numeric",
  day: "numeric",
});
const yearFormat = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

function formatsFor(hour12: boolean) {
  return {
    time: new Intl.DateTimeFormat("ja-JP", {
      hour: hour12 ? "numeric" : "2-digit",
      minute: "2-digit",
      hour12,
    }),
    // 時刻の桁は、一覧 (time) と揃える (24 時間制では 00:31 のように 2 桁)。
    full: new Intl.DateTimeFormat("ja-JP", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: hour12 ? "numeric" : "2-digit",
      minute: "2-digit",
      hour12,
    }),
  };
}
const formats = { h12: formatsFor(true), h24: formatsFor(false) };
const formatsOf = (style: DateStyle) =>
  style.hour12 ? formats.h12 : formats.h24;

/**
 * 一覧用の短い日時。今日なら時刻、今年なら月日、それ以外は年月日。
 * 設定で「常に日付と時刻」にしていれば、日付の後ろに時刻も付ける。
 */
export function formatListDate(
  value: string,
  now = new Date(),
  style: DateStyle = defaultStyle,
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const time = formatsOf(style).time.format(date);
  const withTime = style.listDate === "datetime";
  if (date.toDateString() === now.toDateString()) {
    return withTime ? `${dayFormat.format(date)} ${time}` : time;
  }
  const day =
    date.getFullYear() === now.getFullYear()
      ? dayFormat.format(date)
      : yearFormat.format(date);
  return withTime ? `${day} ${time}` : day;
}

export function formatFullDate(
  value: string,
  style: DateStyle = defaultStyle,
): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : formatsOf(style).full.format(date);
}

/**
 * 幅の狭い見出し用の日時。時刻は必ず付け、日付は分かる分だけ省く
 * (今日なら時刻だけ、今年なら月日と時刻、それ以外は年月日と時刻)。
 */
export function formatCompactDate(
  value: string,
  now = new Date(),
  style: DateStyle = defaultStyle,
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const time = formatsOf(style).time.format(date);
  if (date.toDateString() === now.toDateString()) return time;
  const day =
    date.getFullYear() === now.getFullYear()
      ? dayFormat.format(date)
      : yearFormat.format(date);
  return `${day} ${time}`;
}

export function addressLabel(address: Address | undefined): string {
  if (!address) return "(差出人なし)";
  return address.name?.trim() || address.address;
}

export function addressFull(address: Address): string {
  return address.name?.trim()
    ? `${address.name.trim()} <${address.address}>`
    : address.address;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
