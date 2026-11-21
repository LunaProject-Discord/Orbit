import type { Address } from "@/lib/api";

const timeFormat = new Intl.DateTimeFormat("ja-JP", {
  hour: "2-digit",
  minute: "2-digit",
});
const dayFormat = new Intl.DateTimeFormat("ja-JP", {
  month: "numeric",
  day: "numeric",
});
const yearFormat = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
});
const fullFormat = new Intl.DateTimeFormat("ja-JP", {
  dateStyle: "long",
  timeStyle: "short",
});

/** 一覧用の短い日時。今日なら時刻、今年なら月日、それ以外は年月日。 */
export function formatListDate(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  if (date.toDateString() === now.toDateString()) {
    return timeFormat.format(date);
  }
  if (date.getFullYear() === now.getFullYear()) {
    return dayFormat.format(date);
  }
  return yearFormat.format(date);
}

export function formatFullDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : fullFormat.format(date);
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
