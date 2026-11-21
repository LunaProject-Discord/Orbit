import { beforeEach, describe, expect, it } from "vitest";
import type { MailboxSummary, MessageDetail, MessageSummary } from "@/lib/api";
import { MailCache } from "@/lib/offline/mail-cache";
import { MemoryStore } from "@/lib/offline/store";
import { emptyFilters } from "@/lib/search";

function mailbox(
  id: string,
  specialUse: MailboxSummary["specialUse"],
  accountId = "account",
): MailboxSummary {
  return {
    id,
    accountId,
    parentId: null,
    path: id,
    name: id,
    specialUse,
    sortOrder: null,
    lastSyncedAt: null,
    totalCount: 0,
    unreadCount: 0,
  };
}

function row(
  id: string,
  day: number,
  overrides: Partial<MessageSummary> = {},
): MessageSummary {
  return {
    id,
    accountId: "account",
    mailboxId: "inbox",
    threadKey: id,
    subject: `件名 ${id}`,
    from: [{ name: "佐藤 美咲", address: "sato@example.com" }],
    to: [{ address: "aoi@example.com" }],
    receivedAt: `2026-11-${String(day).padStart(2, "0")}T03:00:00.000Z`,
    snippet: "",
    hasAttachments: false,
    seen: false,
    flagged: false,
    answered: false,
    threadCount: 1,
    threadMessageIds: [id],
    ...overrides,
  };
}

function detail(
  id: string,
  day: number,
  overrides: Partial<MessageDetail> = {},
): MessageDetail {
  const base = row(id, day);
  return {
    id,
    accountId: base.accountId,
    threadKey: id,
    subject: base.subject,
    from: base.from,
    to: base.to,
    cc: [],
    bcc: [],
    replyTo: [],
    sentAt: null,
    receivedAt: base.receivedAt,
    snippet: "",
    size: 0,
    hasAttachments: false,
    bodyText: null,
    bodyHtml: null,
    bodyFetchedAt: base.receivedAt,
    seen: false,
    flagged: false,
    answered: false,
    draft: false,
    attachments: [],
    ...overrides,
  };
}

const inbox = { accountId: null, mailboxId: null };
const ids = (page: { messages: MessageSummary[] } | null) =>
  page?.messages.map((message) => message.id);

