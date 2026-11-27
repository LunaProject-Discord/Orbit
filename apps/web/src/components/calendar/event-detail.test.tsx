// @vitest-environment happy-dom

import { DEFAULT_CALENDAR_NOTIFICATION_SETTINGS } from "@orbit/core/calendar-notifications";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EventDetail,
  eventReminderLabels,
  rsvpNote,
} from "@/components/calendar/event-detail";
import { RsvpButtons } from "@/components/calendar/rsvp-buttons";
import type { DisplayItem } from "@/components/calendar/types";
import type { Attendee, Calendar, CalendarEvent } from "@/lib/calendar/api";
import { toLocal } from "@/lib/calendar/dates";
import { calendar, event } from "@/lib/calendar/offline/test-support";

const me = (status: Attendee["status"]): Attendee => ({
  email: "me@example.com",
  name: "あおい",
  role: "required",
  status,
  self: true,
});
const boss: Attendee = {
  email: "boss@example.com",
  name: "佐藤 健",
  role: "required",
  status: "accepted",
  self: false,
};

const invited = event({
  summary: "打ち合わせ",
  organizer: { email: "boss@example.com", name: "佐藤 健", self: false },
  attendees: [boss, me("needs_action")],
});

function itemOf(
  value: CalendarEvent,
  overrides: Partial<DisplayItem> = {},
): DisplayItem {
  const local = toLocal(
    {
      eventId: value.id,
      masterId: value.parentId ?? value.id,
      recurrenceId: value.recurrenceId,
      allDay: value.allDay,
      startAt: value.startAt,
      endAt: value.endAt,
      startDate: value.startDate,
      endDate: value.endDate,
    },
    "Asia/Tokyo",
  );
  if (!local) throw new Error("local");
  return {
    key: value.id,
    local,
    event: value,
    color: "#4f46e5",
    pending: false,
    repeating: false,
    readOnly: false,
    ...overrides,
  };
}

describe("出欠のボタン", () => {
  let container: HTMLDivElement;
  let root: Root;
  let anchor: HTMLElement;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    anchor = document.createElement("button");
    document.body.append(container, anchor);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    anchor.remove();
  });

  const button = (label: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) => element.textContent?.trim() === label,
    );

  function renderDetail(
    item: DisplayItem,
    onRespond: ((status: string) => void) | null = vi.fn(),
    cal: Calendar = calendar({ source: "google", scheduling: "server" }),
    accounts: { id: string; email: string }[] | null = null,
  ) {
    act(() =>
      root.render(
        <EventDetail
          item={item}
          anchor={anchor}
          calendar={cal}
          calendarLabel="個人"
          onEdit={null}
          onDelete={null}
          onRespond={onRespond}
          accounts={accounts}
          onClose={() => {}}
        />,
      ),
    );
  }

  it("RsvpButtons: いまの出欠を塗り、ほかを押すと onChange、注記を出す", () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <RsvpButtons value="tentative" onChange={onChange} note="注記" />,
      ),
    );
    expect(button("未定")?.getAttribute("aria-pressed")).toBe("true");
    expect(button("参加")?.getAttribute("aria-pressed")).toBe("false");
    act(() => button("未定")?.click());
    expect(onChange).not.toHaveBeenCalled();
    act(() => button("不参加")?.click());
    expect(onChange).toHaveBeenCalledWith("declined");
    expect(container.textContent).toContain("出席しますか?");
    expect(container.textContent).toContain("注記");
  });

  it("RsvpButtons: 未返信はどれも塗らず、disabled では押せない", () => {
    act(() =>
      root.render(<RsvpButtons value={null} disabled onChange={() => {}} />),
    );
    for (const label of ["参加", "未定", "不参加"]) {
      expect(button(label)?.getAttribute("aria-pressed")).toBe("false");
      expect(button(label)?.disabled).toBe(true);
    }
  });

  it("招待された予定では出欠のボタンを出し、押すと onRespond を呼ぶ", () => {
    const onRespond = vi.fn();
    renderDetail(itemOf(invited), onRespond);
    expect(document.body.textContent).toContain("出席しますか?");
    act(() => button("参加")?.click());
    expect(onRespond).toHaveBeenCalledWith("accepted");
  });

  it("いまの出欠を塗る (自分の行の status)", () => {
    renderDetail(itemOf({ ...invited, attendees: [boss, me("declined")] }));
    expect(button("不参加")?.getAttribute("aria-pressed")).toBe("true");
  });

  it.each([
    [
      "自分が主催する予定",
      itemOf({
        ...invited,
        organizer: { email: "me@example.com", self: true },
      }),
    ],
    ["取り消された予定", itemOf({ ...invited, status: "cancelled" })],
    ["読み取り専用のカレンダー", itemOf(invited, { readOnly: true })],
    ["自分が参加者でない予定", itemOf({ ...invited, attendees: [boss] })],
  ])("%s では出さない", (_label, item) => {
    renderDetail(item);
    expect(document.body.textContent).not.toContain("出席しますか?");
  });

  it("出欠に対応していない古いサーバー (カレンダーに scheduling が無い) では出さない", () => {
    renderDetail(itemOf(invited), vi.fn(), calendar({ source: "google" }));
    expect(document.body.textContent).not.toContain("出席しますか?");
  });

  it("共有カレンダーでは、self がアカウントの持ち主のときだけ出す", () => {
    const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
    const shared = calendar({
      source: "google",
      scheduling: "server",
      accountId: ACCOUNT,
      primary: false,
      accessRole: "writer",
    });
    // self の行は共有カレンダーの持ち主 (同僚)。
    renderDetail(itemOf(invited), vi.fn(), shared, [
      { id: ACCOUNT, email: "owner@example.com" },
    ]);
    expect(document.body.textContent).not.toContain("出席しますか?");
    // アカウントの一覧がまだ無いときも出さない。
    renderDetail(itemOf(invited), vi.fn(), shared, null);
    expect(document.body.textContent).not.toContain("出席しますか?");
    renderDetail(itemOf(invited), vi.fn(), shared, [
      { id: ACCOUNT, email: "me@example.com" },
    ]);
    expect(document.body.textContent).toContain("出席しますか?");
    renderDetail(itemOf(invited), vi.fn(), { ...shared, accessRole: "owner" }, [
      { id: ACCOUNT, email: "owner@example.com" },
    ]);
    expect(document.body.textContent).toContain("出席しますか?");
  });

  it("onRespond が無ければ出さない", () => {
    renderDetail(itemOf(invited), null);
    expect(document.body.textContent).not.toContain("出席しますか?");
  });

  it("招待を送らない CalDAV では「主催者には通知されません」を添える", () => {
    renderDetail(
      itemOf(invited),
      vi.fn(),
      calendar({ source: "caldav", scheduling: "none" }),
    );
    expect(document.body.textContent).toContain("主催者には通知されません");
  });
});

