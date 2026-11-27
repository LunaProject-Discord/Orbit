import { describe, expect, it } from "vitest";
import { CalendarNotImplementedError } from "./provider.js";
import { calendarProviderFor } from "./registry.js";
import { FakeCalendarProvider } from "./testing/fake-provider.js";
import {
  describeCalendarProviderContract,
  makeCalendarRow,
  makeProviderContext,
} from "./testing/provider-contract.js";

describe("calendarProviderFor", () => {
  const base = {
    provider: "generic",
    authType: "password",
    protocol: "imap",
    caldavUrl: null,
  } as const;

  it("アカウントに合うプロバイダを選ぶ", () => {
    expect(
      calendarProviderFor({ ...base, provider: "gmail", authType: "oauth2" })
        ?.source,
    ).toBe("google");
    expect(
      calendarProviderFor({
        ...base,
        provider: "microsoft",
        authType: "oauth2",
        protocol: "graph",
      })?.source,
    ).toBe("microsoft");
    expect(calendarProviderFor({ ...base, provider: "icloud" })?.source).toBe(
      "caldav",
    );
    expect(
      calendarProviderFor({ ...base, caldavUrl: "https://dav.example.com/" })
        ?.source,
    ).toBe("caldav");
  });

  it("対応していないアカウントは null (アプリ パスワードの Gmail、IMAP の Outlook など)", () => {
    expect(calendarProviderFor(base)).toBeNull();
    expect(calendarProviderFor({ ...base, provider: "gmail" })).toBeNull();
    expect(calendarProviderFor({ ...base, provider: "microsoft" })).toBeNull();
  });

  it("雛形のプロバイダは、すべて CalendarNotImplementedError を投げる", async () => {
    const ctx = makeProviderContext();
    const calendar = makeCalendarRow();
    for (const account of [
      { ...base, provider: "gmail", authType: "oauth2" },
      { ...base, protocol: "graph" },
      { ...base, provider: "icloud" },
    ] as const) {
      const provider = calendarProviderFor(account);
      if (!provider) throw new Error("プロバイダがありません。");
      await expect(provider.listCalendars(ctx)).rejects.toBeInstanceOf(
        CalendarNotImplementedError,
      );
      await expect(
        provider.syncEvents(ctx, calendar, {
          syncToken: null,
          pageCursor: null,
          knownEtags: async () => new Map(),
        }),
      ).rejects.toBeInstanceOf(CalendarNotImplementedError);
      expect(() => provider.parseRaw("", calendar)).toThrow(
        CalendarNotImplementedError,
      );
    }
  });
});

// 偽のプロバイダが interface の約束を守っていること (共通テストそのものの確認も兼ねる)。
describeCalendarProviderContract(
  "偽のプロバイダ",
  () => {
    const provider = new FakeCalendarProvider();
    provider.pageSize = 2;
    provider.calendars = [
      {
        remoteId: "primary",
        name: "主のカレンダー",
        description: null,
        color: "#336699",
        timeZone: "Asia/Tokyo",
        readOnly: false,
        url: null,
        defaultReminders: null,
        kind: "normal",
      },
    ];
    provider.putRemote("primary", [
      { remoteId: "a" },
      { remoteId: "b" },
      { remoteId: "c" },
      {
        remoteId: "d",
        uid: "series",
        rrule: "FREQ=WEEKLY",
      },
      {
        remoteId: "e",
        uid: "series",
        recurrenceId: "2026-12-08T01:00:00Z",
        parentRemoteId: "d",
      },
    ]);
    return { provider, ctx: makeProviderContext() };
  },
  { writable: true },
);
