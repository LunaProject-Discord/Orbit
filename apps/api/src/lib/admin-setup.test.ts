import { describe, expect, it } from "vitest";
import {
  normalizeSetupCode,
  SETUP_CODE_TTL_MS,
  SetupCode,
} from "./admin-setup.js";

/** log に渡された合言葉を控える SetupCode (時刻は差し替えられる)。 */
function make() {
  const logged: string[] = [];
  const clock = { now: 1_000_000 };
  const code = new SetupCode(
    (value) => logged.push(value),
    () => clock.now,
  );
  return { code, logged, clock };
}

describe("SetupCode", () => {
  it("合言葉は XXXXX-XXXXX-XXXXX-XXXXX の形で、紛らわしい文字を含まない", () => {
    for (let i = 0; i < 200; i++) {
      const { code, logged } = make();
      code.ensure();
      expect(logged[0]).toMatch(/^[A-HJKMNP-Z2-9]{5}(-[A-HJKMNP-Z2-9]{5}){3}$/);
      expect(logged[0]).not.toMatch(/[01OIL]/);
    }
  });

  it("ensure は何度呼んでも log を 1 回だけ呼ぶ", () => {
    const { code, logged } = make();
    expect(code.active).toBe(false);
    code.ensure();
    code.ensure();
    expect(logged).toHaveLength(1);
    expect(code.active).toBe(true);
  });

  it("check は大文字小文字・ハイフン・空白の揺れを許す", () => {
    const { code, logged } = make();
    code.ensure();
    const value = logged[0] as string;
    expect(code.check(value)).toBe(true);
    expect(code.check(value.toLowerCase())).toBe(true);
    expect(code.check(value.replaceAll("-", ""))).toBe(true);
    expect(code.check(`  ${value.replaceAll("-", " ")}  `)).toBe(true);
  });

  it("間違いや空文字は false", () => {
    const { code, logged } = make();
    code.ensure();
    const value = logged[0] as string;
    expect(code.check("AAAAA-AAAAA-AAAAA-AAAAA")).toBe(false);
    expect(code.check(value.slice(0, -1))).toBe(false);
    expect(code.check("")).toBe(false);
    expect(code.check(" - ")).toBe(false);
  });

  it("合言葉が無いうちは何を入れても false", () => {
    const { code } = make();
    expect(code.check("")).toBe(false);
    expect(code.check("AAAAA-AAAAA-AAAAA-AAAAA")).toBe(false);
  });

  it("clear の後は、さっきの合言葉でも false", () => {
    const { code, logged } = make();
    code.ensure();
    code.clear();
    expect(code.active).toBe(false);
    expect(code.check(logged[0] as string)).toBe(false);
  });

  it("clear の後の ensure は新しい合言葉を出す", () => {
    const { code, logged } = make();
    code.ensure();
    code.clear();
    code.ensure();
    expect(logged).toHaveLength(2);
    expect(logged[1]).not.toBe(logged[0]);
  });

  it("合言葉は 30 分で切れ、次の ensure で作り直す", () => {
    const { code, logged, clock } = make();
    code.ensure();
    const first = logged[0] as string;
    clock.now += SETUP_CODE_TTL_MS - 1;
    expect(code.check(first)).toBe(true);
    clock.now += 1;
    expect(code.check(first)).toBe(false);
    expect(code.active).toBe(false);
    code.ensure();
    expect(logged).toHaveLength(2);
    expect(logged[1]).not.toBe(first);
    expect(code.check(logged[1] as string)).toBe(true);
  });

  it("1 分に 10 回間違えると limited になり、1 分後に戻る", () => {
    const { code, clock } = make();
    code.ensure();
    for (let i = 0; i < 9; i++) {
      code.check("wrong");
      clock.now += 1000;
    }
    expect(code.limited()).toBe(false);
    code.check("wrong");
    expect(code.limited()).toBe(true);
    // 最初の間違いから 1 分たつまでは続く。
    clock.now += 50_000;
    expect(code.limited()).toBe(true);
    // 最初の間違いから 1 分たったなので、数えなくなる。
    clock.now += 10_000;
    expect(code.limited()).toBe(false);
  });

  it("正しい合言葉は失敗に数えない", () => {
    const { code, logged } = make();
    code.ensure();
    for (let i = 0; i < 20; i++) code.check(logged[0] as string);
    expect(code.limited()).toBe(false);
  });

  it("exclusive は直列に動き、失敗しても次が動く", async () => {
    const { code } = make();
    const events: string[] = [];
    const slow = code.exclusive(async () => {
      events.push("a:start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      events.push("a:end");
      return 1;
    });
    const failing = code.exclusive(async () => {
      events.push("b:start");
      throw new Error("失敗");
    });
    const last = code.exclusive(async () => {
      events.push("c:start");
      return 3;
    });
    await expect(slow).resolves.toBe(1);
    await expect(failing).rejects.toThrow("失敗");
    await expect(last).resolves.toBe(3);
    expect(events).toEqual(["a:start", "a:end", "b:start", "c:start"]);
  });
});

describe("normalizeSetupCode", () => {
  it("英数字以外を除いて大文字にする", () => {
    expect(normalizeSetupCode(" ab-cd 12 ")).toBe("ABCD12");
  });
});
