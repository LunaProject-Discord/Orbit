import type { CalendarEvent } from "@/lib/calendar/api";

/**
 * 端末内の検索 (2.3)。サーバーに届かないときだけ使う。
 * 題名・場所・メモに、空白で区切った語がすべて含まれる予定を、新しい順に返す。
 * 正規化は全角半角 (NFKC) と小文字化だけなので、サーバーの索引とは結果が少し違い得る。
 */

export function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function startOf(event: CalendarEvent): number {
  if (event.startAt) return Date.parse(event.startAt);
  if (event.startDate) return Date.parse(`${event.startDate}T00:00:00Z`);
  return 0;
}

export function searchLocal(
  events: Iterable<CalendarEvent>,
  q: string,
  limit = 50,
): CalendarEvent[] {
  const terms = normalizeText(q).split(/\s+/).filter(Boolean).slice(0, 10);
  if (terms.length === 0) return [];
  const found: CalendarEvent[] = [];
  for (const event of events) {
    const doc = normalizeText(
      [event.summary, event.location, event.description]
        .filter((value): value is string => Boolean(value))
        .join("\n"),
    );
    if (terms.every((term) => doc.includes(term))) found.push(event);
  }
  found.sort(
    (a, b) =>
      startOf(b) - startOf(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
  return found.slice(0, limit);
}