describe("MailCache の一覧", () => {
  let cache: MailCache;
  beforeEach(async () => {
    cache = new MailCache(new MemoryStore());
    await cache.saveMailboxes([
      mailbox("inbox", "inbox"),
      mailbox("inbox2", "inbox", "account2"),
      mailbox("trash", "trash"),
      mailbox("work", null),
    ]);
  });

  it("一度も保存していないフォルダは null を返す", async () => {
    expect(await cache.loadPage(inbox, null, 50)).toBeNull();
    await cache.savePage(inbox, null, { messages: [], nextCursor: null });
    expect(ids(await cache.loadPage(inbox, null, 50))).toEqual([]);
    expect(
      await cache.loadPage({ accountId: null, mailboxId: "work" }, null, 50),
    ).toBeNull();
  });

  it("新しい順に返し、続きは cursor で取得できる", async () => {
    await cache.savePage(inbox, null, {
      messages: [row("c", 3), row("b", 2), row("a", 1)],
      nextCursor: null,
    });
    const first = await cache.loadPage(inbox, null, 2);
    expect(ids(first)).toEqual(["c", "b"]);
    expect(first?.nextCursor).toBe("2026-11-02T03:00:00.000Z_b");
    const second = await cache.loadPage(inbox, first?.nextCursor ?? null, 2);
    expect(ids(second)).toEqual(["a"]);
    expect(second?.nextCursor).toBeNull();
  });

  it("すべての受信トレイは各アカウントの受信トレイをまとめ、アカウントで絞り込める", async () => {
    await cache.savePage(inbox, null, {
      messages: [
        row("b", 2, { accountId: "account2", mailboxId: "inbox2" }),
        row("a", 1),
      ],
      nextCursor: null,
    });
    await cache.savePage({ accountId: null, mailboxId: "work" }, null, {
      messages: [row("w", 5, { mailboxId: "work" })],
      nextCursor: null,
    });
    expect(ids(await cache.loadPage(inbox, null, 50))).toEqual(["b", "a"]);
    expect(
      ids(
        await cache.loadPage(
          { accountId: "account2", mailboxId: null },
          null,
          50,
        ),
      ),
    ).toEqual(["b"]);
  });

  it("取得し直したページの範囲から無くなった行は消し、範囲の外の行は残す", async () => {
    await cache.savePage(inbox, null, {
      messages: [row("d", 4), row("c", 3)],
      nextCursor: "2026-11-03T03:00:00.000Z_c",
    });
    await cache.savePage(inbox, "2026-11-03T03:00:00.000Z_c", {
      messages: [row("b", 2), row("a", 1)],
      nextCursor: null,
    });
    // 先頭ページを取得し直すと d が無くなり、新しい e が増えていた。
    await cache.savePage(inbox, null, {
      messages: [row("e", 5), row("c", 3)],
      nextCursor: "2026-11-03T03:00:00.000Z_c",
    });
    expect(ids(await cache.loadPage(inbox, null, 50))).toEqual([
      "e",
      "c",
      "b",
      "a",
    ]);
    // 続きが無いページを保存すると、それより古い行は無くなったものとして消す。
    await cache.savePage(inbox, null, {
      messages: [row("e", 5)],
      nextCursor: null,
    });
    expect(ids(await cache.loadPage(inbox, null, 50))).toEqual(["e"]);
  });

  it("アカウントを絞った一覧の保存で、他のアカウントの行は消さない", async () => {
    await cache.savePage(inbox, null, {
      messages: [
        row("b", 2, { accountId: "account2", mailboxId: "inbox2" }),
        row("a", 1),
      ],
      nextCursor: null,
    });
    await cache.savePage({ accountId: "account", mailboxId: null }, null, {
      messages: [],
      nextCursor: null,
    });
    expect(ids(await cache.loadPage(inbox, null, 50))).toEqual(["b"]);
  });

  it("無くなったフォルダの行は消す", async () => {
    const work = { accountId: null, mailboxId: "work" };
    await cache.savePage(work, null, {
      messages: [row("w", 5, { mailboxId: "work" })],
      nextCursor: null,
    });
    await cache.saveMailboxes([mailbox("inbox", "inbox")]);
    expect(await cache.loadPage(work, null, 50)).toBeNull();
  });
});

describe("MailCache の操作の反映", () => {
  it("既読を一覧、本文、会話に反映し、移動した行は一覧から消す", async () => {
    const cache = new MailCache(new MemoryStore());
    await cache.saveMailboxes([mailbox("inbox", "inbox")]);
    await cache.savePage(inbox, null, {
      messages: [row("b", 2), row("a", 1)],
      nextCursor: null,
    });
    await cache.saveDetail(detail("a", 1));
    await cache.saveThread("a", "inbox", [
      { ...detail("a", 1), mailboxIds: ["inbox"] },
    ]);

    await cache.applyAction({
      idempotencyKey: "1",
      messageIds: ["a"],
      action: "set_flags",
      seen: true,
    });
    const page = await cache.loadPage(inbox, null, 50);
    expect(page?.messages.map((message) => message.seen)).toEqual([
      false,
      true,
    ]);
    expect((await cache.loadDetail("a"))?.seen).toBe(true);
    expect((await cache.loadThread("a", "inbox"))?.[0]?.seen).toBe(true);

    await cache.applyAction({
      idempotencyKey: "2",
      messageIds: ["b"],
      action: "move",
      destination: "trash",
    });
    expect(ids(await cache.loadPage(inbox, null, 50))).toEqual(["a"]);
  });
});

