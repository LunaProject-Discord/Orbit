import { randomUUID } from "node:crypto";
import { normalizeRecurrenceId } from "@orbit/core";
import { describe, expect, it } from "vitest";
import type {
  CalendarProvider,
  CalendarRow,
  EventDelta,
  EventSnapshot,
  ProviderContext,
  RemoteCalendar,
  RemoteEvent,
} from "../provider.js";

/**
 * CalendarProvider の共通テスト (interface の約束を確かめる)。各プロバイダの担当は、
 * 自分のテストから describeCalendarProviderContract を呼び、偽のサーバー (fetch の差し替えなど)
 * の上で通す。本番のコードからは使わない。
 */

export type ContractSetup = {
  provider: CalendarProvider;
  ctx: ProviderContext;
  /** 書き込みを試すカレンダー。省けば listCalendars の最初のものから作る。 */
  calendar?: CalendarRow;
};

export type ContractOptions = {
  /** 作成・変更・削除を試す (読み取りだけのプロバイダは false)。 */
  writable: boolean;
  /** etag が違うときに conflict を返すかを試す。 */
  conflicts?: boolean;
};

/** テスト用の ProviderContext。account と auth は最小限の値を入れる。 */
export function makeProviderContext(
  overrides: Partial<ProviderContext> = {},
): ProviderContext {
  const now = new Date();
  return {
    account: {
      id: randomUUID(),
      userId: randomUUID(),
      email: "contract@example.com",
      displayName: null,
      provider: "gmail",
      authType: "oauth2",
      protocol: "imap",
      imapHost: null,
      imapPort: null,
      imapSecure: true,
      smtpHost: null,
      smtpPort: null,
      smtpSecure: false,
      allowLegacyTls: false,
      notifyNewMail: true,
      mailEnabled: true,
      calendarEnabled: true,
      oauthScopes: null,
      calendarError: null,
      caldavUrl: null,
      pushConnections: null,
      popLeaveOnServer: true,
      popDeleteAfterDays: null,
      username: "contract@example.com",
      credentialsEncrypted: "x",
      status: "active",
      lastError: null,
      pushSubscriptionId: null,
      pushExpiresAt: null,
      signatureHtml: null,
      sortOrder: null,
      color: null,
      icon: null,
      composeFormat: null,
      createdAt: now,
      updatedAt: now,
    },
    auth: { type: "oauth2", getAccessToken: async () => "test-token" },
    fetchFn: fetch,
    signal: new AbortController().signal,
    webhookBaseUrl: null,
    encryptionKey: Buffer.alloc(32),
    allowPrivateHosts: false,
    log: () => {},
    saveCalendarState: async () => {},
    ...overrides,
  };
}