describe("rsvpNote", () => {
  const google = calendar({ source: "google", scheduling: "server" });
  it("繰り返しでは返事の届く範囲を添える", () => {
    expect(
      rsvpNote({ repeating: true, event: { parentId: null } }, google),
    ).toBe("すべての回に返事します");
    expect(
      rsvpNote({ repeating: true, event: { parentId: "m" } }, google),
    ).toBe("この回だけに返事します");
    expect(
      rsvpNote({ repeating: false, event: { parentId: null } }, google),
    ).toBeNull();
  });

  it("CalDAV で scheduling が無い (古いサーバー) ときも、通知されない側に倒す", () => {
    expect(
      rsvpNote(
        { repeating: false, event: { parentId: null } },
        calendar({ source: "caldav" }),
      ),
    ).toBe("主催者には通知されません (このカレンダーにだけ記録します)");
    expect(
      rsvpNote(
        { repeating: false, event: { parentId: null } },
        calendar({ source: "caldav", scheduling: "server" }),
      ),
    ).toBeNull();
  });
});

describe("予定の詳細の通知の表示", () => {
  const ready = (allDay: { minutes: number } | null) => ({
    status: "ready" as const,
    value: {
      calendarNotifications: {
        ...DEFAULT_CALENDAR_NOTIFICATION_SETTINGS,
        allDay,
      },
      timeZone: "Asia/Tokyo",
    },
  });
  const cal = calendar({
    defaultReminders: [{ method: "display", minutes: 10 }],
  });

  it("時刻のある予定は今までどおり", () => {
    expect(
      eventReminderLabels(
        { useDefaultReminders: true, reminders: [] },
        false,
        cal,
        ready(null),
      ),
    ).toEqual(["10 分前に通知"]);
  });

  it("終日の予定の既定は、利用者ごとの終日の既定", () => {
    const value = { useDefaultReminders: true, reminders: [] };
    expect(
      eventReminderLabels(value, true, cal, ready({ minutes: -540 })),
    ).toEqual(["当日 9:00に通知"]);
    expect(eventReminderLabels(value, true, cal, ready(null))).toEqual([]);
    // 古いサーバーでは、今までどおりカレンダーの既定 (表示は終日の形)。
    expect(
      eventReminderLabels(value, true, cal, {
        status: "unsupported",
        value: null,
      }),
    ).toEqual(["1 日前 23:50に通知"]);
  });

  it("終日の予定ごとの通知は「1 日前 9:00」の形", () => {
    expect(
      eventReminderLabels(
        {
          useDefaultReminders: false,
          reminders: [
            { method: "display", minutes: 900 },
            { method: "email", minutes: -480 },
          ],
        },
        true,
        cal,
        ready({ minutes: -540 }),
      ),
    ).toEqual(["1 日前 9:00に通知", "当日 8:00にメール"]);
  });
});
