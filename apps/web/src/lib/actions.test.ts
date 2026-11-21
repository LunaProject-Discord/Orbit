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
    threadCount: 1,
    threadMessageIds: [id],
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

  it("会話の一部だけへの操作は、結果が決まる向きだけを重ねる", () => {
    const thread = message("b", {
      seen: true,
      flagged: true,
      threadCount: 3,
      threadMessageIds: ["a", "b"],
    });
    const flags = (input: { seen?: boolean; flagged?: boolean }) =>
      applyActions(
        [thread],
        [
          {
            idempotencyKey: "1",
            messageIds: ["a"],
            action: "set_flags",
            ...input,
          },
        ],
      )[0];
    // 1 通を未読にすれば会話は未読になるが、1 通のスターを外しても会話のスターは残る。
    expect(flags({ seen: false })?.seen).toBe(false);
    expect(flags({ flagged: false })?.flagged).toBe(true);
    const unread = applyActions(
      [{ ...thread, seen: false }],
      [
        {
          idempotencyKey: "1",
          messageIds: ["a"],
          action: "set_flags",
          seen: true,
        },
        {
          idempotencyKey: "2",
          messageIds: ["a", "b"],
          action: "set_flags",
          flagged: false,
        },
      ],
    )[0];
    expect(unread?.seen).toBe(false);
    expect(unread?.flagged).toBe(false);
  });

  it("会話の一部を移動しても、残りがあれば行は残す", () => {
    const thread = message("b", {
      threadCount: 3,
      threadMessageIds: ["a", "b"],
    });
    const move = (messageIds: string[]) =>
      applyActions(
        [thread],
        [
          {
            idempotencyKey: "1",
            messageIds,
            action: "move",
            destination: "archive",
          },
        ],
      );
    expect(move(["a"])).toEqual([
      { ...thread, threadCount: 2, threadMessageIds: ["b"] },
    ]);
    expect(move(["a", "b"])).toEqual([]);
  });
});
