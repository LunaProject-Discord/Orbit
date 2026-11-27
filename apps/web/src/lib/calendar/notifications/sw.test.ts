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

/** 画面が登録する URL (sw.js?api=<API の URL>)。 */
const SW_HREF = `https://orbit.example/sw.js?api=${encodeURIComponent("https://api.example")}`;

function loadWorker(windows: { url: string }[] = [], href = SW_HREF) {
  const listeners: Record<string, Listener> = {};
  const posted: unknown[] = [];
  const opened: string[] = [];
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const self = {
    location: { origin: new URL(href).origin, href },
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

  it("よそのサイトの URL ならボタンを付けず、押されても合言葉を送らない (M4)", async () => {
    const { exports } = loadWorker();
    for (const url of [
      "https://evil.example/v1/notification-actions/event",
      "https://api.example/v1/notification-actions/other",
      "https://api.example/v1/notification-actions/event?next=x",
      "https://user:pass@api.example/v1/notification-actions/event",
      "http://api.example:8080/v1/notification-actions/event",
    ]) {
      const built = exports.calendarNotification(
        { ...invite, rsvp: { url, token: "t" } },
        3,
      );
      expect(built.options.actions).toBeUndefined();
      expect((built.options.data as { action: unknown }).action).toBeNull();
    }
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const worker = loadWorker();
      // 古い通知 (検査の前に出たもの) の data に、よその URL が入っていた。
      await worker.dispatch("notificationclick", {
        action: "accepted",
        notification: {
          tag: `cal-inv:${ID}`,
          data: {
            kind: "event-invite",
            eventId: ID,
            recurrenceId: null,
            title: "招待: 定例会議",
            action: {
              url: "https://evil.example/v1/notification-actions/event",
              token: "t",
            },
          },
          close: () => {},
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(worker.shown[0]?.title).toBe("出欠を反映できませんでした");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("API の URL が渡されていない古い登録では、このサイトの /v1 だけを許す", () => {
    const { exports } = loadWorker([], "https://orbit.example/sw.js");
    expect(
      exports.calendarNotification(
        {
          ...invite,
          rsvp: {
            url: "https://orbit.example/v1/notification-actions/event",
            token: "t",
          },
        },
        2,
      ).options.actions,
    ).toHaveLength(2);
    expect(
      exports.calendarNotification(invite, 2).options.actions,
    ).toBeUndefined();
  });

  it("出欠は転送をたどらずに送り、404 は済んだものとして扱う", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { dispatch, shown } = loadWorker();
      await dispatch("notificationclick", {
        action: "declined",
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
      const [, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(init.redirect).toBe("error");
      expect(shown).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ボタンの無い失敗の知らせを押すと、その予定を開く", async () => {
    const { dispatch, opened } = loadWorker();
    await dispatch("notificationclick", {
      action: "",
      notification: {
        data: {
          kind: "event-invite",
          eventId: ID,
          recurrenceId: "2026-11-28",
          title: "招待: 定例会議",
          action: null,
        },
        close: () => {},
      },
    });
    expect(opened).toEqual([`/calendar/events/${ID}?o=2026-11-28`]);
  });
});

describe("sw.js のメールの通知のボタン", () => {
  const MAIL_ACTION_URL = "https://api.example/v1/notification-actions";
  const mailPush = (url: string) => ({
    title: "新着",
    body: "件名",
    tag: "m",
    messageId: "x",
    actions: {
      url,
      token: "t",
      buttons: [{ id: "read", title: "既読にする" }],
    },
  });
  const clickMail = (url: string) => ({
    action: "read",
    notification: {
      tag: "m",
      data: { messageId: "x", title: "件名", action: { url, token: "t" } },
      close: () => {},
    },
  });

  it("自分の API の受け口なら、ボタンを付けて合言葉で操作する (転送はたどらない)", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { dispatch, shown } = loadWorker();
      await dispatch("push", {
        data: { json: () => mailPush(MAIL_ACTION_URL) },
      });
      expect(shown[0]?.options.actions).toEqual([
        { action: "read", title: "既読にする" },
      ]);
      expect((shown[0]?.options.data as { action: unknown }).action).toEqual({
        url: MAIL_ACTION_URL,
        token: "t",
      });
      await dispatch("notificationclick", clickMail(MAIL_ACTION_URL));
      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe(MAIL_ACTION_URL);
      expect(init.redirect).toBe("error");
      expect(JSON.parse(String(init.body))).toEqual({
        messageId: "x",
        action: "read",
        token: "t",
      });
      expect(shown).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("よそのサイトや違うパスの URL ならボタンを付けず、押されても合言葉を送らない", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      for (const url of [
        "https://evil.example/v1/notification-actions",
        "https://api.example/v1/notification-actions/event",
        "https://api.example/v1/notification-actions/reply",
        "https://api.example/v1/notification-actions?next=x",
        "https://api.example/v1/notification-actions#x",
        "https://user:pass@api.example/v1/notification-actions",
        "http://api.example/v1/notification-actions",
        "javascript:alert(1)",
      ]) {
        const worker = loadWorker();
        await worker.dispatch("push", { data: { json: () => mailPush(url) } });
        expect(worker.shown[0]?.options.actions).toBeUndefined();
        expect(
          (worker.shown[0]?.options.data as { action: unknown }).action,
        ).toBeNull();
        // 古い通知 (検査の前に出たもの) の data に、よその URL が入っていた。
        await worker.dispatch("notificationclick", clickMail(url));
        expect(worker.shown[1]?.title).toBe("操作を反映できませんでした");
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("API の URL が渡されていない古い登録では、このサイトの /v1 だけを許す", async () => {
    const worker = loadWorker([], "https://orbit.example/sw.js");
    await worker.dispatch("push", {
      data: {
        json: () => mailPush("https://orbit.example/v1/notification-actions"),
      },
    });
    await worker.dispatch("push", {
      data: { json: () => mailPush(MAIL_ACTION_URL) },
    });
    expect(worker.shown[0]?.options.actions).toHaveLength(1);
    expect(worker.shown[1]?.options.actions).toBeUndefined();
  });

  it("API が /api の下にあれば、その下の受け口だけを許す", async () => {
    const worker = loadWorker(
      [],
      `https://orbit.example/sw.js?api=${encodeURIComponent("https://orbit.example/api/")}`,
    );
    await worker.dispatch("push", {
      data: {
        json: () =>
          mailPush("https://orbit.example/api/v1/notification-actions"),
      },
    });
    await worker.dispatch("push", {
      data: {
        json: () => mailPush("https://orbit.example/v1/notification-actions"),
      },
    });
    expect(worker.shown[0]?.options.actions).toHaveLength(1);
    expect(worker.shown[1]?.options.actions).toBeUndefined();
  });
});
