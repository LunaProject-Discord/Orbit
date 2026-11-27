// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfflineCalendarClient } from "@/lib/calendar/offline/client";
import {
  type CalendarData,
  clearCalendarOffline,
  getCalendarClient,
  openCalendarOffline,
  useCalendarData,
} from "@/lib/calendar/offline/index";
import {
  CALENDAR_ID,
  event,
  FakeCalendarServer,
  persistentStore,
} from "@/lib/calendar/offline/test-support";
import type { EventRangeQuery } from "@/lib/calendar/offline/types";

// 入口が使う本物の API は、サーバーに届かないことにする。
vi.mock("@/lib/calendar/api", async (original) => {
  const actual = await original<typeof import("@/lib/calendar/api")>();
  const { NetworkError } = await import("@/lib/api");
  const offline = async () => {
    throw new NetworkError();
  };
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === "function" ? offline : value,
    ]),
  );
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const RANGE = { from: "2026-03-01", to: "2026-04-01", timeZone: "Asia/Tokyo" };
const E1 = "00000000-0000-4000-8000-000000000e01";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useCalendarData", () => {
  it("client の中身が変わると描画し直し、描画ごとに購読し直さない", async () => {
    const server = new FakeCalendarServer();
    server.addEvent(event({ id: E1 }));
    const client = await OfflineCalendarClient.open({
      userId: "u1",
      store: persistentStore(),
      api: server.api(),
    });
    await client.pull();
    const subscribe = vi.spyOn(client, "subscribe");
    const seen: CalendarData[] = [];
    function View({ range }: { range: EventRangeQuery }) {
      const data = useCalendarData(range, client);
      seen.push(data);
      return (
        <ul>
          {data.data?.events.map((e) => (
            <li key={e.id}>{e.summary}</li>
          ))}
        </ul>
      );
    }
    await act(async () => {
      root.render(<View range={{ ...RANGE }} />);
    });
    expect(container.textContent).toBe("定例");
    expect(seen.at(-1)?.calendars?.map((c) => c.id)).toEqual([CALENDAR_ID]);
    const subscribed = subscribe.mock.calls.length;

    server.online = false;
    await act(async () => {
      client.updateEvent(E1, { summary: "変更" });
    });
    expect(container.textContent).toBe("変更");
    expect(seen.at(-1)?.queue).toHaveLength(1);
    // 同じ期間で描画し直しても、購読し直さない。
    await act(async () => {
      root.render(<View range={{ ...RANGE }} />);
    });
    expect(subscribe.mock.calls.length).toBe(subscribed);

    server.online = true;
    await act(async () => {
      client.retryNow();
      await client.flush();
    });
    expect(seen.at(-1)?.queue).toEqual([]);
    expect(container.textContent).toBe("変更");
    client.close();
  });
});

describe("openCalendarOffline / clearCalendarOffline", () => {
  it("開くと client が使え、ログアウトで閉じる", async () => {
    const store = persistentStore();
    await openCalendarOffline("u1", async () => store);
    const client = getCalendarClient();
    expect(client).not.toBeNull();
    // 同じ利用者で開き直しても、同じ client。
    await openCalendarOffline("u1", async () => persistentStore());
    expect(getCalendarClient()).toBe(client);
    await clearCalendarOffline("u1");
    expect(getCalendarClient()).toBeNull();
  });
});
