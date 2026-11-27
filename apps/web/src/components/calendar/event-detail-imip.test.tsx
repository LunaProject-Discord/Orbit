// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EventDetail,
  inviteDeliveryLabel,
  rsvpNote,
} from "@/components/calendar/event-detail";
import type { DisplayItem } from "@/components/calendar/types";
import type { Attendee, Calendar, CalendarEvent } from "@/lib/calendar/api";
import { toLocal } from "@/lib/calendar/dates";
import { calendar, event } from "@/lib/calendar/offline/test-support";

/** 予定の詳細の、招待メール (段取り 8b) の文言 (imip-design 12.3)。 */

const me: Attendee = {
  email: "aoi@example.com",
  name: "あおい",
  role: "required",
  status: "needs_action",
  self: true,
};

function itemOf(value: CalendarEvent): DisplayItem {
  const local = toLocal(
    {
      eventId: value.id,
      masterId: value.id,
      recurrenceId: null,
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
  };
}

describe("rsvpNote (mail)", () => {
  const item = { repeating: false, event: { parentId: null, attendees: [me] } };
  it("返事のメールの送信元を出す。送れるアカウントが無ければ通知されない", () => {
    const mail = calendar({ scheduling: "mail" });
    expect(
      rsvpNote(item, mail, [
        { id: "a", email: "aoi@example.com", protocol: "imap", smtpHost: "s" },
      ]),
    ).toBe("返事は aoi@example.com から主催者にメールで送ります");
    expect(rsvpNote(item, mail, [])).toBe(
      "主催者には通知されません (返事を送れるメールアカウントがありません)",
    );
    expect(
      rsvpNote(
        item,
        calendar({ scheduling: "none", schedulingBlocked: "no_sender" }),
      ),
    ).toBe(
      "主催者には通知されません (返事を送れるメールアカウントがありません)",
    );
  });

  it("送信の状態", () => {
    expect(inviteDeliveryLabel({ inviteDelivery: "pending" })).toBe(
      "招待メールを送信中",
    );
    expect(inviteDeliveryLabel({ inviteDelivery: "failed" })).toBe(
      "招待メールを送れませんでした",
    );
    expect(inviteDeliveryLabel({})).toBeNull();
  });
});

describe("予定の詳細 (mail)", () => {
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

  const render = (
    value: CalendarEvent,
    cal: Calendar,
    onShowConflicts: (() => void) | null = null,
  ) =>
    act(() =>
      root.render(
        <EventDetail
          item={itemOf(value)}
          anchor={anchor}
          calendar={cal}
          calendarLabel="マイカレンダー"
          onEdit={null}
          onDelete={null}
          onRespond={vi.fn()}
          onShowConflicts={onShowConflicts}
          accounts={null}
          onClose={() => {}}
        />,
      ),
    );

  it("返事のコメントを名前の下に出し、送れなかった招待は「確認する」で一覧を開く", () => {
    const onShow = vi.fn();
    render(
      event({
        organizer: { email: "aoi@example.com", self: true },
        attendees: [
          { ...me, status: "accepted" },
          {
            email: "tanaka@example.com",
            name: "田中",
            role: "required",
            status: "declined",
            self: false,
            comment: "出張中です",
          },
        ],
        inviteDelivery: "failed",
      }),
      calendar({ scheduling: "mail" }),
      onShow,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("出張中です");
    expect(text).toContain("招待メールを送れませんでした");
    const link = [...document.body.querySelectorAll("button")].find(
      (item) => item.textContent === "確認する",
    );
    act(() => link?.click());
    expect(onShow).toHaveBeenCalled();
  });

  it("招待された予定 (mail) では、返事のメールの送信元を出欠ボタンの下に出す", () => {
    render(
      event({
        organizer: { email: "sato@example.com", self: false },
        attendees: [me],
        canRespond: true,
      }),
      calendar({ scheduling: "mail" }),
    );
    expect(document.body.textContent).toContain(
      "返事は aoi@example.com から主催者にメールで送ります",
    );
  });
});
