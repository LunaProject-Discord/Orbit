import { describe, expect, it } from "vitest";
import {
  clientClockOffset,
  correctClientTime,
  correctClientTimes,
} from "./client-time.js";

const receivedAt = new Date("2026-12-01T12:00:00.000Z");

describe("clientClockOffset", () => {
  it("clientNow が無い・読めなければ 0", () => {
    expect(clientClockOffset(undefined, receivedAt)).toBe(0);
    expect(clientClockOffset(null, receivedAt)).toBe(0);
    expect(clientClockOffset("not a date", receivedAt)).toBe(0);
  });
  it("10 秒以内のずれは直さない", () => {
    expect(clientClockOffset("2026-12-01T11:59:50.000Z", receivedAt)).toBe(0);
    expect(clientClockOffset("2026-12-01T12:00:10.000Z", receivedAt)).toBe(0);
  });
  it("10 秒を超えるずれは、届いた時刻 − clientNow", () => {
    // 時計が 1 時間遅い端末。
    expect(clientClockOffset("2026-12-01T11:00:00.000Z", receivedAt)).toBe(
      3_600_000,
    );
    // 時計が 1 時間進んでいる端末。
    expect(clientClockOffset("2026-12-01T13:00:00.000Z", receivedAt)).toBe(
      -3_600_000,
    );
  });
});

describe("correctClientTime", () => {
  it("時計が遅れている端末の時刻を進める", () => {
    // 端末の時計で 10:05 に操作し、端末の時計で 11:00 に送った (実際は 12:00)。
    expect(
      correctClientTime(
        "2026-12-01T10:05:00Z",
        "2026-12-01T11:00:00Z",
        receivedAt,
      ).toISOString(),
    ).toBe("2026-12-01T11:05:00.000Z");
  });
  it("時計が進んでいる端末の時刻を戻す", () => {
    expect(
      correctClientTime(
        "2026-12-01T12:30:00Z",
        "2026-12-01T13:00:00Z",
        receivedAt,
      ).toISOString(),
    ).toBe("2026-12-01T11:30:00.000Z");
  });
  it("ずれが 10 秒以内ならそのまま", () => {
    expect(
      correctClientTime(
        "2026-12-01T11:00:00Z",
        "2026-12-01T12:00:05Z",
        receivedAt,
      ).toISOString(),
    ).toBe("2026-12-01T11:00:00.000Z");
  });
  it("clientNow が無ければ直さず、未来の時刻だけ丸める", () => {
    expect(
      correctClientTime("2026-12-01T11:00:00Z", undefined, receivedAt),
    ).toEqual(new Date("2026-12-01T11:00:00Z"));
    expect(
      correctClientTime("2027-01-01T00:00:00Z", undefined, receivedAt),
    ).toEqual(receivedAt);
  });
  it("補正したあとに未来になる時刻は、届いた時刻に丸める", () => {
    // clientNow より後の時刻 (端末の操作の時刻が送る時刻より後になっている)。
    expect(
      correctClientTime(
        "2026-12-01T11:30:00Z",
        "2026-12-01T11:00:00Z",
        receivedAt,
      ),
    ).toEqual(receivedAt);
  });
  it("時刻が無ければ届いた時刻", () => {
    expect(correctClientTime(undefined, "x", receivedAt)).toEqual(receivedAt);
  });
});

describe("correctClientTimes", () => {
  it("項目ごとに直し、読めない値は落とす", () => {
    expect(
      correctClientTimes(
        { summary: "2026-12-01T10:05:00Z", location: "bad" },
        "2026-12-01T11:00:00Z",
        receivedAt,
      ),
    ).toEqual({ summary: "2026-12-01T11:05:00.000Z" });
  });
});
