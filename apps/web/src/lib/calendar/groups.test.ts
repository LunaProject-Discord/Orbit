import { describe, expect, it } from "vitest";
import type { Account } from "@/lib/api";
import type { Calendar } from "@/lib/calendar/api";
import { groupCalendars } from "@/lib/calendar/groups";

function account(id: string, patch: Partial<Account> = {}): Account {
  return {
    id,
    email: `${id}@example.com`,
    displayName: null,
    sortOrder: null,
    createdAt: `2026-01-0${id.length}T00:00:00Z`,
    calendarEnabled: true,
    calendarError: null,
    ...patch,
  } as Account;
}

function calendar(id: string, accountId: string | null): Calendar {
  return {
    id,
    accountId,
    source: accountId ? "google" : "local",
    name: id,
    sortOrder: null,
  } as Calendar;
}

describe("groupCalendars のカレンダーの同期の失敗", () => {
  it("アカウントの calendarError をまとまりに載せる", () => {
    const groups = groupCalendars(
      [calendar("c1", "a")],
      [account("a", { calendarError: "トークンが無効です" })],
    );
    expect(groups[0]).toMatchObject({ key: "a", error: "トークンが無効です" });
  });

  it("カレンダーがまだ無くても、失敗していればまとまりを出す", () => {
    const groups = groupCalendars(
      [],
      [account("a", { calendarError: "権限がありません" }), account("bb")],
    );
    expect(groups.map((group) => [group.key, group.calendars.length])).toEqual([
      ["a", 0],
    ]);
  });

  it("カレンダーを使っていないアカウントの古い失敗は出さない", () => {
    const groups = groupCalendars(
      [calendar("c1", "a")],
      [account("a", { calendarEnabled: false, calendarError: "古い失敗" })],
    );
    expect(groups[0]?.error).toBe(null);
  });
});
