import { describe, expect, it } from "vitest";
import {
  buildRoute,
  emptyRoute,
  historyMode,
  type MailRoute,
  parseRoute,
  safeReturnPath,
  sameSearch,
} from "@/lib/route";
import { emptyFilters } from "@/lib/search";

const ACCOUNT = "019ab000-0000-7000-8000-000000000001";
const FOLDER = "019ab000-0000-7000-8000-000000000002";
const MESSAGE = "019ab000-0000-7000-8000-000000000003";
const DRAFT = "3f2b8c1e-6d1f-4c0a-9a57-1d2e3f4a5b6c";

describe("buildRoute と parseRoute", () => {
  it("何も選んでいなければ、URL には何も付けない", () => {
    expect(buildRoute(emptyRoute)).toBe("");
    expect(parseRoute("")).toEqual(emptyRoute);
  });

  it("アカウント、フォルダ、メール、作成画面を往復できる", () => {
    const route: MailRoute = {
      ...emptyRoute,
      accountId: ACCOUNT,
      mailboxId: FOLDER,
      messageId: MESSAGE,
      composeId: DRAFT,
    };
    const query = buildRoute(route);
    expect(query).toBe(
      `?account=${ACCOUNT}&folder=${FOLDER}&message=${MESSAGE}&compose=${DRAFT}`,
    );
    expect(parseRoute(query)).toEqual(route);
  });

  it("検索の内容を往復できる", () => {
    const route: MailRoute = {
      ...emptyRoute,
      accountId: ACCOUNT,
      search: {
        text: "見積もり 2026",
        filters: {
          from: "tanaka@example.com",
          to: "",
          subject: "件名 & 記号",
          since: "2026-11-01",
          until: "2026-11-21",
          hasAttachment: true,
          unread: false,
          flagged: true,
        },
        scope: "folder",
      },
    };
    expect(parseRoute(buildRoute(route))).toEqual(route);
  });

  it("検索する内容が無ければ、検索中として扱わない", () => {
    expect(parseRoute("?q=&in=folder").search).toBeNull();
    expect(
      buildRoute({
        ...emptyRoute,
        search: { text: "", filters: emptyFilters, scope: "folder" },
      }),
    ).toBe("");
  });

  it("下書きの一覧では、フォルダやメールを URL に残さない", () => {
    const query = buildRoute({
      ...emptyRoute,
      accountId: ACCOUNT,
      mailboxId: FOLDER,
      messageId: MESSAGE,
      drafts: true,
      composeId: DRAFT,
    });
    expect(query).toBe(`?view=drafts&compose=${DRAFT}`);
    expect(parseRoute(query)).toEqual({
      ...emptyRoute,
      drafts: true,
      composeId: DRAFT,
    });
  });

  it("新規のメールは compose=new で表す", () => {
    expect(parseRoute("?compose=new").composeId).toBe("new");
  });

  it("形の合わない値は無視する", () => {
    expect(
      parseRoute(
        "?account=1&folder=abc&message=<script>&compose=x&since=11/21&view=other",
      ),
    ).toEqual(emptyRoute);
  });

  it("通知から開いた URL (?message=) を読める", () => {
    expect(parseRoute(`?message=${MESSAGE}`)).toEqual({
      ...emptyRoute,
      messageId: MESSAGE,
    });
  });
});

describe("sameSearch", () => {
  const search = { text: "a", filters: emptyFilters, scope: "all" as const };

  it("内容が同じなら、別のオブジェクトでも同じとみなす", () => {
    expect(
      sameSearch(search, { ...search, filters: { ...emptyFilters } }),
    ).toBe(true);
    expect(sameSearch(null, null)).toBe(true);
  });

  it("内容が違えば別とみなす", () => {
    expect(sameSearch(search, null)).toBe(false);
    expect(sameSearch(search, { ...search, text: "b" })).toBe(false);
    expect(sameSearch(search, { ...search, scope: "folder" })).toBe(false);
    expect(
      sameSearch(search, {
        ...search,
        filters: { ...emptyFilters, unread: true },
      }),
    ).toBe(false);
  });
});

describe("historyMode", () => {
  const list: MailRoute = { ...emptyRoute, accountId: ACCOUNT };

  it("フォルダや下書きの一覧へ移ったら、履歴に積む", () => {
    expect(historyMode(emptyRoute, list)).toBe("push");
    expect(historyMode(list, { ...list, mailboxId: FOLDER })).toBe("push");
    expect(historyMode(list, { ...emptyRoute, drafts: true })).toBe("push");
  });

  it("メールや作成画面を開いたら、履歴に積む", () => {
    expect(historyMode(list, { ...list, messageId: MESSAGE })).toBe("push");
    expect(historyMode(list, { ...list, composeId: "new" })).toBe("push");
  });

  it("メールからメールへ移ったときや、検索欄の入力は、履歴を書き換える", () => {
    expect(
      historyMode(
        { ...list, messageId: MESSAGE },
        { ...list, messageId: DRAFT },
      ),
    ).toBe("replace");
    expect(
      historyMode({ ...list, composeId: "new" }, { ...list, composeId: DRAFT }),
    ).toBe("replace");
    expect(
      historyMode(list, {
        ...list,
        search: { text: "a", filters: emptyFilters, scope: "all" },
      }),
    ).toBe("replace");
  });

  it("メールや作成画面を閉じたら close", () => {
    expect(historyMode({ ...list, messageId: MESSAGE }, list)).toBe("close");
    expect(historyMode({ ...list, composeId: DRAFT }, list)).toBe("close");
  });
});

describe("safeReturnPath", () => {
  it("アプリの中のパスだけを通す", () => {
    expect(safeReturnPath(`/?account=${ACCOUNT}`)).toBe(`/?account=${ACCOUNT}`);
    expect(safeReturnPath("/")).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath("//example.com")).toBeNull();
    expect(safeReturnPath("/\\example.com")).toBeNull();
    expect(safeReturnPath("https://example.com/")).toBeNull();
    expect(safeReturnPath("/login?next=/")).toBeNull();
  });
});
