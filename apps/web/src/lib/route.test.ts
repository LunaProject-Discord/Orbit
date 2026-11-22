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
  it("何も選んでいなければ /", () => {
    expect(buildRoute(emptyRoute)).toBe("/");
    expect(parseRoute("/")).toEqual(emptyRoute);
    expect(parseRoute("")).toEqual(emptyRoute);
  });

  it("アカウント、フォルダ、メール、作成画面をパスで往復できる", () => {
    const route: MailRoute = {
      ...emptyRoute,
      accountId: ACCOUNT,
      mailboxId: FOLDER,
      messageId: MESSAGE,
      composeId: DRAFT,
    };
    const url = buildRoute(route);
    expect(url).toBe(
      `/accounts/${ACCOUNT}/folders/${FOLDER}/messages/${MESSAGE}/compose/${DRAFT}`,
    );
    expect(parseRoute(url)).toEqual(route);
  });

  it("途中を省いた形も往復できる", () => {
    const routes: MailRoute[] = [
      { ...emptyRoute, accountId: ACCOUNT },
      { ...emptyRoute, accountId: ACCOUNT, mailboxId: FOLDER },
      { ...emptyRoute, accountId: ACCOUNT, messageId: MESSAGE },
      { ...emptyRoute, messageId: MESSAGE },
      { ...emptyRoute, composeId: "new" },
      { ...emptyRoute, messageId: MESSAGE, composeId: DRAFT },
    ];
    for (const route of routes) {
      expect(parseRoute(buildRoute(route))).toEqual(route);
    }
    expect(buildRoute(routes[0] as MailRoute)).toBe(`/accounts/${ACCOUNT}`);
    expect(buildRoute(routes[3] as MailRoute)).toBe(`/messages/${MESSAGE}`);
    expect(buildRoute(routes[4] as MailRoute)).toBe("/compose/new");
  });

  it("統合フォルダと、その中で開いたメールを往復できる", () => {
    const route: MailRoute = {
      ...emptyRoute,
      unifiedId: FOLDER,
      messageId: MESSAGE,
    };
    const url = buildRoute(route);
    expect(url).toBe(`/unified/${FOLDER}/messages/${MESSAGE}`);
    expect(parseRoute(url)).toEqual(route);
    expect(parseRoute(`/unified/${FOLDER}?q=abc`).search?.text).toBe("abc");
    expect(historyMode(emptyRoute, { ...emptyRoute, unifiedId: FOLDER })).toBe(
      "push",
    );
  });

  it("末尾の / や ID の大文字を気にしない", () => {
    expect(parseRoute(`/accounts/${ACCOUNT.toUpperCase()}/`)).toEqual({
      ...emptyRoute,
      accountId: ACCOUNT,
    });
  });

  it("検索の内容は ? 以降に置き、往復できる", () => {
    const route: MailRoute = {
      ...emptyRoute,
      accountId: ACCOUNT,
      messageId: MESSAGE,
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
    const url = buildRoute(route);
    expect(url.startsWith(`/accounts/${ACCOUNT}/messages/${MESSAGE}?q=`)).toBe(
      true,
    );
    expect(parseRoute(url)).toEqual(route);
    expect(parseRoute("/?q=abc").search?.text).toBe("abc");
  });

  it("検索する内容が無ければ、検索中として扱わない", () => {
    expect(parseRoute("/?q=&in=folder").search).toBeNull();
    expect(
      buildRoute({
        ...emptyRoute,
        search: { text: "", filters: emptyFilters, scope: "folder" },
      }),
    ).toBe("/");
  });

  it("下書きの一覧では、フォルダやメールを URL に残さない", () => {
    const url = buildRoute({
      ...emptyRoute,
      accountId: ACCOUNT,
      mailboxId: FOLDER,
      messageId: MESSAGE,
      drafts: true,
      composeId: DRAFT,
    });
    expect(url).toBe(`/drafts/compose/${DRAFT}`);
    expect(parseRoute(url)).toEqual({
      ...emptyRoute,
      drafts: true,
      composeId: DRAFT,
    });
  });

  it("形の合わない部分は無視する", () => {
    expect(parseRoute("/accounts/1/folders/abc")).toEqual(emptyRoute);
    expect(parseRoute("/unknown/page")).toEqual(emptyRoute);
    expect(parseRoute("/messages/<script>/compose/x?since=11/21")).toEqual(
      emptyRoute,
    );
    // アカウントの ID が壊れていても、読み取れる部分は使う。
    expect(parseRoute(`/accounts/x/messages/${MESSAGE}`)).toEqual(emptyRoute);
    expect(parseRoute(`/accounts/${ACCOUNT}/folders/x`)).toEqual({
      ...emptyRoute,
      accountId: ACCOUNT,
    });
  });
});

