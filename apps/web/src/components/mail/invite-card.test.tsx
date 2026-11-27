// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InviteCard, overlappingCount } from "@/components/mail/invite-card";
import type { MessageInvite } from "@/lib/api";
import type {
  Calendar,
  CalendarEvent,
  EventRange,
  Occurrence,
} from "@/lib/calendar/api";
import type { CalendarClient } from "@/lib/calendar/offline";
import { calendar, event } from "@/lib/calendar/offline/test-support";

const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const EVENT_ID = "00000000-0000-4000-8000-000000000e01";
const OTHER_ID = "00000000-0000-4000-8000-000000000e02";

function invite(overrides: Partial<MessageInvite> = {}): MessageInvite {
  return {
    method: "request",
    uid: "invite@example.com",
    sequence: 1,
    recurrenceId: null,
    summary: "メールの題名",
    location: "メールの場所",
    time: {
      allDay: false,
      startAt: "2026-12-10T01:00:00Z",
      endAt: "2026-12-10T02:00:00Z",
      startTimeZone: "Asia/Tokyo",
      endTimeZone: "Asia/Tokyo",
    },
    rrule: null,
    organizer: { email: "sato@example.com", name: "佐藤 花子" },
    attendeeCount: 3,
    reply: null,
    eventId: null,
    eventSequence: null,
    ...overrides,
  };
}

function occurrenceOf(item: CalendarEvent): Occurrence {
  return {
    eventId: item.id,
    masterId: item.id,
    recurrenceId: null,
    allDay: item.allDay,
    startAt: item.startAt,
    endAt: item.endAt,
    startDate: item.startDate,
    endDate: item.endDate,
  };
}

/** 決まった中身を返すだけの CalendarClient。 */
function fakeClient(calendars: Calendar[], events: CalendarEvent[]) {
  const data: EventRange = { events, occurrences: events.map(occurrenceOf) };
  const respond = vi.fn();
  // useSyncExternalStore で読むので、毎回同じ配列を返す。
  const none: never[] = [];
  const client = {
    subscribe: () => () => {},
    calendars: () => calendars,
    range: () => data,
    pendingFor: () => none,
    queue: () => none,
    conflicts: () => none,
    respond,
    storageFailed: () => false,
  } as unknown as CalendarClient;
  return { client, respond };
}

const googleCalendar = calendar({ source: "google", accountId: ACCOUNT });

const calendarEvent = (overrides: Partial<CalendarEvent> = {}) =>
  event({
    id: EVENT_ID,
    summary: "カレンダーの題名",
    location: "カレンダーの場所",
    startAt: "2026-12-10T01:00:00.000Z",
    endAt: "2026-12-10T02:00:00.000Z",
    sequence: 1,
    organizer: { email: "sato@example.com", name: "佐藤 花子" },
    attendees: [
      {
        email: "me@example.com",
        name: null,
        role: "required",
        status: "needs_action",
        self: true,
      },
      {
        email: "sato@example.com",
        name: null,
        role: "required",
        status: "accepted",
        self: false,
      },
    ],
    ...overrides,
  });

