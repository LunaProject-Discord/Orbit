import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUuid } from "./uuid";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomUuid", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("crypto.randomUUID が使えるときは、それを使う", () => {
    expect(randomUuid()).toMatch(UUID_V4);
  });

  it("crypto.randomUUID が無い環境 (http で開いたとき) でも UUID を作る", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: (array: Uint8Array) => real.getRandomValues(array),
    });
    const first = randomUuid();
    expect(first).toMatch(UUID_V4);
    expect(randomUuid()).not.toBe(first);
  });
});
