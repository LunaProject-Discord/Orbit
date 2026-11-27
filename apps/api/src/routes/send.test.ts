import { describe, expect, it } from "vitest";
import { scheduleOf } from "./send.js";

describe("scheduleOf (予約送信の日時)", () => {
  const now = Date.parse("2026-11-27T00:00:00Z");

  it("先の日時はそのまま予約にする", () => {
    expect(scheduleOf("2026-11-28T09:00:00+09:00", now)).toEqual(
      new Date("2026-11-28T00:00:00Z"),
    );
  });

  it("指定が無いか、過ぎていればすぐ送る", () => {
    expect(scheduleOf(undefined, now)).toBeNull();
    expect(scheduleOf(null, now)).toBeNull();
    expect(scheduleOf("2026-11-26T23:59:00Z", now)).toBeNull();
  });

  it("1 年より先は受け付けない", () => {
    expect(scheduleOf("2028-01-01T00:00:00Z", now)).toBe("too_far");
  });
});
