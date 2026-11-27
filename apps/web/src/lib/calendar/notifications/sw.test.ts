import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

/**
 * public/sw.js (素の JS) の予定の通知の部分。ファイルを偽の self の上で読み込み、
 * 中身を決める関数とイベントの処理を確かめる。
 */
const SOURCE = readFileSync(
  fileURLToPath(new URL("../../../../public/sw.js", import.meta.url)),
  "utf8",
);

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

type Listener = (event: unknown) => void;

function loadWorker(windows: { url: string }[] = []) {
  const listeners: Record<string, Listener> = {};
  const posted: unknown[] = [];
  const opened: string[] = [];
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const self = {
    location: { origin: "https://orbit.example" },
    addEventListener: (type: string, listener: Listener) => {
      listeners[type] = listener;
    },
    skipWaiting: () => {},
    registration: {
      showNotification: async (
        title: string,
        options: Record<string, unknown>,
      ) => {
        shown.push({ title, options });
      },
    },
    clients: {
      matchAll: async () =>
        windows.map((client) => ({
          ...client,
          postMessage: (message: unknown) => posted.push(message),
          focus: async () => {},
        })),
      openWindow: async (url: string) => {
        opened.push(url);
      },
      claim: async () => {},
    },
  };
  const exports = new Function(
    "self",
    `${SOURCE}\nreturn { calendarNotification, calendarEventPath, rsvpActions };`,
  )(self) as {
    calendarNotification: (
      data: unknown,
      max: number,
    ) => { title: string; options: Record<string, unknown> };
    calendarEventPath: (
      target: { eventId: string; recurrenceId: string | null } | null,
    ) => string;
    rsvpActions: (max: number) => { action: string }[];
  };
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    listeners[type]?.({
      ...event,
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits);
  };
  return { exports, dispatch, posted, opened, shown };
}

const invite = {
  kind: "event-invite",
  title: "招待: 定例会議",
  body: "山田 太郎 さんから · 11月28日(土) 10:00〜11:00",
  tag: `cal-inv:${ID}`,
  eventId: ID,
  recurrenceId: null,
  rsvp: {
    url: "https://api.example/v1/notification-actions/event",
    token: "t",
  },
};

describe("sw.js の予定の通知", () => {
  it("招待には出欠のボタン (2 つなら参加・不参加)", () => {
    const { exports } = loadWorker();
    const two = exports.calendarNotification(invite, 2);
    expect(two.title).toBe("招待: 定例会議");
    expect(two.options.actions).toEqual([
      { action: "accepted", title: "参加" },
      { action: "declined", title: "不参加" },
    ]);
    expect(two.options.tag).toBe(`cal-inv:${ID}`);
    expect(two.options.data).toEqual({
      kind: "event-invite",
      eventId: ID,
      recurrenceId: null,
      title: "招待: 定例会議",
      action: invite.rsvp,
    });
    expect(exports.rsvpActions(3).map((b) => b.action)).toEqual([
      "accepted",
      "tentative",
      "declined",
    ]);
  });

  it("リマインダーにはボタンを付けない。ID の形が違えば開く予定を持たない", () => {
    const { exports } = loadWorker();
    const reminder = exports.calendarNotification(
      {
        kind: "event-reminder",
        title: "定例",
        body: "10:00",
        tag: "cal-rem:x",
        eventId: "bad",
        rsvp: invite.rsvp,
      },
      2,
    );
    expect(reminder.options.actions).toBeUndefined();
    expect((reminder.options.data as { eventId: unknown }).eventId).toBeNull();
  });

  it("予定の URL", () => {
    const { exports } = loadWorker();
    expect(
      exports.calendarEventPath({ eventId: ID, recurrenceId: "2026-11-27" }),
    ).toBe(`/calendar/events/${ID}?o=2026-11-27`);
    expect(exports.calendarEventPath(null)).toBe("/calendar");
  });

  it("push の kind で予定とメールを分ける", async () => {
    const { dispatch, shown } = loadWorker();
    await dispatch("push", { data: { json: () => invite } });
    await dispatch("push", {
      data: {
        json: () => ({ title: "新着", body: "件名", tag: "m", messageId: "x" }),
      },
    });
    expect(shown[0]?.title).toBe("招待: 定例会議");
    expect((shown[1]?.options.data as { messageId: unknown }).messageId).toBe(
      "x",
    );
  });

  it("押すと開いている画面へ open-event、無ければ予定の URL を開く", async () => {
    const data = {
      kind: "event-reminder",
      eventId: ID,
      recurrenceId: null,
      action: null,
    };
    const open = loadWorker([{ url: "https://orbit.example/messages" }]);
    await open.dispatch("notificationclick", {
      action: "",
      notification: { data, close: () => {} },
    });
    expect(open.posted).toEqual([
      { type: "open-event", eventId: ID, recurrenceId: null },
    ]);
    const closed = loadWorker();
    await closed.dispatch("notificationclick", {
      action: "",
      notification: { data, close: () => {} },
    });
    expect(closed.opened).toEqual([`/calendar/events/${ID}`]);
  });

  it("出欠のボタンは合言葉で返事をし、失敗したら知らせる", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { dispatch, shown } = loadWorker();
      await dispatch("notificationclick", {
        action: "accepted",
        notification: {
          tag: `cal-inv:${ID}`,
          data: {
            kind: "event-invite",
            eventId: ID,
            recurrenceId: null,
            title: "招待: 定例会議",
            action: invite.rsvp,
          },
          close: () => {},
        },
      });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe(invite.rsvp.url);
      expect(JSON.parse(String(init.body))).toMatchObject({
        eventId: ID,
        status: "accepted",
        token: "t",
      });
      expect(shown[0]?.title).toBe("出欠を反映できませんでした");
      expect(shown[0]?.options.body).toBe("定例会議");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