describe("以前の形の URL (すべて ? 以降)", () => {
  it("読み取って、いまの形に直せる", () => {
    const cases: [string, string][] = [
      [
        `/?account=${ACCOUNT}&folder=${FOLDER}&message=${MESSAGE}&compose=${DRAFT}`,
        `/accounts/${ACCOUNT}/folders/${FOLDER}/messages/${MESSAGE}/compose/${DRAFT}`,
      ],
      [`/?message=${MESSAGE}`, `/messages/${MESSAGE}`],
      [`?message=${MESSAGE}`, `/messages/${MESSAGE}`],
      ["/?view=drafts", "/drafts"],
      ["/?view=settings", "/settings"],
      [`/?view=starred&message=${MESSAGE}`, `/starred/messages/${MESSAGE}`],
      ["/?compose=new", "/compose/new"],
      [
        `/?account=${ACCOUNT}&q=abc&unread=1`,
        `/accounts/${ACCOUNT}?q=abc&unread=1`,
      ],
    ];
    for (const [legacy, current] of cases) {
      expect(buildRoute(parseRoute(legacy))).toBe(current);
    }
  });

  it("形の合わない値は無視する", () => {
    expect(
      parseRoute(
        "/?account=1&folder=abc&message=<script>&compose=x&since=11/21&view=other",
      ),
    ).toEqual(emptyRoute);
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
    expect(safeReturnPath(`/accounts/${ACCOUNT}?q=a`)).toBe(
      `/accounts/${ACCOUNT}?q=a`,
    );
    expect(safeReturnPath("/")).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath("//example.com")).toBeNull();
    expect(safeReturnPath("/\\example.com")).toBeNull();
    expect(safeReturnPath("https://example.com/")).toBeNull();
    expect(safeReturnPath("/login?next=/")).toBeNull();
  });
});

describe("フォルダ以外の表示", () => {
  it("スター付き、送信待ち、設定を URL に残す", () => {
    for (const special of ["starred", "outgoing", "settings"] as const) {
      const url = buildRoute({ ...emptyRoute, special });
      expect(url).toBe(`/${special}`);
      expect(parseRoute(url)).toEqual({ ...emptyRoute, special });
    }
  });

  it("スター付きの一覧で開いたメールも残す", () => {
    const messageId = "0198f1c2-0000-7000-8000-000000000001";
    const route = { ...emptyRoute, special: "starred" as const, messageId };
    expect(buildRoute(route)).toBe(`/starred/messages/${messageId}`);
    expect(parseRoute(buildRoute(route))).toEqual(route);
    // 設定ではメールを開かない。
    expect(parseRoute(`/settings/messages/${messageId}`).messageId).toBe(null);
  });

  it("表示を切り替えたら履歴に積む", () => {
    expect(
      historyMode(emptyRoute, { ...emptyRoute, special: "settings" }),
    ).toBe("push");
  });

  it("知らない view は、通常の一覧として扱う", () => {
    expect(parseRoute("?view=unknown")).toEqual(emptyRoute);
  });
});
