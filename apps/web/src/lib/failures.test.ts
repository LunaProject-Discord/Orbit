import { describe, expect, it } from "vitest";
import type { FailedOperation } from "@/lib/api";
import {
  failureDescription,
  failureLabel,
  failureReport,
  failureSummary,
} from "@/lib/failures";

const mailboxes = [
  { id: "trash", name: "Trash", specialUse: "trash" as const },
  { id: "archive", name: "Archive", specialUse: "archive" as const },
  { id: "project", name: "プロジェクト", specialUse: null },
];

function failure(overrides: Partial<FailedOperation> = {}): FailedOperation {
  return {
    id: "f1",
    accountId: "a1",
    kind: "move",
    count: 1,
    mailboxName: null,
    seen: null,
    flagged: null,
    answered: null,
    destinationMailboxId: "project",
    error: "NO [CANNOT] Mailbox is read-only",
    createdAt: "2026-11-21T10:00:00.000Z",
    failedAt: "2026-11-21T10:00:05.000Z",
    ...overrides,
  };
}

describe("failureLabel", () => {
  it("移動は、移動先の役割に合わせて呼び分ける", () => {
    expect(failureLabel(failure(), mailboxes)).toBe("移動");
    expect(
      failureLabel(failure({ destinationMailboxId: "trash" }), mailboxes),
    ).toBe("削除");
    expect(
      failureLabel(failure({ destinationMailboxId: "archive" }), mailboxes),
    ).toBe("アーカイブ");
    // 移動先のフォルダがもう無い場合
    expect(
      failureLabel(failure({ destinationMailboxId: "gone" }), mailboxes),
    ).toBe("移動");
  });

  it("既読やスターは、変えようとした内容で呼び分ける", () => {
    const flags = (values: Partial<FailedOperation>) =>
      failureLabel(
        failure({ kind: "set_flags", destinationMailboxId: null, ...values }),
        mailboxes,
      );
    expect(flags({ seen: true })).toBe("既読への変更");
    expect(flags({ seen: false })).toBe("未読への変更");
    expect(flags({ flagged: true })).toBe("スター");
    expect(flags({ flagged: false })).toBe("スターの解除");
    expect(flags({ answered: true })).toBe("返信済みのマーク");
    expect(flags({ seen: true, flagged: true })).toBe("既読やスターの変更");
  });

  it("完全な削除と、控えの保存", () => {
    expect(failureLabel(failure({ kind: "delete" }), mailboxes)).toBe("削除");
    expect(failureLabel(failure({ kind: "append" }), mailboxes)).toBe(
      "送信済みフォルダへの保存",
    );
  });
});

describe("failureSummary", () => {
  it("1 件なら、その操作の名前で伝える", () => {
    expect(failureSummary([failure()], mailboxes)).toBe(
      "1 件の移動をサーバーに反映できませんでした",
    );
  });

  it("同じ種類なら件数を合計する", () => {
    expect(
      failureSummary(
        [failure({ count: 2 }), failure({ id: "f2", count: 3 })],
        mailboxes,
      ),
    ).toBe("5 件の移動をサーバーに反映できませんでした");
  });

  it("種類が混ざっていれば「操作」とまとめる", () => {
    expect(
      failureSummary(
        [
          failure(),
          failure({ id: "f2", kind: "set_flags", seen: true, count: 2 }),
        ],
        mailboxes,
      ),
    ).toBe("3 件の操作をサーバーに反映できませんでした");
  });
});

describe("failureDescription", () => {
  it("移動は移動先のフォルダを添える", () => {
    expect(failureDescription(failure({ count: 2 }), mailboxes)).toBe(
      "2 件を「プロジェクト」へ移動",
    );
    expect(
      failureDescription(failure({ destinationMailboxId: "trash" }), mailboxes),
    ).toBe("1 件の削除");
  });
});

describe("failureReport", () => {
  it("操作、アカウント、理由をテキストにまとめる", () => {
    const report = failureReport(
      [failure(), failure({ id: "f2", kind: "delete", error: null })],
      mailboxes,
      () => "aoi@example.com",
    );
    expect(report).toContain("1 件を「プロジェクト」へ移動 (aoi@example.com)");
    expect(report).toContain("理由: NO [CANNOT] Mailbox is read-only");
    expect(report).toContain("1 件の削除 (aoi@example.com)");
    expect(report).toContain("理由: 不明");
  });

  it("フォルダへの操作は、フォルダの名前を添えて説明する", () => {
    const create = failure({ kind: "mailbox_create", mailboxName: "請求書" });
    expect(failureLabel(create, mailboxes)).toBe("フォルダの作成");
    expect(failureDescription(create, mailboxes)).toBe(
      "フォルダ「請求書」の作成",
    );
    expect(
      failureDescription(
        failure({ kind: "mailbox_delete", mailboxName: "旧" }),
        mailboxes,
      ),
    ).toBe("フォルダ「旧」の削除");
  });
});
