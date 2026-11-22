// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  changeNotificationActions,
  parseNotificationActions,
  refreshNotificationActions,
  resetNotificationActionsForTest,
  toggleNotificationAction,
} from "@/lib/notification-actions";

const cached = () =>
  JSON.parse(
    window.localStorage.getItem("mail.notification-actions.v1") ?? "null",
  );

describe("parseNotificationActions", () => {
  it("保存していなければ標準のボタン", () => {
    expect(parseNotificationActions(undefined)).toEqual([
      "read",
      "archive",
      "delete",
    ]);
  });

  it("知らないボタンと重複を捨て、3 つまでにする", () => {
    expect(
      parseNotificationActions([
        "junk",
        "reply",
        "junk",
        "star",
        "read",
        "delete",
      ]),
    ).toEqual(["junk", "star", "read"]);
    expect(parseNotificationActions([])).toEqual([]);
  });
});

describe("toggleNotificationAction", () => {
  it("選んだボタンを最後に足し、外したボタンを除く", () => {
    expect(toggleNotificationAction(["read"], "junk", true)).toEqual([
      "read",
      "junk",
    ]);
    expect(toggleNotificationAction(["read", "junk"], "read", false)).toEqual([
      "junk",
    ]);
  });

  it("上限まで選んでいるときは足さない", () => {
    expect(
      toggleNotificationAction(["read", "archive", "delete"], "star", true),
    ).toEqual(["read", "archive", "delete"]);
  });
});

describe("設定の保持", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetNotificationActionsForTest();
  });

  it("サーバーの設定を取り込み、端末にも残す", async () => {
    await refreshNotificationActions(async () => ({
      notificationActions: ["star", "junk"],
    }));
    expect(cached()).toEqual(["star", "junk"]);
  });

  it("保存できなければ、元の設定に戻す", async () => {
    await refreshNotificationActions(async () => ({
      notificationActions: ["star"],
    }));
    const saved = await changeNotificationActions(
      ["star", "junk"],
      async () => {
        throw new Error("offline");
      },
    );
    expect(saved).toBe(false);
    expect(cached()).toEqual(["star"]);
  });

  it("保存の途中に届いた古い設定で、選んだ設定を上書きしない", async () => {
    let finish: () => void = () => {};
    const saving = changeNotificationActions(
      ["junk"],
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    await refreshNotificationActions(async () => ({
      notificationActions: ["read"],
    }));
    finish();
    expect(await saving).toBe(true);
    expect(cached()).toEqual(["junk"]);
  });
});