/** テスト用のカレンダーの行。 */
export function makeCalendarRow(
  overrides: Partial<CalendarRow> = {},
): CalendarRow {
  const now = new Date();
  return {
    id: randomUUID(),
    userId: randomUUID(),
    accountId: randomUUID(),
    source: "google",
    remoteId: "primary",
    name: "カレンダー",
    description: null,
    color: null,
    timeZone: "Asia/Tokyo",
    readOnly: false,
    visible: true,
    sortOrder: null,
    url: null,
    pollIntervalSeconds: null,
    syncToken: null,
    etag: null,
    lastSyncedAt: null,
    syncAttemptedAt: null,
    lastError: null,
    pushChannelId: null,
    pushExpiresAt: null,
    defaultReminders: null,
    providerState: null,
    expandedUntil: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** RemoteCalendar から、テスト用のカレンダーの行を作る。 */
export function calendarRowFrom(
  remote: RemoteCalendar,
  overrides: Partial<CalendarRow> = {},
): CalendarRow {
  return makeCalendarRow({
    remoteId: remote.remoteId,
    name: remote.name,
    timeZone: remote.timeZone,
    readOnly: remote.readOnly,
    url: remote.url,
    ...overrides,
  });
}

/** テスト用の予定のスナップショット (DB の行と同じ形)。Orbit で作った直後の予定にする。 */
export function makeEventSnapshot(
  overrides: Partial<EventSnapshot> = {},
): EventSnapshot {
  const id = overrides.id ?? randomUUID();
  const now = new Date();
  return {
    id,
    userId: randomUUID(),
    calendarId: randomUUID(),
    uid: `${id}@orbit`,
    recurrenceId: null,
    parentId: null,
    remoteId: null,
    etag: null,
    summary: "契約テストの予定",
    location: null,
    description: null,
    status: "confirmed",
    busy: true,
    allDay: false,
    startAt: new Date("2026-12-10T01:00:00.000Z"),
    endAt: new Date("2026-12-10T02:00:00.000Z"),
    startDate: null,
    endDate: null,
    startTimeZone: "Asia/Tokyo",
    endTimeZone: "Asia/Tokyo",
    rrule: null,
    rdates: null,
    exdates: null,
    organizer: null,
    sequence: 0,
    conferenceUrl: null,
    useDefaultReminders: true,
    remoteUpdatedAt: null,
    fieldUpdatedAt: null,
    remoteDeletedAfter: null,
    raw: null,
    createdAt: now,
    updatedAt: now,
    attendees: [],
    reminders: [],
    ...overrides,
  };
}

/** syncEvents を最後のページまで読む。 */
export async function readAllPages(
  provider: CalendarProvider,
  ctx: ProviderContext,
  calendar: CalendarRow,
  syncToken: string | null,
  maxPages = 100,
): Promise<{ pages: EventDelta[]; events: RemoteEvent[] }> {
  const pages: EventDelta[] = [];
  let pageCursor: string | null = null;
  for (let index = 0; index < maxPages; index++) {
    const delta = await provider.syncEvents(ctx, calendar, {
      syncToken,
      pageCursor,
      knownEtags: async () => new Map(),
      knownEvents: async () => new Map(),
    });
    pages.push(delta);
    pageCursor = delta.nextPageCursor;
    if (pageCursor === null) {
      return { pages, events: pages.flatMap((page) => page.events) };
    }
  }
  throw new Error(`syncEvents が ${maxPages} ページで終わりませんでした。`);
}

/** 原本 (繰り返さない予定) の uid。原本は uid を省けない。 */
function masterUid(event: RemoteEvent): string {
  if (!event.uid) throw new Error("原本の予定に uid がありません。");
  return event.uid;
}

/** 予定 1 行分の形を確かめる。例外は uid を省いてよい (土台が原本から補う)。 */
function expectRemoteEvent(event: RemoteEvent) {
  expect(event.remoteId).toBeTruthy();
  if (event.recurrenceId === null) expect(event.uid).toBeTruthy();
  else expect(event.parentRemoteId).toBeTruthy();
  expect(typeof event.raw).toBe("string");
  if (event.recurrenceId !== null) {
    expect(normalizeRecurrenceId(event.recurrenceId)).toBe(event.recurrenceId);
  }
  expect(["confirmed", "tentative", "cancelled"]).toContain(event.status);
}

export function describeCalendarProviderContract(
  name: string,
  setup: () => Promise<ContractSetup> | ContractSetup,
  options: ContractOptions,
) {
  const prepare = async () => {
    const value = await setup();
    let calendar = value.calendar;
    if (!calendar) {
      const [first] = await value.provider.listCalendars(value.ctx);
      if (!first) throw new Error("カレンダーがありません。");
      calendar = calendarRowFrom(first, { source: value.provider.source });
    }
    return { ...value, calendar };
  };

  describe(`CalendarProvider の約束: ${name}`, () => {
    it("source と既定の確認間隔を持つ", async () => {
      const { provider } = await prepare();
      expect(["google", "microsoft", "caldav"]).toContain(provider.source);
      expect(provider.defaultPollSeconds).toBeGreaterThan(0);
    });

    it("listCalendars がカレンダーの一覧を返す", async () => {
      const { provider, ctx } = await prepare();
      const list = await provider.listCalendars(ctx);
      expect(list.length).toBeGreaterThan(0);
      for (const calendar of list) {
        expect(calendar.remoteId).toBeTruthy();
        expect(typeof calendar.name).toBe("string");
        expect(["normal", "birthdays"]).toContain(calendar.kind);
        if (calendar.color !== null) {
          expect(calendar.color).toMatch(/^#[0-9a-f]{6}$/i);
        }
      }
    });

    it("同期の位置が無ければ全件を返し、最後のページでだけ続きの位置を返す", async () => {
      const { provider, ctx, calendar } = await prepare();
      const { pages, events } = await readAllPages(
        provider,
        ctx,
        calendar,
        null,
      );
      for (const page of pages) expect(page.full).toBe(true);
      for (const page of pages.slice(0, -1)) {
        expect(page.nextSyncToken).toBeNull();
      }
      for (const event of events) expectRemoteEvent(event);
    });

    it("parseRaw で raw を同じ予定に戻せる", async () => {
      const { provider, ctx, calendar } = await prepare();
      const { events } = await readAllPages(provider, ctx, calendar, null);
      for (const event of events) {
        const parsed = provider.parseRaw(event.raw, calendar);
        const match = parsed.find(
          (item) =>
            (item.uid ?? null) === (event.uid ?? null) &&
            item.recurrenceId === event.recurrenceId,
        );
        expect(match).toBeDefined();
        expect(match?.summary).toBe(event.summary);
      }
    });

    if (!options.writable) return;

    it("作った予定を取り直せ、差分の同期にも出てくる", async () => {
      const { provider, ctx, calendar } = await prepare();
      const { pages } = await readAllPages(provider, ctx, calendar, null);
      const token = pages.at(-1)?.nextSyncToken ?? null;
      const created = await provider.createEvent(ctx, calendar, {
        event: makeEventSnapshot(),
        master: null,
        exceptions: [],
        fields: [],
      });
      expect(created.status).toBe("ok");
      if (created.status !== "ok") return;
      const [event] = created.events;
      if (!event) throw new Error("作った予定が返りませんでした。");
      expectRemoteEvent(event);
      expect(event.summary).toBe("契約テストの予定");
      const fetched = await provider.getEvent(ctx, calendar, {
        remoteId: event.remoteId,
        etag: event.etag,
        uid: masterUid(event),
        recurrenceId: null,
        parentRemoteId: null,
      });
      expect(fetched?.some((item) => item.remoteId === event.remoteId)).toBe(
        true,
      );
      if (token !== null) {
        const delta = await readAllPages(provider, ctx, calendar, token);
        expect(
          delta.events.some((item) => item.remoteId === event.remoteId),
        ).toBe(true);
      }
    });

    it("create は events.id から決まる ID で冪等で、2 回呼んでも予定は 1 つ", async () => {
      const { provider, ctx, calendar } = await prepare();
      const snapshot = makeEventSnapshot();
      const write = {
        event: snapshot,
        master: null,
        exceptions: [],
        fields: [],
      };
      const first = await provider.createEvent(ctx, calendar, write);
      expect(first.status).toBe("ok");
      if (first.status !== "ok") return;
      const remoteId = first.events[0]?.remoteId;
      // 結果を保存する前に止まり、もう一度呼ばれた。
      const second = await provider.createEvent(ctx, calendar, write);
      if (second.status === "ok") {
        expect(second.events[0]?.remoteId).toBe(remoteId);
      } else {
        expect(second).toEqual({ status: "conflict", remoteId });
      }
      const { events } = await readAllPages(provider, ctx, calendar, null);
      expect(
        events.filter(
          (item) => item.remoteId === remoteId && item.recurrenceId === null,
        ),
      ).toHaveLength(1);
    });

    it("変更、古い etag での競合、削除、削除後の gone", async () => {
      const { provider, ctx, calendar } = await prepare();
      const created = await provider.createEvent(ctx, calendar, {
        event: makeEventSnapshot(),
        master: null,
        exceptions: [],
        fields: [],
      });
      if (created.status !== "ok") throw new Error("作れませんでした。");
      const [event] = created.events;
      if (!event) throw new Error("作った予定が返りませんでした。");
      const uid = masterUid(event);
      const ref = {
        remoteId: event.remoteId,
        etag: event.etag,
        uid,
        recurrenceId: null,
        parentRemoteId: null,
      };
      const updated = await provider.updateEvent(ctx, calendar, ref, {
        event: makeEventSnapshot({
          remoteId: event.remoteId,
          etag: event.etag,
          uid,
          summary: "変えた",
        }),
        master: null,
        exceptions: [],
        fields: ["summary"],
      });
      expect(updated.status).toBe("ok");
      if (updated.status !== "ok") return;
      const after = updated.events.find((item) => item.recurrenceId === null);
      expect(after?.summary).toBe("変えた");

      if (options.conflicts !== false && event.etag !== null) {
        const stale = await provider.updateEvent(ctx, calendar, ref, {
          event: makeEventSnapshot({ uid, summary: "古い" }),
          master: null,
          exceptions: [],
          fields: ["summary"],
        });
        expect(stale.status).toBe("conflict");
      }

      const removed = await provider.deleteEvent(ctx, calendar, {
        ...ref,
        etag: after?.etag ?? null,
      });
      expect(removed.status).toBe("ok");
      expect(
        await provider.getEvent(ctx, calendar, { ...ref, etag: null }),
      ).toBeNull();
      const gone = await provider.updateEvent(
        ctx,
        calendar,
        { ...ref, etag: null },
        {
          event: makeEventSnapshot({ uid }),
          master: null,
          exceptions: [],
          fields: ["summary"],
        },
      );
      expect(gone.status).toBe("gone");
    });
  });
}
