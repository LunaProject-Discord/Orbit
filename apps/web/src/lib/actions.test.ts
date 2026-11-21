import { describe, expect, it } from "vitest";
import { applyActions } from "@/lib/actions";
import type { MessageSummary } from "@/lib/api";

function message(id: string, overrides: Partial<MessageSummary> = {}) {
  return {
    id,
    accountId: "account",
    mailboxId: "inbox",
    threadKey: id,
    subject: id,
    from: [],
    to: [],
    receivedAt: "2026-11-21T00:00:00.000Z",
    snippet: "",
    hasAttachments: false,
    seen: false,
    flagged: false,
    answered: false,
    ...overrides,
  } satisfies MessageSummary;
}

describe("applyActions", () => {
  it("既読とスターを、対象のメッセージにだけ重ねる", () => {
    const result = applyActions(
      [message("a"), message("b")],
      [
        {
          idempotencyKey: "1",
          messageIds: ["a"],
          action: "set_flags",
          seen: true,
        },
        {
          idempotencyKey: "2",
          messageIds: ["a"],
          action: "set_flags",
          flagged: true,
        },
      ],
    );
    expect(result.map((item) => [item.id, item.seen, item.flagged])).toEqual([
      ["a", true, true],
      ["b", false, false],
    ]);
  });

  it("後の操作が前の操作を上書きする", () => {
    const base = { messageIds: ["a"], action: "set_flags" as const };
    const [result] = applyActions(
      [message("a")],
      [
        { ...base, idempotencyKey: "1", seen: true },
        { ...base, idempotencyKey: "2", seen: false },
      ],
    );
    expect(result?.seen).toBe(false);
  });

  it("移動と削除では一覧から外す", () => {
    const result = applyActions(
      [message("a"), message("b"), message("c")],
      [
        {
          idempotencyKey: "1",
          messageIds: ["a"],
          action: "move",
          destination: "trash",
        },
        { idempotencyKey: "2", messageIds: ["b"], action: "delete" },
      ],
    );
    expect(result.map((item) => item.id)).toEqual(["c"]);
  });

  it("いまあるフォルダへの移動では外さない", () => {
    const result = applyActions(
      [message("a")],
      [
        {
          idempotencyKey: "1",
          messageIds: ["a"],
          action: "move",
          mailboxId: "inbox",
        },
      ],
    );
    expect(result).toHaveLength(1);
  });
});
