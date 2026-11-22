// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import type { MailboxSummary } from "@/lib/api";
import {
  changeSwipeSettings,
  clampOffset,
  DEFAULT_SWIPE,
  parseSwipe,
  refreshSwipeSettings,
  resetSwipeSettingsForTest,
  resolveSwipe,
  shouldCommit,
  swipeAxis,
  swipeThreshold,
} from "@/lib/swipe";

function mailbox(
  id: string,
  specialUse: MailboxSummary["specialUse"] = null,
): MailboxSummary {
  return {
    id,
    accountId: "account",
    parentId: null,
    path: id,
    name: id,
    specialUse,
    sortOrder: null,
    lastSyncedAt: null,
    totalCount: 0,
    unreadCount: 0,
  } as MailboxSummary;
}

const mailboxes = [
  mailbox("inbox", "inbox"),
  mailbox("archive", "archive"),
  mailbox("trash", "trash"),
  mailbox("junk", "junk"),
  mailbox("work"),
];
const row = { seen: false, flagged: false, mailboxId: "inbox" };

describe("スワイプで行う操作", () => {
  it("「なし」は何もしない", () => {
    expect(resolveSwipe("none", row, mailboxes)).toBeNull();
  });

  it("既読 / 未読は、いまの状態の逆にする", () => {
    expect(resolveSwipe("toggle_read", row, mailboxes)).toMatchObject({
      kind: "read",
      removes: false,
      input: { action: "set_flags", seen: true },
    });
    expect(
      resolveSwipe("toggle_read", { ...row, seen: true }, mailboxes),
    ).toMatchObject({
      kind: "unread",
      input: { action: "set_flags", seen: false },
    });
  });

  it("スターは、付いていれば外す", () => {
    expect(resolveSwipe("star", row, mailboxes)?.input).toEqual({
      action: "set_flags",
      flagged: true,
    });
    expect(
      resolveSwipe("star", { ...row, flagged: true }, mailboxes),
    ).toMatchObject({ kind: "unstar" });
  });

  it("削除はごみ箱へ移し、ごみ箱の中では完全に削除する", () => {
    expect(resolveSwipe("delete", row, mailboxes)).toMatchObject({
      kind: "trash",
      removes: true,
      input: { action: "move", mailboxId: "trash" },
    });
    expect(
      resolveSwipe("delete", { ...row, mailboxId: "trash" }, mailboxes),
    ).toMatchObject({ kind: "delete", input: { action: "delete" } });
  });

  it("役割を付け替えたフォルダがあれば、そこを移動先にする", () => {
    // ドコモメールのように、独自のフォルダに迷惑メールの役割を付けた場合。
    const overridden = [
      mailbox("inbox", "inbox"),
      mailbox("old-junk"),
      mailbox("custom-junk", "junk"),
    ];
    expect(resolveSwipe("junk", row, overridden)?.input).toEqual({
      action: "move",
      mailboxId: "custom-junk",
    });
  });

  it("迷惑メールのフォルダの中では、受信トレイへ戻す", () => {
    expect(
      resolveSwipe("junk", { ...row, mailboxId: "junk" }, mailboxes),
    ).toMatchObject({
      kind: "not_junk",
      input: { action: "move", mailboxId: "inbox" },
    });
  });

  it("移動先が無い操作は、その行ではできない", () => {
    const only = [mailbox("inbox", "inbox")];
    expect(resolveSwipe("archive", row, only)).toBeNull();
    expect(resolveSwipe("delete", row, only)).toBeNull();
    expect(resolveSwipe("junk", row, only)).toBeNull();
    expect(resolveSwipe("move", row, only)).toBeNull();
    // すでにアーカイブの中にあるメールは、アーカイブできない。
    expect(
      resolveSwipe("archive", { ...row, mailboxId: "archive" }, mailboxes),
    ).toBeNull();
  });

  it("「フォルダを選んで移動」は、操作を送らずに移動先を選ばせる", () => {
    expect(resolveSwipe("move", row, mailboxes)).toMatchObject({
      kind: "move",
      removes: false,
      input: null,
    });
  });
});

describe("指の動きの判定", () => {
  it("少ししか動いていない間は、向きを決めない", () => {
    expect(swipeAxis(6, 3)).toBeNull();
  });

  it("横に大きく動けばスワイプ、縦や斜めならスクロール", () => {
    expect(swipeAxis(20, 4)).toBe("x");
    expect(swipeAxis(-20, 4)).toBe("x");
    expect(swipeAxis(4, 20)).toBe("y");
    expect(swipeAxis(12, 10)).toBe("y");
  });

  it("操作を行う位置は行の幅の 3 割で、64〜120 px に収める", () => {
    expect(swipeThreshold(100)).toBe(64);
    expect(swipeThreshold(360)).toBe(108);
    expect(swipeThreshold(1000)).toBe(120);
  });

  it("十分にずらすか、同じ向きに素早く払えば操作を行う", () => {
    expect(shouldCommit(-110, 360)).toBe(true);
    expect(shouldCommit(-60, 360)).toBe(false);
    expect(shouldCommit(-60, 360, -1)).toBe(true);
    // 戻す向きに払ったときは行わない。
    expect(shouldCommit(-60, 360, 1)).toBe(false);
    // ほとんど動かしていなければ、払っても行わない。
    expect(shouldCommit(-20, 360, -2)).toBe(false);
  });

  it("操作の無い向きへは動かさない", () => {
    expect(clampOffset(-50, 300, { left: false, right: true })).toBe(0);
    expect(clampOffset(50, 300, { left: false, right: true })).toBe(50);
    expect(clampOffset(-500, 300, { left: true, right: true })).toBe(-300);
  });
});

describe("設定の保持", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetSwipeSettingsForTest();
  });

  it("知らない操作は、その向きだけ標準の値にする", () => {
    expect(parseSwipe(null)).toEqual(DEFAULT_SWIPE);
    expect(parseSwipe({ left: "snooze", right: "archive" })).toEqual({
      left: "delete",
      right: "archive",
    });
  });

  it("サーバーの設定を取得して、端末にも残す", async () => {
    await refreshSwipeSettings(async () => ({
      swipe: { left: "archive", right: "star" },
    }));
    expect(
      JSON.parse(window.localStorage.getItem("mail.swipe.v1") ?? ""),
    ).toEqual({ left: "archive", right: "star" });
  });

  it("保存できなければ、元の設定に戻す", async () => {
    await refreshSwipeSettings(async () => ({
      swipe: { left: "archive", right: "star" },
    }));
    const saved = await changeSwipeSettings({ left: "none" }, async () => {
      throw new Error("offline");
    });
    expect(saved).toBe(false);
    expect(
      JSON.parse(window.localStorage.getItem("mail.swipe.v1") ?? ""),
    ).toEqual({ left: "archive", right: "star" });
  });

  it("保存の途中に届いた古い設定で、選んだ設定を上書きしない", async () => {
    let finish: () => void = () => {};
    const saving = changeSwipeSettings(
      { right: "junk" },
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    await refreshSwipeSettings(async () => ({ swipe: DEFAULT_SWIPE }));
    finish();
    expect(await saving).toBe(true);
    expect(
      JSON.parse(window.localStorage.getItem("mail.swipe.v1") ?? ""),
    ).toEqual({ left: "delete", right: "junk" });
  });
});
