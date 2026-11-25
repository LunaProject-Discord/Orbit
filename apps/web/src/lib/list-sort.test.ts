import { describe, expect, it } from "vitest";
import type { MessageSummary } from "@/lib/api";
import {
  DEFAULT_SORT,
  isDefaultSort,
  sortComparator,
  sortText,
} from "@/lib/list-sort";

const row = (
  id: string,
  subject: string,
  receivedAt: string,
  from = "",
): MessageSummary => ({
  id,
  accountId: "account",
  mailboxId: "inbox",
  threadKey: id,
  subject,
  from: from ? [{ name: from, address: `${id}@example.com` }] : [],
  to: [],
  receivedAt,
  snippet: "",
  hasAttachments: false,
  seen: true,
  flagged: false,
  answered: false,
  threadCount: 1,
  threadMessageIds: [id],
});

const ids = (rows: MessageSummary[]) => rows.map((item) => item.id);

describe("sortText", () => {
  it("件名の先頭の返信・転送の印を除き、小文字にする", () => {
    const base = row("a", "", "2026-01-01T00:00:00.000Z");
    expect(sortText({ ...base, subject: "Re: Re: Hello" }, "subject")).toBe(
      "hello",
    );
    expect(sortText({ ...base, subject: "FWD[2]：資料" }, "subject")).toBe(
      "資料",
    );
    expect(sortText({ ...base, subject: "Reply all" }, "subject")).toBe(
      "reply all",
    );
  });

  it("差出人は名前、無ければアドレスで比べる", () => {
    const base = row("a", "", "2026-01-01T00:00:00.000Z");
    expect(
      sortText({ ...base, from: [{ name: " ", address: "Bob@x" }] }, "from"),
    ).toBe("bob@x");
    expect(sortText({ ...base, to: [] }, "to")).toBe("");
  });
});

describe("sortComparator", () => {
  const a = row("a", "Re: banana", "2026-01-03T00:00:00.000Z", "Zed");
  const b = row("b", "apple", "2026-01-01T00:00:00.000Z", "amy");
  const c = row("c", "banana", "2026-01-02T00:00:00.000Z", "Bob");

  it("標準は新しい順", () => {
    expect(isDefaultSort(DEFAULT_SORT)).toBe(true);
    expect(ids([b, c, a].sort(sortComparator(DEFAULT_SORT)))).toEqual([
      "a",
      "c",
      "b",
    ]);
    expect(
      ids([a, c, b].sort(sortComparator({ key: "date", order: "asc" }))),
    ).toEqual(["b", "c", "a"]);
  });

  it("件名の同じメールは、向きにかかわらず新しい順に並べる", () => {
    expect(
      ids([c, b, a].sort(sortComparator({ key: "subject", order: "asc" }))),
    ).toEqual(["b", "a", "c"]);
    expect(
      ids([c, b, a].sort(sortComparator({ key: "subject", order: "desc" }))),
    ).toEqual(["a", "c", "b"]);
  });

  it("差出人の名前は大文字と小文字を区別しない", () => {
    expect(
      ids([a, b, c].sort(sortComparator({ key: "from", order: "asc" }))),
    ).toEqual(["b", "c", "a"]);
  });
});
