import { describe, expect, it } from "vitest";
import { type SyncInput, syncStatusOf } from "./sync-status";

const base: SyncInput = {
  online: true,
  connected: true,
  pendingActions: 0,
  pendingMails: 0,
  accounts: [{ status: "active" }],
  devices: 1,
};

describe("syncStatusOf", () => {
  it("何も待っていなければ同期済み", () => {
    expect(syncStatusOf(base)).toEqual({
      tone: "ok",
      label: "同期済み",
      short: "同期済み",
    });
  });

  it("ほかの端末も接続していれば、台数を添える", () => {
    expect(syncStatusOf({ ...base, devices: 4 }).label).toBe(
      "同期済み · 4 台の端末と一致",
    );
  });

  it("送れていない操作や送信待ちがあれば同期中", () => {
    const status = syncStatusOf({
      ...base,
      pendingActions: 2,
      pendingMails: 1,
    });
    expect(status.tone).toBe("busy");
    expect(status.label).toBe("同期中 · 3 件を反映しています");
  });

  it("オフラインでは、接続後に行うことを伝える", () => {
    expect(syncStatusOf({ ...base, online: false }).label).toBe("オフライン");
    expect(
      syncStatusOf({ ...base, online: false, pendingMails: 1 }).label,
    ).toBe("オフライン · 接続後に 1 件を送信");
    expect(
      syncStatusOf({
        ...base,
        online: false,
        pendingActions: 2,
        pendingMails: 1,
      }).label,
    ).toBe("オフライン · 接続後に 2 件の操作を反映、1 件を送信");
  });

  it("サーバーに繋がらない間は再接続中", () => {
    const status = syncStatusOf({ ...base, connected: false });
    expect(status.tone).toBe("offline");
    expect(status.short).toBe("再接続中");
  });

  it("まだ繋がっていない間は接続中", () => {
    expect(syncStatusOf({ ...base, connected: null }).short).toBe("接続中");
    expect(syncStatusOf({ ...base, accounts: null }).short).toBe("接続中");
  });

  it("同期できていないアカウントがあれば知らせる", () => {
    const status = syncStatusOf({
      ...base,
      accounts: [{ status: "active" }, { status: "auth_required" }],
      pendingActions: 1,
    });
    expect(status.tone).toBe("error");
    expect(status.label).toBe("1 件のアカウントを同期できていません");
  });
});
