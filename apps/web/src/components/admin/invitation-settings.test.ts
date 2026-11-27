import { describe, expect, it } from "vitest";
import { invitationState } from "./invitation-settings";

describe("招待の状態", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();

  it("期限内で使われていなければ、未使用", () => {
    expect(invitationState({ usedAt: null, expiresAt: at(1) }, now)).toBe(
      "pending",
    );
  });

  it("期限を過ぎたら、期限切れ (ちょうどの時刻も含む)", () => {
    expect(invitationState({ usedAt: null, expiresAt: at(0) }, now)).toBe(
      "expired",
    );
    expect(invitationState({ usedAt: null, expiresAt: at(-1) }, now)).toBe(
      "expired",
    );
  });

  it("使われた招待は、期限を過ぎても使用済み", () => {
    expect(invitationState({ usedAt: at(-1000), expiresAt: at(-1) }, now)).toBe(
      "used",
    );
  });
});
