// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  clearWheelLog,
  logWheel,
  setWheelLogEnabled,
  wheelLogEnabled,
  wheelLogText,
} from "@/lib/wheel-log";

const entry = {
  at: 1234.56,
  deltaX: 12,
  deltaY: 0.5,
  deltaMode: 0,
  inFrame: false,
  result: "move",
};

afterEach(() => {
  setWheelLogEnabled(false);
  clearWheelLog();
});

describe("wheel-log", () => {
  it("オフの間は記録しない", () => {
    logWheel(entry);
    expect(wheelLogText().split("\n")).toHaveLength(2);
  });

  it("オンにすると記録し、タブ区切りで取り出せる。オン・オフは保存する", () => {
    setWheelLogEnabled(true);
    expect(wheelLogEnabled()).toBe(true);
    expect(localStorage.getItem("orbit.debug.wheelLog")).toBe("1");
    logWheel(entry);
    logWheel({ ...entry, inFrame: true, result: "momentum" });
    const lines = wheelLogText().split("\n");
    expect(lines[1]).toBe("at\tdeltaX\tdeltaY\tdeltaMode\tsurface\tresult");
    expect(lines[2]).toBe("1234.6\t12.00\t0.50\t0\ttop\tmove");
    expect(lines[3]).toBe("1234.6\t12.00\t0.50\t0\tframe\tmomentum");
  });

  it("最新の 3000 件だけ残す", () => {
    setWheelLogEnabled(true);
    for (let index = 0; index < 3100; index++) {
      logWheel({ ...entry, at: index });
    }
    const lines = wheelLogText().split("\n").slice(2);
    expect(lines).toHaveLength(3000);
    expect(lines[0]?.startsWith("100.0\t")).toBe(true);
  });
});
