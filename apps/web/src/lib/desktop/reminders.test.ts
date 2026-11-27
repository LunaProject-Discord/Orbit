// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const listeners = new Map<string, (event: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (
    event: string,
    handler: (event: { payload: unknown }) => void,
  ) => {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  },
}));

import {
  createDesktopReminderBridge,
  listenDesktopCalendarAction,
  listenDesktopOpenEvent,
  TAKE_PENDING_OPEN_EVENT_COMMAND,
} from "./reminders";

type TauriWindow = { __TAURI_INTERNALS__?: unknown };
const ID = "019aa0c2-7b3e-7c11-9d2f-0123456789ab";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  (window as unknown as TauriWindow).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as TauriWindow).__TAURI_INTERNALS__;
  invoke.mockReset();
  listeners.clear();
});

describe("createDesktopReminderBridge", () => {
  it("アプリの能力をそのまま返す", async () => {
    invoke.mockResolvedValue({ schedule: "os", exact: true });
    await expect(createDesktopReminderBridge().capabilities()).resolves.toEqual(
      { schedule: "os", exact: true },
    );
    expect(invoke).toHaveBeenCalledWith("reminder_capabilities", undefined);
  });

  it("古いアプリ (コマンドが無い) とブラウザーでは予約しない", async () => {
    invoke.mockRejectedValue(new Error("command not found"));
    await expect(createDesktopReminderBridge().capabilities()).resolves.toEqual(
      { schedule: "none", exact: false },
    );
    delete (window as unknown as TauriWindow).__TAURI_INTERNALS__;
    await expect(createDesktopReminderBridge().capabilities()).resolves.toEqual(
      { schedule: "none", exact: false },
    );
  });

  it("一覧を整えて渡す", async () => {
    invoke.mockResolvedValue(null);
    const bridge = createDesktopReminderBridge();
    await bridge.replaceAll([
      {
        tag: `cal-rem:${ID}:-:10`,
        fireAt: 1_764_290_400_000.4,
        expiresAt: 1_764_295_200_000,
        title: "定例会議",
        body: "10:00〜11:00",
        eventId: ID,
        recurrenceId: null,
        extra: "x",
      } as never,
    ]);
    expect(invoke).toHaveBeenCalledWith("schedule_reminders", {
      items: [
        {
          tag: `cal-rem:${ID}:-:10`,
          fireAt: 1_764_290_400_000,
          expiresAt: 1_764_295_200_000,
          title: "定例会議",
          body: "10:00〜11:00",
          eventId: ID,
          recurrenceId: null,
        },
      ],
    });
    await bridge.clear();
    expect(invoke).toHaveBeenLastCalledWith("clear_reminders", undefined);
  });
});

describe("listenDesktopOpenEvent", () => {
  it("聞き始めたときと合図のたびに受け取りに行く", async () => {
    invoke.mockResolvedValueOnce({ eventId: ID, recurrenceId: "2026-11-28" });
    const opened: unknown[] = [];
    const stop = listenDesktopOpenEvent((target) => opened.push(target));
    await flush();
    expect(invoke).toHaveBeenCalledWith(
      TAKE_PENDING_OPEN_EVENT_COMMAND,
      undefined,
    );
    expect(opened).toEqual([{ eventId: ID, recurrenceId: "2026-11-28" }]);

    // 合図が来たら受け取りに行く。もう受け取ったもの (null) は開かない。
    invoke.mockResolvedValueOnce(null);
    listeners.get("desktop://open-event")?.({ payload: {} });
    await flush();
    expect(opened).toHaveLength(1);

    invoke.mockResolvedValueOnce({ eventId: null, recurrenceId: null });
    listeners.get("desktop://open-event")?.({ payload: {} });
    await flush();
    expect(opened[1]).toEqual({ eventId: null, recurrenceId: null });
    stop();
  });
});

describe("listenDesktopCalendarAction", () => {
  it("知っている出欠だけを渡す", async () => {
    const actions: unknown[] = [];
    listenDesktopCalendarAction((action) => actions.push(action));
    await flush();
    const send = listeners.get("desktop://calendar-action");
    send?.({ payload: { eventId: ID, status: "accepted" } });
    send?.({ payload: { eventId: ID, status: "maybe" } });
    send?.({ payload: null });
    expect(actions).toEqual([{ eventId: ID, status: "accepted" }]);
  });
});
