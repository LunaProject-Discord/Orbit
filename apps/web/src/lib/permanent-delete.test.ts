import { describe, expect, it } from "vitest";
import {
  isInTrash,
  skipsDeleteConfirm,
  splitForDelete,
} from "@/lib/permanent-delete";

const mailboxes = [
  { id: "inbox", specialUse: "inbox" },
  { id: "trash", specialUse: "trash" },
  { id: "work", specialUse: null },
];

describe("permanent-delete", () => {
  it("ごみ箱にあるメールを見分ける", () => {
    expect(isInTrash({ mailboxId: "trash" }, mailboxes)).toBe(true);
    expect(isInTrash({ mailboxId: "inbox" }, mailboxes)).toBe(false);
    expect(isInTrash({ mailboxId: "unknown" }, mailboxes)).toBe(false);
  });

  it("ごみ箱へ移すものと完全に削除するものに分ける", () => {
    const rows = [
      { id: "a", mailboxId: "inbox" },
      { id: "b", mailboxId: "trash" },
      { id: "c", mailboxId: "work" },
    ];
    expect(splitForDelete(rows, mailboxes)).toEqual({
      toTrash: [rows[0], rows[2]],
      permanent: [rows[1]],
    });
  });

  it("Shift を押しながらの操作だけ確認を出さない", () => {
    expect(skipsDeleteConfirm({ shiftKey: true })).toBe(true);
    expect(skipsDeleteConfirm({ shiftKey: false })).toBe(false);
    expect(skipsDeleteConfirm({ shiftKey: true, key: "Delete" })).toBe(true);
    // 「#」はもともと Shift で入力するキー。
    expect(skipsDeleteConfirm({ shiftKey: true, key: "#" })).toBe(false);
  });
});
