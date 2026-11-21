import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposeDraft } from "@/lib/compose";
import {
  type DraftSaveResult,
  DraftSaver,
  type DraftSaverEvent,
} from "@/lib/draft-saver";

function draft(id: string, subject: string): ComposeDraft {
  return {
    idempotencyKey: id,
    accountId: "account",
    to: { list: [], text: "" },
    cc: { list: [], text: "" },
    bcc: { list: [], text: "" },
    subject,
    html: "",
    attachments: [],
    mode: "new",
    sourceMessageId: null,
  };
}

type Call = { id: string; subject: string; base: number | null };

function setup(results: (DraftSaveResult | Promise<DraftSaveResult>)[]) {
  const calls: Call[] = [];
  const events: DraftSaverEvent[] = [];
  let next = 0;
  const saver = new DraftSaver({
    save: async (value, base) => {
      calls.push({ id: value.idempotencyKey, subject: value.subject, base });
      return (await results.shift()) ?? { status: "saved", revision: 99 };
    },
    onEvent: (event) => events.push(event),
    newId: () => `new-${++next}`,
  });
  return { saver, calls, events };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("DraftSaver", () => {
  it("入力が止まってから、最後の内容だけを保存する", async () => {
    const { saver, calls, events } = setup([{ status: "saved", revision: 1 }]);
    saver.schedule(draft("a", "こ"));
    await vi.advanceTimersByTimeAsync(500);
    saver.schedule(draft("a", "こんにちは"));
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([{ id: "a", subject: "こんにちは", base: null }]);
    expect(events).toEqual([
      { type: "saved", id: "a", revision: 1, settled: true },
    ]);
    expect(saver.revisionOf("a")).toBe(1);
    expect(saver.isBusy("a")).toBe(false);
  });

  it("保存の途中で変わった内容は、新しい revision を元にして続けて保存する", async () => {
    let finish: (result: DraftSaveResult) => void = () => {};
    const first = new Promise<DraftSaveResult>((resolve) => {
      finish = resolve;
    });
    const { saver, calls, events } = setup([
      first,
      { status: "saved", revision: 5 },
    ]);
    saver.track("a", 3);
    saver.schedule(draft("a", "1"));
    const flushed = saver.flush();
    saver.schedule(draft("a", "2"));
    finish({ status: "saved", revision: 4 });
    await flushed;
    expect(calls).toEqual([
      { id: "a", subject: "1", base: 3 },
      { id: "a", subject: "2", base: 4 },
    ]);
    expect(events).toEqual([
      { type: "saved", id: "a", revision: 4, settled: false },
      { type: "saved", id: "a", revision: 5, settled: true },
    ]);
  });

  it("他の端末が先に書き換えていたら、別の下書きとして保存する", async () => {
    const { saver, calls, events } = setup([
      { status: "conflict", revision: 7 },
      { status: "saved", revision: 1 },
    ]);
    saver.track("a", 3);
    saver.schedule(draft("a", "こちらの内容"));
    await saver.flush();
    expect(calls).toEqual([
      { id: "a", subject: "こちらの内容", base: 3 },
      { id: "new-1", subject: "こちらの内容", base: null },
    ]);
    expect(events).toEqual([
      { type: "moved", from: "a", to: "new-1", reason: "conflict" },
      { type: "saved", id: "new-1", revision: 1, settled: true },
    ]);
    expect(saver.revisionOf("a")).toBeNull();

    // 画面が新しい ID に切り替わる前の入力も、新しい下書きへ保存する。
    saver.schedule(draft("a", "こちらの内容の続き"));
    await saver.flush();
    expect(calls.at(-1)).toEqual({
      id: "new-1",
      subject: "こちらの内容の続き",
      base: 1,
    });
  });

  it("他の端末で送信・破棄されていたら、新しい下書きとして保存する", async () => {
    const { saver, calls, events } = setup([
      { status: "gone" },
      { status: "saved", revision: 1 },
    ]);
    saver.track("a", 2);
    saver.schedule(draft("a", "続き"));
    await saver.flush();
    expect(calls.map((call) => call.id)).toEqual(["a", "new-1"]);
    expect(events[0]).toEqual({
      type: "moved",
      from: "a",
      to: "new-1",
      reason: "gone",
    });
  });

  it("応答が届かなかった作成は、すでにある下書きをそのまま上書きする", async () => {
    const { saver, calls } = setup([
      { status: "conflict", revision: 1 },
      { status: "saved", revision: 2 },
    ]);
    saver.schedule(draft("a", "内容"));
    await saver.flush();
    expect(calls).toEqual([
      { id: "a", subject: "内容", base: null },
      { id: "a", subject: "内容", base: 1 },
    ]);
    expect(saver.revisionOf("a")).toBe(2);
  });

  it("サーバーに届かなければ内容を持ったまま、間隔を広げてやり直す", async () => {
    const { saver, calls, events } = setup([
      { status: "retry" },
      { status: "retry" },
      { status: "saved", revision: 1 },
    ]);
    saver.schedule(draft("a", "内容"));
    await saver.flush();
    expect(events).toEqual([{ type: "error", id: "a", retrying: true }]);
    expect(saver.isBusy("a")).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);
    expect(saver.isBusy("a")).toBe(false);
    expect(events.at(-1)).toEqual({
      type: "saved",
      id: "a",
      revision: 1,
      settled: true,
    });
  });

  it("受け付けられない内容は、やり直さずに知らせる", async () => {
    const { saver, calls, events } = setup([{ status: "rejected" }]);
    saver.schedule(draft("a", "内容"));
    await saver.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
    expect(events).toEqual([{ type: "error", id: "a", retrying: false }]);
  });

  it("取り消すと、保存の途中の結果も無視して作り直さない", async () => {
    let finish: (result: DraftSaveResult) => void = () => {};
    const first = new Promise<DraftSaveResult>((resolve) => {
      finish = resolve;
    });
    const { saver, calls, events } = setup([first]);
    saver.track("a", 1);
    saver.schedule(draft("a", "1"));
    void saver.flush();
    saver.schedule(draft("a", "2"));
    const forgotten = saver.forget("a");
    finish({ status: "gone" });
    await forgotten;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
    expect(events).toEqual([]);
    expect(saver.isBusy("a")).toBe(false);
    expect(saver.revisionOf("a")).toBeNull();
  });

  it("複数の下書きを順に保存する", async () => {
    const { saver, calls } = setup([
      { status: "saved", revision: 1 },
      { status: "saved", revision: 1 },
    ]);
    saver.schedule(draft("a", "A"));
    saver.schedule(draft("b", "B"));
    await saver.flush();
    expect(calls.map((call) => call.id)).toEqual(["a", "b"]);
  });
});
