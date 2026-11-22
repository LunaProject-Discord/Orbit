import { describe, expect, it } from "vitest";
import type { MailboxSummary, UnifiedFolder, UnifiedState } from "@/lib/api";
import {
  builtinLabel,
  builtinStyle,
  describeUnified,
  emptyUnifiedFilters,
  isScopeEmpty,
  reorderLayout,
  scopeMailboxes,
  setEntryHidden,
  sidebarEntries,
} from "@/lib/unified";

const folder = (
  id: string,
  patch: Partial<UnifiedFolder> = {},
): UnifiedFolder => ({
  id,
  name: id,
  icon: null,
  color: null,
  scope: { all: false, roles: ["inbox"], mailboxIds: [] },
  filters: emptyUnifiedFilters,
  createdAt: "2026-11-22T00:00:00.000Z",
  unreadCount: 0,
  ...patch,
});

const mailbox = (
  id: string,
  specialUse: MailboxSummary["specialUse"],
): MailboxSummary =>
  ({ id, accountId: "a", name: id, specialUse }) as MailboxSummary;

const keys = (state: Pick<UnifiedState, "folders" | "layout">) =>
  sidebarEntries(state).visible.map((entry) => entry.key);

describe("sidebarEntries", () => {
  it("並び順を保存していなければ、初めからある項目、統合フォルダの順に並べる", () => {
    const state = {
      folders: [folder("f1"), folder("f2")],
      layout: { order: [], hidden: [] },
    };
    expect(keys(state)).toEqual([
      "inbox",
      "starred",
      "drafts",
      "outgoing",
      "f1",
      "f2",
    ]);
  });

  it("保存した順に並べ、載っていない項目は後ろに足し、無くなった項目は無視する", () => {
    const state = {
      folders: [folder("f1"), folder("f2")],
      layout: { order: ["f2", "starred", "gone", "inbox"], hidden: ["drafts"] },
    };
    expect(keys(state)).toEqual(["f2", "starred", "inbox", "outgoing", "f1"]);
    expect(sidebarEntries(state).all).toHaveLength(6);
  });
});

describe("reorderLayout", () => {
  it("隠している項目の位置を保ったまま、見えている項目を並び替える", () => {
    const state = {
      folders: [folder("f1")],
      layout: { order: [], hidden: ["starred"] },
    };
    const layout = reorderLayout(state, ["f1", "inbox", "drafts", "outgoing"]);
    expect(layout).toEqual({
      order: ["f1", "starred", "inbox", "drafts", "outgoing"],
      hidden: ["starred"],
    });
  });
});

describe("setEntryHidden", () => {
  it("項目を隠し、また表示できる", () => {
    const state = {
      folders: [folder("f1")],
      layout: { order: [], hidden: [] },
    };
    const hidden = setEntryHidden(state, "outgoing", true);
    expect(hidden.hidden).toEqual(["outgoing"]);
    expect(keys({ ...state, layout: hidden })).toEqual([
      "inbox",
      "starred",
      "drafts",
      "f1",
    ]);
    const shown = setEntryHidden(
      { ...state, layout: hidden },
      "outgoing",
      false,
    );
    expect(shown.hidden).toEqual([]);
  });

  it("無くなった統合フォルダは、隠した項目から外す", () => {
    const state = { folders: [], layout: { order: [], hidden: ["gone"] } };
    expect(setEntryHidden(state, "starred", true).hidden).toEqual(["starred"]);
  });
});

describe("初めからある項目の見た目", () => {
  it("名前を付けていなければ初期の名前、付けていればその名前を出す", () => {
    const state = {
      builtins: { starred: { name: "大事", icon: "heart", color: "#f43f5e" } },
    };
    expect(builtinLabel(state, "inbox")).toBe("すべての受信トレイ");
    expect(builtinLabel(state, "starred")).toBe("大事");
    expect(builtinStyle(state, "starred").icon).toBe("heart");
    expect(builtinStyle(state, "drafts")).toEqual({
      name: null,
      icon: null,
      color: null,
    });
  });

  it("アイコンだけ変えた項目は、名前は初期のまま", () => {
    const state = {
      builtins: { inbox: { name: null, icon: "📥", color: null } },
    };
    expect(builtinLabel(state, "inbox")).toBe("すべての受信トレイ");
  });
});

describe("scopeMailboxes", () => {
  const mailboxes = [
    mailbox("inbox", "inbox"),
    mailbox("sent", "sent"),
    mailbox("trash", "trash"),
    mailbox("work", null),
  ];

  it("役割と、個別に選んだフォルダを合わせる", () => {
    const scope = {
      all: false,
      roles: ["sent" as const],
      mailboxIds: ["work"],
    };
    expect(scopeMailboxes(scope, mailboxes).map((item) => item.id)).toEqual([
      "sent",
      "work",
    ]);
  });

  it("すべてのフォルダでは、ごみ箱と迷惑メールを除く", () => {
    const scope = { all: true, roles: [], mailboxIds: [] };
    expect(scopeMailboxes(scope, mailboxes).map((item) => item.id)).toEqual([
      "inbox",
      "sent",
      "work",
    ]);
  });

  it("何も選んでいない場所を見分ける", () => {
    expect(isScopeEmpty({ all: false, roles: [], mailboxIds: [] })).toBe(true);
    expect(isScopeEmpty({ all: true, roles: [], mailboxIds: [] })).toBe(false);
  });
});

describe("describeUnified", () => {
  it("場所と条件を短い文にする", () => {
    const text = describeUnified(
      {
        scope: { all: false, roles: ["sent"], mailboxIds: ["work", "gone"] },
        filters: { ...emptyUnifiedFilters, unread: true, withinDays: 7 },
      },
      [mailbox("work", null)],
    );
    expect(text).toBe(
      "全アカウントの送信済み、選んだフォルダ 1 個 / 未読、7 日以内",
    );
  });
});
