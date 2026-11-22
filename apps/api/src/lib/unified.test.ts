import { describe, expect, it } from "vitest";
import {
  normalizeFilters,
  normalizeScope,
  sidebarLayout,
  unifiedFilters,
  unifiedScope,
} from "./unified.js";

const ID = "01a20204-fedc-7eb2-a37f-deedef89d227";

describe("統合フォルダの内容", () => {
  it("役割は決まった順に揃え、フォルダの重複を除く", () => {
    expect(
      normalizeScope({
        all: false,
        roles: ["sent", "inbox", "sent"],
        mailboxIds: [ID, ID.toUpperCase()],
      }),
    ).toEqual({ all: false, roles: ["inbox", "sent"], mailboxIds: [ID] });
  });

  it("条件の文字は前後の空白を落とす", () => {
    const filters = normalizeFilters({
      unread: true,
      flagged: false,
      hasAttachment: false,
      from: " github ",
      to: "",
      subject: "",
      text: "",
      withinDays: 7,
    });
    expect(filters.from).toBe("github");
    expect(unifiedFilters.safeParse(filters).success).toBe(true);
  });

  it("知らない役割や、形の違う ID は受け付けない", () => {
    expect(
      unifiedScope.safeParse({ all: false, roles: ["all"], mailboxIds: [] })
        .success,
    ).toBe(false);
    expect(
      unifiedScope.safeParse({ all: false, roles: [], mailboxIds: ["x"] })
        .success,
    ).toBe(false);
  });

  it("並び順は、初めからある項目の名前か統合フォルダの ID だけを、重複なしで受け付ける", () => {
    expect(
      sidebarLayout.safeParse({ order: ["starred", ID, "inbox"], hidden: [] })
        .success,
    ).toBe(true);
    expect(
      sidebarLayout.safeParse({ order: ["settings"], hidden: [] }).success,
    ).toBe(false);
    expect(
      sidebarLayout.safeParse({ order: ["inbox", "inbox"], hidden: [] })
        .success,
    ).toBe(false);
  });
});
