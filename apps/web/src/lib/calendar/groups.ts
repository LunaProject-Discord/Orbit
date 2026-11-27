import type { Account } from "@/lib/api";
import type { Calendar } from "@/lib/calendar/api";
import { sortAccounts } from "@/lib/mailboxes";

/** サイドバーのカレンダーのまとまり (アカウントごと、Orbit 内、購読、その他)。 */
export type CalendarGroup = {
  key: string;
  name: string;
  /** アドレスとサービスの名前など。 */
  sub: string | null;
  calendars: Calendar[];
};

const PROVIDER_LABEL: Record<Calendar["source"], string> = {
  google: "Google",
  microsoft: "Microsoft",
  caldav: "CalDAV",
  ics: "ICS",
  local: "Orbit",
  holidays: "",
  birthdays: "",
};

function sortCalendars(calendars: Calendar[]): Calendar[] {
  return [...calendars].sort(
    (a, b) =>
      (a.sortOrder ?? Number.POSITIVE_INFINITY) -
        (b.sortOrder ?? Number.POSITIVE_INFINITY) ||
      a.name.localeCompare(b.name, "ja"),
  );
}

/**
 * カレンダーをサイドバーのまとまりに分ける。アカウントの並び順は Orbit 全体で共通
 * (メールのサイドバーと同じ sortOrder)。
 */
export function groupCalendars(
  calendars: readonly Calendar[],
  accounts: readonly Account[],
): CalendarGroup[] {
  const groups: CalendarGroup[] = [];
  const byAccount = new Map<string, Calendar[]>();
  const local: Calendar[] = [];
  const subscribed: Calendar[] = [];
  const other: Calendar[] = [];
  for (const calendar of calendars) {
    if (calendar.accountId) {
      const list = byAccount.get(calendar.accountId) ?? [];
      list.push(calendar);
      byAccount.set(calendar.accountId, list);
    } else if (calendar.source === "local") local.push(calendar);
    else if (calendar.source === "ics") subscribed.push(calendar);
    else other.push(calendar);
  }
  for (const account of sortAccounts([...accounts])) {
    const list = byAccount.get(account.id);
    if (!list) continue;
    byAccount.delete(account.id);
    const source = list[0]?.source;
    groups.push({
      key: account.id,
      name: account.displayName || account.email,
      sub: [account.email, source ? PROVIDER_LABEL[source] : ""]
        .filter(Boolean)
        .join(" · "),
      calendars: sortCalendars(list),
    });
  }
  // アカウントの一覧に無い (読み込み前など) カレンダー。
  for (const [key, list] of byAccount) {
    groups.push({
      key,
      name: "アカウント",
      sub: null,
      calendars: sortCalendars(list),
    });
  }
  if (local.length > 0) {
    groups.push({
      key: "local",
      name: "Orbit",
      sub: "このサーバーだけ",
      calendars: sortCalendars(local),
    });
  }
  if (subscribed.length > 0) {
    groups.push({
      key: "ics",
      name: "購読",
      sub: "ICS",
      calendars: sortCalendars(subscribed),
    });
  }
  if (other.length > 0) {
    groups.push({
      key: "other",
      name: "その他",
      sub: null,
      calendars: sortCalendars(other),
    });
  }
  return groups;
}
