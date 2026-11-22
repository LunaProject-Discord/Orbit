import { describe, expect, it } from "vitest";
import { formatDateValue, parseDateValue } from "./date-picker";

describe("parseDateValue", () => {
  it("YYYY-MM-DD を端末の時刻帯のその日にする", () => {
    const date = parseDateValue("2026-11-05");
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(10);
    expect(date?.getDate()).toBe(5);
    expect(date?.getHours()).toBe(0);
  });

  it("形が違うものと、暦に無い日は受け付けない", () => {
    expect(parseDateValue("")).toBeUndefined();
    expect(parseDateValue("11/21")).toBeUndefined();
    expect(parseDateValue("2026-02-30")).toBeUndefined();
    expect(parseDateValue("2026-13-01")).toBeUndefined();
  });
});

describe("formatDateValue", () => {
  it("桁をそろえて YYYY-MM-DD にし、読み取ると元に戻る", () => {
    expect(formatDateValue(new Date(2026, 0, 9))).toBe("2026-01-09");
    expect(formatDateValue(parseDateValue("2026-11-22") as Date)).toBe(
      "2026-11-22",
    );
  });
});
