// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { absorbAuthState, authStateHeader, clearAuthState } from "./auth-state";

describe("auth-state", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-22T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("預かった値を、次の呼び出しのヘッダーにして返す", () => {
    expect(authStateHeader()).toBe(null);
    absorbAuthState(
      JSON.stringify({
        "better-auth.two_factor": { value: "abc.sig%3D", maxAge: 600 },
      }),
    );
    expect(authStateHeader()).toBe("better-auth.two_factor=abc.sig%3D");
  });

  it("期限が過ぎた値は返さない", () => {
    absorbAuthState(
      JSON.stringify({
        "better-auth.two_factor": { value: "abc", maxAge: 600 },
        "better-auth.trust_device": { value: "trust", maxAge: 2_592_000 },
      }),
    );
    vi.advanceTimersByTime(601_000);
    expect(authStateHeader()).toBe("better-auth.trust_device=trust");
  });

  it("消す指示 (期限が 0 以下) が来たら消し、ほかの値は残す", () => {
    absorbAuthState(
      JSON.stringify({
        "better-auth.two_factor": { value: "abc", maxAge: 600 },
        "better-auth.trust_device": { value: "trust", maxAge: null },
      }),
    );
    absorbAuthState(
      JSON.stringify({ "better-auth.two_factor": { value: "", maxAge: 0 } }),
    );
    expect(authStateHeader()).toBe("better-auth.trust_device=trust");
  });

  it("読めない値は無視する", () => {
    absorbAuthState("not json");
    absorbAuthState(JSON.stringify({ a: 1, b: { value: 2 } }));
    expect(authStateHeader()).toBe(null);
    window.localStorage.setItem("mail.auth-state.v1", "broken");
    expect(authStateHeader()).toBe(null);
  });

  it("clearAuthState ですべて消す", () => {
    absorbAuthState(JSON.stringify({ a: { value: "1", maxAge: 60 } }));
    clearAuthState();
    expect(authStateHeader()).toBe(null);
  });
});
