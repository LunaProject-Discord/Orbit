import { afterEach, describe, expect, it } from "vitest";
import {
  backLog,
  backLogText,
  clearBackLog,
  enableBackLog,
  resetBackLogForTest,
} from "./back-log";

afterEach(() => resetBackLogForTest());

describe("backLog", () => {
  it("記録を始めるまでは残さない", () => {
    backLog("a");
    expect(backLogText()).toBe("");
  });

  it("時刻を付けて残し、古いものから消す", () => {
    enableBackLog();
    for (let index = 0; index < 305; index++) backLog(`line ${index}`);
    const lines = backLogText().split("\n");
    expect(lines).toHaveLength(300);
    expect(lines[0]).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} line 5$/);
    clearBackLog();
    expect(backLogText()).toBe("");
  });
});
