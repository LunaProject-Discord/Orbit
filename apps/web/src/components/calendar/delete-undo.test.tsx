// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeleteWithUndo,
  useDeleteUndo,
} from "@/components/calendar/delete-undo";
import { Toaster } from "@/components/ui/sonner";
import type { CalendarClient } from "@/lib/calendar/offline";
import { UNDO_MS } from "@/lib/undo";

function fakeClient(undone = true) {
  const pendings: {
    undo: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  }[] = [];
  const write = vi.fn();
  const client = {
    holdForUndo: vi.fn((fn: () => void) => {
      fn();
      const pending = {
        undo: vi.fn(async () => undone),
        release: vi.fn(),
      };
      pendings.push(pending);
      return pending;
    }),
  } as unknown as CalendarClient;
  return { client, pendings, write };
}

describe("予定の削除の「元に戻す」", () => {
  let container: HTMLDivElement;
  let root: Root;
  let deleteWithUndo: DeleteWithUndo = () => {};

  function Harness() {
    deleteWithUndo = useDeleteUndo();
    return <Toaster />;
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const undoButton = () =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("元に戻す"),
    );
  const text = () => document.body.textContent ?? "";

  async function remove(client: CalendarClient, write = () => {}) {
    await act(async () => {
      deleteWithUndo(
        client,
        "予定を削除しました",
        "すでにサーバーへ反映済みのため、元に戻せませんでした。",
        write,
      );
      await vi.advanceTimersByTimeAsync(50);
    });
  }

  it("Mail と同じトーストを出し、「元に戻す」で送信待ちから取り消す", async () => {
    const { client, pendings, write } = fakeClient();
    await remove(client, write);
    expect(write).toHaveBeenCalledTimes(1);
    expect(client.holdForUndo).toHaveBeenCalledWith(write, UNDO_MS);
    expect(text()).toContain("予定を削除しました");
    const button = undoButton();
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(pendings[0]?.undo).toHaveBeenCalledTimes(1);
    expect(pendings[0]?.release).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_MS);
    });
    expect(pendings[0]?.release).not.toHaveBeenCalled();
    expect(text()).not.toContain("元に戻せませんでした");
  });

  it("トーストの時間が過ぎたら確定して送る", async () => {
    const { client, pendings } = fakeClient();
    await remove(client);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_MS - 100);
    });
    expect(pendings[0]?.release).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(pendings[0]?.release).toHaveBeenCalledTimes(1);
  });

  it("もう送っていたら、元に戻せなかったことを知らせる", async () => {
    const { client } = fakeClient(false);
    await remove(client);
    await act(async () => {
      undoButton()?.click();
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(text()).toContain(
      "すでにサーバーへ反映済みのため、元に戻せませんでした。",
    );
  });

  it("Z キーで元に戻す。入力欄では効かない", async () => {
    const { client, pendings } = fakeClient();
    await remove(client);
    const input = document.createElement("input");
    document.body.append(input);
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "z", bubbles: true }),
      );
    });
    expect(pendings[0]?.undo).not.toHaveBeenCalled();
    input.remove();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z" }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(pendings[0]?.undo).toHaveBeenCalledTimes(1);
  });

  it("続けて削除したら前の削除を確定し、画面を離れたら待っている削除を送る", async () => {
    const { client, pendings } = fakeClient();
    await remove(client);
    await remove(client);
    expect(pendings[0]?.release).toHaveBeenCalledTimes(1);
    expect(pendings[1]?.release).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    expect(pendings[1]?.release).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });
});
