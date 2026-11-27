import { describe, expect, it } from "vitest";
import {
  buildRoute,
  canonicalAppUrl,
  emptyRoute,
  historyMode,
  isMailPath,
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
    expect(buildRoute(emptyRoute)).toBe("/mail");
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
      `/mail/accounts/${ACCOUNT}/folders/${FOLDER}/messages/${MESSAGE}/compose/${DRAFT}`,
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
      { ...emptyRoute, messageId: MESSAGE, single: true },
      { ...emptyRoute, special: "starred", messageId: MESSAGE, single: true },
      {
        ...emptyRoute,
        accountId: ACCOUNT,
        messageId: MESSAGE,
        single: true,
        composeId: DRAFT,
      },
    ];
    for (const route of routes) {
      expect(parseRoute(buildRoute(route))).toEqual(route);
    }
    expect(buildRoute(routes[0] as MailRoute)).toBe(
      `/mail/accounts/${ACCOUNT}`,
    );
    expect(buildRoute(routes[3] as MailRoute)).toBe(
      `/mail/messages/${MESSAGE}`,
    );
    expect(buildRoute(routes[4] as MailRoute)).toBe("/mail/compose/new");
    expect(buildRoute(routes[6] as MailRoute)).toBe(
      `/mail/messages/${MESSAGE}/single`,
    );
  });

  it("統合フォルダと、その中で開いたメールを往復できる", () => {
    const route: MailRoute = {
      ...emptyRoute,
      unifiedId: FOLDER,
      messageId: MESSAGE,
    };
    const url = buildRoute(route);
    expect(url).toBe(`/mail/unified/${FOLDER}/messages/${MESSAGE}`);
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
        text: 'from:tanaka@example.com subject:"件名 & 記号" 見積もり',
        filters: emptyFilters,
        scope: "folder",
      },
    };
    const url = buildRoute(route);
    expect(
      url.startsWith(`/mail/accounts/${ACCOUNT}/messages/${MESSAGE}?q=`),
    ).toBe(true);
    expect(parseRoute(url)).toEqual(route);
    expect(parseRoute("/?q=abc").search?.text).toBe("abc");
  });

  it("以前の絞り込み条件の URL は、検索欄の書き方にして読む", () => {
    const search = parseRoute(
      "/?q=%E8%A6%8B%E7%A9%8D&from=tanaka%40example.com&subject=a+b&since=2026-11-01&until=2026-11-30&attachment=1&unread=1&starred=1",
    ).search;
    expect(search?.text).toBe(
      '見積 from:tanaka@example.com subject:"a b" after:2026-11-01 before:2026-12-01 has:attachment is:unread is:starred',
    );
    expect(search?.filters).toEqual(emptyFilters);
  });

  it("検索する内容が無ければ、検索中として扱わない", () => {
    expect(parseRoute("/?q=&in=folder").search).toBeNull();
    expect(
      buildRoute({
        ...emptyRoute,
        search: { text: "", filters: emptyFilters, scope: "folder" },
      }),
    ).toBe("/mail");
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
    expect(url).toBe(`/mail/drafts/compose/${DRAFT}`);
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
        `/mail/accounts/${ACCOUNT}/folders/${FOLDER}/messages/${MESSAGE}/compose/${DRAFT}`,
      ],
      [`/?message=${MESSAGE}`, `/mail/messages/${MESSAGE}`],
      [`?message=${MESSAGE}`, `/mail/messages/${MESSAGE}`],
      ["/?view=drafts", "/mail/drafts"],
      [
        `/?view=starred&message=${MESSAGE}`,
        `/mail/starred/messages/${MESSAGE}`,
      ],
      ["/?compose=new", "/mail/compose/new"],
      [
        `/?account=${ACCOUNT}&q=abc&unread=1`,
        `/mail/accounts/${ACCOUNT}?q=abc+is%3Aunread`,
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
    expect(safeReturnPath(`/mail/accounts/${ACCOUNT}?q=a`)).toBe(
      `/mail/accounts/${ACCOUNT}?q=a`,
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
  it("スター付き、送信待ちを URL に残す", () => {
    for (const special of ["starred", "outgoing"] as const) {
      const url = buildRoute({ ...emptyRoute, special });
      expect(url).toBe(`/mail/${special}`);
      expect(parseRoute(url)).toEqual({ ...emptyRoute, special });
    }
  });

  it("スター付きの一覧で開いたメールも残す", () => {
    const messageId = "0198f1c2-0000-7000-8000-000000000001";
    const route = { ...emptyRoute, special: "starred" as const, messageId };
    expect(buildRoute(route)).toBe(`/mail/starred/messages/${messageId}`);
    expect(parseRoute(buildRoute(route))).toEqual(route);
  });

  it("設定やカレンダーの URL は、メールの表示として読まない", () => {
    expect(parseRoute("/settings")).toEqual(emptyRoute);
    expect(parseRoute("/settings/common/fonts")).toEqual(emptyRoute);
    expect(parseRoute(`/settings/messages/${MESSAGE}`)).toEqual(emptyRoute);
    expect(parseRoute("/calendar/week/2026-11-27")).toEqual(emptyRoute);
    expect(parseRoute("/contacts")).toEqual(emptyRoute);
  });

  it("表示を切り替えたら履歴に積む", () => {
    expect(historyMode(emptyRoute, { ...emptyRoute, special: "starred" })).toBe(
      "push",
    );
  });

  it("知らない view は、通常の一覧として扱う", () => {
    expect(parseRoute("?view=unknown")).toEqual(emptyRoute);
  });
});

describe("いまの形の URL (/mail/…)", () => {
  it("メールの画面の URL はすべて /mail で始まる", () => {
    const routes: MailRoute[] = [
      emptyRoute,
      { ...emptyRoute, accountId: ACCOUNT, mailboxId: FOLDER },
      { ...emptyRoute, unifiedId: FOLDER, messageId: MESSAGE, single: true },
      { ...emptyRoute, drafts: true, composeId: DRAFT },
      { ...emptyRoute, special: "outgoing" },
      {
        ...emptyRoute,
        search: { text: "abc", filters: emptyFilters, scope: "all" },
      },
    ];
    for (const route of routes) {
      const url = buildRoute(route);
      expect(isMailPath(url.split("?")[0] as string)).toBe(true);
      expect(parseRoute(url)).toEqual(route);
      // いまの形は書き換えない。
      expect(canonicalAppUrl(url)).toBeNull();
    }
  });

  it("isMailPath は /mail と /mail/… だけ", () => {
    expect(isMailPath("/mail")).toBe(true);
    expect(isMailPath("/mail/drafts")).toBe(true);
    expect(isMailPath("/mailbox")).toBe(false);
    expect(isMailPath("/")).toBe(false);
    expect(isMailPath("/settings")).toBe(false);
    expect(isMailPath("/calendar")).toBe(false);
  });
});

describe("canonicalAppUrl (古い URL の書き換え)", () => {
  it("/ はメール (/mail) にする。検索の ? 以降は残す", () => {
    expect(canonicalAppUrl("/")).toBe("/mail");
    expect(canonicalAppUrl("")).toBe("/mail");
    expect(canonicalAppUrl("/?q=abc")).toBe("/mail?q=abc");
  });

  it("/mail が付く前のメールのパスは /mail を前に付ける (? 以降もそのまま)", () => {
    const cases: [string, string][] = [
      [`/accounts/${ACCOUNT}`, `/mail/accounts/${ACCOUNT}`],
      [
        `/accounts/${ACCOUNT}/folders/${FOLDER}/messages/${MESSAGE}/single`,
        `/mail/accounts/${ACCOUNT}/folders/${FOLDER}/messages/${MESSAGE}/single`,
      ],
      [`/unified/${FOLDER}?q=abc`, `/mail/unified/${FOLDER}?q=abc`],
      // 古い版のサービスワーカーが、通知を押したときに開く URL。
      [`/messages/${MESSAGE}`, `/mail/messages/${MESSAGE}`],
      ["/drafts", "/mail/drafts"],
      [`/drafts/compose/${DRAFT}`, `/mail/drafts/compose/${DRAFT}`],
      ["/starred", "/mail/starred"],
      [`/starred/messages/${MESSAGE}`, `/mail/starred/messages/${MESSAGE}`],
      ["/outgoing", "/mail/outgoing"],
      ["/compose/new", "/mail/compose/new"],
      // デスクトップ版の新しいウィンドウ (?window=…) も、種類を残したまま移す。
      [
        "/compose/new?window=compose&fresh=1",
        "/mail/compose/new?window=compose&fresh=1",
      ],
      [
        `/accounts/${ACCOUNT}/messages/${MESSAGE}?window=message`,
        `/mail/accounts/${ACCOUNT}/messages/${MESSAGE}?window=message`,
      ],
    ];
    for (const [legacy, current] of cases) {
      expect(canonicalAppUrl(legacy)).toBe(current);
      // 書き換えた先は、古い URL と同じ表示になる。
      expect(parseRoute(current)).toEqual(parseRoute(legacy));
    }
  });

  it("以前の ? だけの形 (parseLegacyRoute) を、いまのパスにする", () => {
    const cases: [string, string][] = [
      [
        `/?account=${ACCOUNT}&folder=${FOLDER}&message=${MESSAGE}`,
        `/mail/accounts/${ACCOUNT}/folders/${FOLDER}/messages/${MESSAGE}`,
      ],
      [`/?message=${MESSAGE}`, `/mail/messages/${MESSAGE}`],
      ["/?view=drafts", "/mail/drafts"],
      ["/?view=outgoing", "/mail/outgoing"],
      ["/?view=settings", "/settings"],
      ["/?compose=new&window=compose", "/mail/compose/new?window=compose"],
    ];
    for (const [legacy, current] of cases) {
      expect(canonicalAppUrl(legacy)).toBe(current);
    }
  });

  it("以前の設定のページ (/settings/<カテゴリ>) を、分類とページの形にする", () => {
    const cases: [string, string][] = [
      ["/settings/accounts", "/settings/common/accounts"],
      ["/settings/appearance", "/settings/common/appearance"],
      ["/settings/fonts", "/settings/common/fonts"],
      ["/settings/datetime", "/settings/common/datetime"],
      ["/settings/notifications", "/settings/common/notifications"],
      ["/settings/security", "/settings/common/security"],
      ["/settings/system", "/settings/common/system"],
      ["/settings/about", "/settings/common/about"],
      ["/settings/list", "/settings/mail/list"],
      ["/settings/reading", "/settings/mail/reading"],
      ["/settings/actions", "/settings/mail/actions"],
      ["/settings/sidebar", "/settings/mail/sidebar"],
      ["/settings/signatures", "/settings/mail/signatures"],
      // 作成画面を重ねていた形は、設定だけを開く。
      ["/settings/fonts/compose/new", "/settings/common/fonts"],
      ["/settings/unknown", "/settings"],
      ["/settings/", "/settings"],
    ];
    for (const [legacy, current] of cases) {
      expect(canonicalAppUrl(legacy)).toBe(current);
    }
  });

  it("いまの形と、ほかのアプリの URL は書き換えない", () => {
    for (const url of [
      "/mail",
      `/mail/accounts/${ACCOUNT}?q=a`,
      "/settings",
      "/settings/common/accounts",
      "/settings/mail/list",
      "/settings/calendar/notifications",
      "/calendar",
      "/calendar/week/2026-11-27",
      `/calendar/events/${MESSAGE}?o=2026-11-27`,
      "/contacts",
      "/admin",
    ]) {
      expect(canonicalAppUrl(url)).toBeNull();
    }
  });
});
