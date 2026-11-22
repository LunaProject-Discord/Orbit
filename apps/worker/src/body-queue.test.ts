import { describe, expect, it } from "vitest";
import { BodyQueue } from "./body-queue.js";

/** 実行を手で進められる待ち行列。started は取得を始めた順。 */
function setup(concurrency = 1) {
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  const queue = new BodyQueue(
    (id) =>
      new Promise<void>((resolve) => {
        started.push(id);
        finish.set(id, resolve);
      }),
    concurrency,
  );
  const done = async (id: string) => {
    finish.get(id)?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { queue, started, done };
}

describe("BodyQueue", () => {
  it("開いたメール、カーソルを載せたメール、見えている行の順に取得する", async () => {
    const { queue, started, done } = setup();
    queue.request(["busy"], "visible");
    queue.request(["v1", "v2"], "visible");
    queue.request(["h1"], "hover");
    queue.request(["o1"], "open");
    for (const id of ["busy", "o1", "h1", "v1", "v2"]) await done(id);
    expect(started).toEqual(["busy", "o1", "h1", "v1", "v2"]);
    await queue.idle();
  });

  it("見えている行は、新しい依頼が来たら前の待ち分を捨てる", async () => {
    const { queue, started, done } = setup();
    queue.request(["a", "b", "c"], "visible");
    queue.request(["c", "d"], "visible");
    for (const id of ["a", "c", "d"]) await done(id);
    expect(started).toEqual(["a", "c", "d"]);
  });

  it("カーソルを次々に載せても、待たせるのは最後の 2 通だけ", async () => {
    const { queue, started, done } = setup();
    queue.request(["busy"], "open");
    for (const id of ["h1", "h2", "h3", "h4"]) queue.request([id], "hover");
    for (const id of ["busy", "h4", "h3"]) await done(id);
    expect(started).toEqual(["busy", "h4", "h3"]);
    await queue.idle();
  });

  it("実行中や待っているメールへの依頼は重ねず、優先度は上げる", async () => {
    const { queue, started, done } = setup();
    queue.request(["a", "b", "c"], "visible");
    queue.request(["a"], "open");
    queue.request(["c"], "hover");
    queue.request(["c"], "visible");
    for (const id of ["a", "c", "b"]) await done(id);
    expect(started).toEqual(["a", "c"]);
  });

  it("同時に実行する数を守り、失敗しても次へ進む", async () => {
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    const queue = new BodyQueue(async (id) => {
      started.push(id);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      if (id === "b") throw new Error("失敗");
    }, 2);
    queue.request(["a", "b", "c", "d", "e"], "visible");
    await queue.idle();
    expect(started).toEqual(["a", "b", "c", "d", "e"]);
    expect(peak).toBe(2);
  });
});
