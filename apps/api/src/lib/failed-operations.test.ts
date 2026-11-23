import type { OutboxTarget } from "@orbit/core";
import { describe, expect, it } from "vitest";
import { matchTargets } from "./failed-operations.js";

function target(overrides: Partial<OutboxTarget> = {}): OutboxTarget {
  return {
    messageId: "m1",
    providerMessageId: null,
    mailboxId: "box1",
    mailboxPath: "INBOX",
    uid: "7",
    uidValidity: "100",
    ...overrides,
  };
}

describe("matchTargets", () => {
  it("UIDVALIDITY が同じなら、今の messages.id に直して返す", () => {
    const result = matchTargets(
      [target(), target({ messageId: "m2", uid: "8" })],
      new Map([["box1", "100"]]),
      new Map([["box1:7", "m1-new"]]),
      new Map(),
    );
    expect(result.present).toEqual([target({ messageId: "m1-new" })]);
    expect(result.absent).toEqual([target({ messageId: "m2", uid: "8" })]);
  });

  it("UIDVALIDITY が変わっていたら対象から外す", () => {
    const result = matchTargets(
      [target()],
      new Map([["box1", "101"]]),
      new Map([["box1:7", "m1"]]),
      new Map(),
    );
    expect(result).toEqual({ present: [], absent: [] });
  });

  it("最初の取り込み中に受け付けた操作 (UIDVALIDITY 無し) には、今の値を補う", () => {
    // Gmail を追加した直後にメールを開くと、UIDVALIDITY の無いまま既読の操作が
    // 受け付けられて失敗していた。再試行では今の値を補って実行できるようにする。
    const result = matchTargets(
      [target({ uidValidity: null })],
      new Map([["box1", "100"]]),
      new Map([["box1:7", "m1"]]),
      new Map(),
    );
    expect(result.present).toEqual([target({ uidValidity: "100" })]);
    expect(result.absent).toEqual([]);
  });

  it("フォルダが無くなっていたら対象から外す", () => {
    const result = matchTargets(
      [target({ uidValidity: null })],
      new Map(),
      new Map(),
      new Map(),
    );
    expect(result).toEqual({ present: [], absent: [] });
  });

  it("Microsoft Graph のメールは不変 ID で突き合わせる", () => {
    const graph = target({
      uid: null,
      uidValidity: null,
      providerMessageId: "g1",
    });
    const result = matchTargets(
      [graph],
      new Map([["box1", null]]),
      new Map(),
      new Map([["g1", "m9"]]),
    );
    expect(result.present).toEqual([{ ...graph, messageId: "m9" }]);
  });
});