describe("メールの招待カード", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (value: MessageInvite, client: CalendarClient) =>
    act(() =>
      root.render(
        <InviteCard
          invite={value}
          accountId={ACCOUNT}
          client={client}
          timeZone="Asia/Tokyo"
        />,
      ),
    );
  const text = () => container.textContent ?? "";
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === label,
    );

  it("同じ予定があれば、カレンダーの値を出し、押すと client.respond を呼ぶ", () => {
    const { client, respond } = fakeClient([googleCalendar], [calendarEvent()]);
    render(invite({ eventId: EVENT_ID, eventSequence: 1 }), client);
    expect(text()).toContain("カレンダーの題名");
    expect(text()).toContain("カレンダーの場所");
    expect(text()).not.toContain("メールの題名");
    expect(text()).toContain("12月10日");
    expect(text()).toContain("10:00〜11:00");
    expect(text()).toContain("主催者: 佐藤 花子");
    expect(text()).toContain("出席しますか?");
    expect(text()).toContain("カレンダーで開く");
    expect(button("参加")?.getAttribute("aria-pressed")).toBe("false");
    act(() => button("不参加")?.click());
    expect(respond).toHaveBeenCalledWith(EVENT_ID, "declined");
  });

  it("いまの出欠のボタンを選ばれた見た目にする", () => {
    const { client } = fakeClient(
      [googleCalendar],
      [
        calendarEvent({
          attendees: [
            {
              email: "me@example.com",
              name: null,
              role: "required",
              status: "tentative",
              self: true,
            },
          ],
        }),
      ],
    );
    render(invite({ eventId: EVENT_ID, eventSequence: 1 }), client);
    expect(button("未定")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("メールの sequence が予定より小さければ「更新されています」を足す", () => {
    const { client } = fakeClient(
      [googleCalendar],
      [calendarEvent({ sequence: 4 })],
    );
    render(invite({ eventId: EVENT_ID, eventSequence: 4 }), client);
    expect(text()).toContain("この招待は更新されています");
  });

  it("自分が主催者の予定と、取り消された予定ではボタンを使えない", () => {
    const own = fakeClient(
      [googleCalendar],
      [
        calendarEvent({
          organizer: { email: "me@example.com", self: true } as never,
        }),
      ],
    );
    render(invite({ eventId: EVENT_ID, eventSequence: 1 }), own.client);
    expect(text()).not.toContain("出席しますか?");

    const cancelled = fakeClient(
      [googleCalendar],
      [calendarEvent({ status: "cancelled" })],
    );
    render(invite({ eventId: EVENT_ID, eventSequence: 1 }), cancelled.client);
    expect(button("参加")?.disabled).toBe(true);
  });

  it("同じ予定が無ければメールの値を出し、ボタンは出さない", () => {
    const { client } = fakeClient([googleCalendar], []);
    render(invite(), client);
    expect(text()).toContain("メールの題名");
    expect(text()).toContain("メールの場所");
    expect(text()).toContain("参加者 3 人");
    expect(text()).toContain("カレンダーにまだ届いていません");
    expect(button("参加")).toBeUndefined();
    expect(text()).not.toContain("カレンダーで開く");

    // Google / Microsoft のカレンダーが無いアカウントでは何も足さない。
    const local = fakeClient([calendar()], []);
    render(invite(), local.client);
    expect(text()).not.toContain("カレンダーにまだ届いていません");
  });

  it("同じ時間帯のほかの予定の件数を出す", () => {
    const { client } = fakeClient(
      [googleCalendar],
      [
        calendarEvent(),
        event({
          id: OTHER_ID,
          startAt: "2026-12-10T01:30:00.000Z",
          endAt: "2026-12-10T03:00:00.000Z",
        }),
      ],
    );
    render(invite({ eventId: EVENT_ID, eventSequence: 1 }), client);
    expect(text()).toContain("この時間に 1 件の予定があります");
  });

  it("CANCEL は取り消しを伝え、操作を出さない", () => {
    const { client } = fakeClient([googleCalendar], []);
    render(invite({ method: "cancel" }), client);
    expect(text()).toContain("この予定は取り消されました");
    expect(button("参加")).toBeUndefined();
  });

  it("REPLY は返事をした人と内容を出す", () => {
    const { client } = fakeClient([googleCalendar], []);
    render(
      invite({
        method: "reply",
        reply: {
          email: "suzuki@example.com",
          name: "鈴木",
          status: "declined",
        },
      }),
      client,
    );
    expect(text()).toContain("鈴木 さんからの出欠の返事");
    expect(text()).toContain("参加しません");
    expect(button("参加")).toBeUndefined();
  });
});

describe("overlappingCount", () => {
  it("招待の予定そのもの、取り消された予定、重ならない予定は数えない", () => {
    const target = calendarEvent();
    const events = [
      target,
      event({
        id: OTHER_ID,
        startAt: "2026-12-10T00:30:00.000Z",
        endAt: "2026-12-10T01:30:00.000Z",
      }),
      event({
        id: "00000000-0000-4000-8000-000000000e03",
        status: "cancelled",
        startAt: "2026-12-10T01:00:00.000Z",
        endAt: "2026-12-10T02:00:00.000Z",
      }),
      event({
        id: "00000000-0000-4000-8000-000000000e04",
        startAt: "2026-12-10T02:00:00.000Z",
        endAt: "2026-12-10T03:00:00.000Z",
      }),
    ];
    const data = { events, occurrences: events.map(occurrenceOf) };
    expect(
      overlappingCount(data, occurrenceOf(target), "Asia/Tokyo", EVENT_ID),
    ).toBe(1);
  });
});
