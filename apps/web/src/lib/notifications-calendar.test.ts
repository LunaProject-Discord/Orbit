// @vitest-environment happy-dom
import type { CalendarPushMessage } from "@orbit/core/calendar-notifications";
import { afterEach, describe, expect, it, vi } from "vitest";
import { showCalendarNotification } from "@/lib/notifications";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const invite: CalendarPushMessage = {
  kind: "event-invite",
  title: "招待: 定例会議",
  body: "山田 太郎 さんから",
  tag: `cal-inv:${ID}`,
  eventId: ID,
  rsvp: {
    url: "http://localhost:8787/v1/notification-actions/event",
    token: "t",
  },
};

describe("showCalendarNotification (サービスワーカーの無い page の Web)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("new Notification には actions を渡さない (渡すと例外になり何も出ない。L1)", async () => {
    const created: { title: string; options: NotificationOptions }[] = [];
    class FakeNotification {
      static permission = "granted";
      static maxActions = 2;
      onclick: (() => void) | null = null;
      constructor(
        title: string,
        options: NotificationOptions & { actions?: unknown },
      ) {
        if (options.actions) throw new TypeError("actions は SW の通知だけ");
        created.push({ title, options });
      }
      close() {}
    }
    vi.stubGlobal("Notification", FakeNotification);
    await showCalendarNotification(invite);
    expect(created).toHaveLength(1);
    expect(created[0]?.title).toBe("招待: 定例会議");
    expect((created[0]?.options.data as { kind: string }).kind).toBe(
      "event-invite",
    );
  });
});
