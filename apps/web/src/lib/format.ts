import type { Address } from "@/lib/api";

/**
 * 日時の書式 (Windows の「地域」の設定と同じ書き方)。
 * yyyy / yy (年)、M / MM / MMM (月)、d / dd (日)、ddd / dddd (曜日)、
 * H / HH (24 時間制)、h / hh (12 時間制)、tt (午前 / 午後)、m / mm (分)、s / ss (秒)。
 * それ以外の文字はそのまま出る。記号の文字を出すときは '…' で囲むか \ を前に付ける。
 */
export type DateFormats = {
  /** 短い日付 (去年以前の日付)。 */
  shortDateFormat: string;
  /** 月日 (今年の日付)。 */
  monthDayFormat: string;
  /** 長い日付 (メールの見出し、ホバーで出す正確な日時)。 */
  longDateFormat: string;
  /** 短い時刻 (一覧、メールの見出し)。 */
  shortTimeFormat: string;
  /** 長い時刻 (ホバーで出す正確な日時)。 */
  longTimeFormat: string;
};

/** 日時の出し方 (設定で変えられる)。 */
export type DateStyle = DateFormats & {
  /** auto は今日なら時刻だけ、datetime は常に日付と時刻。 */
  listDate: "auto" | "datetime";
};

export const DEFAULT_DATE_FORMATS: DateFormats = {
  shortDateFormat: "yyyy/M/d",
  monthDayFormat: "M/d",
  longDateFormat: "yyyy年M月d日(ddd)",
  shortTimeFormat: "HH:mm",
  longTimeFormat: "HH:mm:ss",
};

/** 12 時間制を選んでいた端末の設定を移すときの時刻の書式。 */
export const HOUR12_TIME_FORMATS = {
  shortTimeFormat: "tth:mm",
  longTimeFormat: "tth:mm:ss",
} as const;

/** 書式に使える文字数の上限。 */
export const DATE_FORMAT_MAX_LENGTH = 64;

const defaultStyle: DateStyle = { listDate: "auto", ...DEFAULT_DATE_FORMATS };

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const TOKEN =
  /'[^']*'?|"[^"]*"?|\\.?|yyyy|yy|y|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|tt/g;

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/** 書式に従って日時を文字にする。書式が空なら空文字。 */
export function formatDateWith(date: Date, format: string): string {
  const hour = date.getHours();
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return format.replace(TOKEN, (token) => {
    switch (token) {
      case "yyyy":
        return pad(date.getFullYear(), 4);
      case "yy":
        return pad(date.getFullYear() % 100);
      case "y":
        return String(date.getFullYear() % 100);
      case "MMMM":
      case "MMM":
        return `${date.getMonth() + 1}月`;
      case "MM":
        return pad(date.getMonth() + 1);
      case "M":
        return String(date.getMonth() + 1);
      case "dddd":
        return `${WEEKDAYS[date.getDay()]}曜日`;
      case "ddd":
        return WEEKDAYS[date.getDay()] ?? "";
      case "dd":
        return pad(date.getDate());
      case "d":
        return String(date.getDate());
      case "HH":
        return pad(hour);
      case "H":
        return String(hour);
      case "hh":
        return pad(hour12);
      case "h":
        return String(hour12);
      case "mm":
        return pad(date.getMinutes());
      case "m":
        return String(date.getMinutes());
      case "ss":
        return pad(date.getSeconds());
      case "s":
        return String(date.getSeconds());
      case "tt":
        return hour < 12 ? "午前" : "午後";
    }
    // 囲んだ文字 ('…' / "…") と \ の後ろの 1 文字は、そのまま出す。
    if (token.startsWith("\\")) return token.slice(1);
    const quote = token[0];
    const closed = token.length > 1 && token.endsWith(quote ?? "");
    return token.slice(1, closed ? -1 : undefined);
  });
}

function parse(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 今日なら null、今年なら月日、それ以外は短い日付。 */
function dayPart(date: Date, now: Date, style: DateStyle): string | null {
  if (date.toDateString() === now.toDateString()) return null;
  return formatDateWith(
    date,
    date.getFullYear() === now.getFullYear()
      ? style.monthDayFormat
      : style.shortDateFormat,
  );
}

/**
 * 一覧用の短い日時。今日なら時刻、今年なら月日、それ以外は短い日付。
 * 設定で「常に日付と時刻」にしていれば、日付の後ろに時刻も付ける。
 */
export function formatListDate(
  value: string,
  now = new Date(),
  style: DateStyle = defaultStyle,
): string {
  const date = parse(value);
  if (!date) return "";
  const time = formatDateWith(date, style.shortTimeFormat);
  const day = dayPart(date, now, style);
  if (style.listDate !== "datetime") return day ?? time;
  return `${day ?? formatDateWith(date, style.monthDayFormat)} ${time}`;
}

/** メールの見出し用の日時 (長い日付 + 短い時刻)。 */
export function formatFullDate(
  value: string,
  style: DateStyle = defaultStyle,
): string {
  const date = parse(value);
  if (!date) return "";
  return `${formatDateWith(date, style.longDateFormat)} ${formatDateWith(date, style.shortTimeFormat)}`;
}

/**
 * ホバーで出す正確な日時 (長い日付 + 長い時刻。標準は 2026年11月24日(火) 09:35:12)。
 * 一覧などの短い日時に添えて、年月日・曜日・秒まで読めるようにする。
 */
export function formatExactDate(
  value: string,
  style: DateStyle = defaultStyle,
): string {
  const date = parse(value);
  if (!date) return "";
  return `${formatDateWith(date, style.longDateFormat)} ${formatDateWith(date, style.longTimeFormat)}`;
}

/**
 * 幅の狭い見出し用の日時。時刻は必ず付け、日付は分かる分だけ省く
 * (今日なら時刻だけ、今年なら月日と時刻、それ以外は短い日付と時刻)。
 */
export function formatCompactDate(
  value: string,
  now = new Date(),
  style: DateStyle = defaultStyle,
): string {
  const date = parse(value);
  if (!date) return "";
  const time = formatDateWith(date, style.shortTimeFormat);
  const day = dayPart(date, now, style);
  return day === null ? time : `${day} ${time}`;
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