describe("MailCache の会話", () => {
  it("会話を保存していなければ、一覧の行と本文から組み立てる", async () => {
    const cache = new MailCache(new MemoryStore());
    await cache.saveMailboxes([mailbox("inbox", "inbox")]);
    await cache.savePage(inbox, null, {
      messages: [row("b", 2, { threadCount: 2, threadMessageIds: ["b", "a"] })],
      nextCursor: null,
    });
    await cache.saveDetail(detail("a", 1, { subject: "最初のメール" }));
    const thread = await cache.loadThread("b", "inbox");
    expect(thread?.map((message) => message.id)).toEqual(["a", "b"]);
    expect(thread?.[0]?.subject).toBe("最初のメール");
    expect(await cache.loadThread("unknown", "inbox")).toBeNull();
  });
});

describe("MailCache の検索", () => {
  let cache: MailCache;
  const search = (text: string, extra: object = {}) =>
    cache.search({
      text,
      filters: emptyFilters,
      scope: "all",
      accountId: null,
      mailboxId: null,
      ...extra,
    });

  beforeEach(async () => {
    cache = new MailCache(new MemoryStore());
    await cache.saveMailboxes([
      mailbox("inbox", "inbox"),
      mailbox("trash", "trash"),
      mailbox("all", "all"),
    ]);
    await cache.savePage(inbox, null, {
      messages: [
        row("b", 2, { subject: "定例ミーティング", seen: true }),
        row("a", 1, { subject: "見積書の件", hasAttachments: true }),
      ],
      nextCursor: null,
    });
    await cache.savePage({ accountId: null, mailboxId: "trash" }, null, {
      messages: [
        row("t", 3, { mailboxId: "trash", subject: "定例 (削除済み)" }),
      ],
      nextCursor: null,
    });
    await cache.savePage({ accountId: null, mailboxId: "all" }, null, {
      messages: [row("a", 1, { mailboxId: "all", subject: "見積書の件" })],
      nextCursor: null,
    });
    await cache.saveDetail(
      detail("a", 1, {
        subject: "見積書の件",
        hasAttachments: true,
        bodyText: `${"あ".repeat(60)}合計は 120,000 円です。よろしくお願いします。`,
      }),
    );
  });

  it("件名と差出人から探し、ごみ箱は除く", async () => {
    expect(ids(await search("定例"))).toEqual(["b"]);
    expect(ids(await search("from:sato"))).toEqual(["b", "a"]);
    expect((await search("定例")).terms).toEqual(["定例"]);
  });

  it("保存してある本文からも探し、該当箇所を抜き出す", async () => {
    const page = await search("120,000");
    expect(ids(page)).toEqual(["a"]);
    expect(page.messages[0]?.excerpt).toContain("合計は 120,000 円");
    expect(page.messages[0]?.excerpt?.startsWith("…")).toBe(true);
  });

  it("複数のフォルダにあるメールは 1 回だけ返し、受信トレイを優先する", async () => {
    const page = await search("見積書");
    expect(ids(page)).toEqual(["a"]);
    expect(page.messages[0]?.mailboxId).toBe("inbox");
  });

  it("状態と絞り込みの条件で絞り込む", async () => {
    expect(ids(await search("is:unread"))).toEqual(["a"]);
    expect(ids(await search("has:attachment"))).toEqual(["a"]);
    expect(ids(await search("-定例"))).toEqual(["a"]);
    expect(
      ids(await search("", { filters: { ...emptyFilters, subject: "定例" } })),
    ).toEqual(["b"]);
    expect(ids(await search(""))).toEqual([]);
  });

  it("フォルダを指定すると、そのフォルダだけを探す", async () => {
    expect(
      ids(await search("定例", { scope: "folder", mailboxId: "trash" })),
    ).toEqual(["t"]);
  });
});

describe("MailCache の整理", () => {
  it("本文が上限を超えたら、受信が古いものから消す", async () => {
    const cache = new MailCache(new MemoryStore());
    await cache.saveDetail(detail("a", 1));
    await cache.saveDetail(detail("b", 2));
    await cache.saveDetail(detail("c", 3));
    await cache.prune(2);
    expect([...(await cache.detailIds())].sort()).toEqual(["b", "c"]);
  });
});
