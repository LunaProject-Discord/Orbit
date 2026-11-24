import { describe, expect, it, vi } from "vitest";
import { Inflight, MemoCache } from "@/lib/offline/memo";

describe("MemoCache", () => {
  it("上限を超えたら、長く使っていないものから捨てる", () => {
    const cache = new MemoCache<number>(2);
    cache.set("a", 1, true);
    cache.set("b", 2, true);
    cache.get("a"); // a を使ったので、次に捨てるのは b
    cache.set("c", 3, true);
    expect(cache.get("a")?.value).toBe(1);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")?.value).toBe(3);
  });

  it("サーバーから取得した内容を、端末の保存先の内容で上書きしない", () => {
    const cache = new MemoCache<string>(10);
    cache.set("a", "server", true, 100);
    cache.set("a", "local", false, 200);
    expect(cache.get("a")).toEqual({ value: "server", at: 100, network: true });
    cache.set("a", "server2", true, 300);
    expect(cache.get("a")?.value).toBe("server2");
  });

  it("update で書き換えたり、null を返したものを捨てたりできる", () => {
    const cache = new MemoCache<number>(10);
    cache.set("a", 1, true, 100);
    cache.set("b", 2, false, 100);
    cache.update((value, key) => (key === "a" ? value + 10 : null));
    expect(cache.get("a")).toEqual({ value: 11, at: 100, network: true });
    expect(cache.get("b")).toBeUndefined();
    expect(cache.size).toBe(1);
  });
});

describe("Inflight", () => {
  it("同じキーの取得が進行中なら、新しく始めずに同じ結果を返す", async () => {
    const inflight = new Inflight();
    let resolve: (value: string) => void = () => {};
    const start = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const first = inflight.run("k", start);
    const second = inflight.run("k", start);
    expect(start).toHaveBeenCalledTimes(1);
    resolve("ok");
    await expect(first).resolves.toBe("ok");
    await expect(second).resolves.toBe("ok");
    // 終わったら、次は新しく始める。
    void inflight.run("k", start);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("取り消した呼び出し元にだけ AbortError を返し、取得そのものは続ける", async () => {
    const inflight = new Inflight();
    let resolve: (value: string) => void = () => {};
    const start = () =>
      new Promise<string>((done) => {
        resolve = done;
      });
    const controller = new AbortController();
    const aborted = inflight.run("k", start, controller.signal);
    const other = inflight.run("k", start);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    resolve("ok");
    await expect(other).resolves.toBe("ok");
  });

  it("失敗も、待っているすべての呼び出し元に伝える", async () => {
    const inflight = new Inflight();
    const start = () => Promise.reject(new Error("failed"));
    const first = inflight.run("k", start);
    const second = inflight.run("k", start, new AbortController().signal);
    await expect(first).rejects.toThrow("failed");
    await expect(second).rejects.toThrow("failed");
  });
});
