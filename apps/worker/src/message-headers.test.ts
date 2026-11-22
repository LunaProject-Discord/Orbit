import { describe, expect, it } from "vitest";
import { listInfoFromGraph, parseListHeaders } from "./message-headers.js";

describe("parseListHeaders", () => {
  it("List-Id の山かっこの中と、配信停止の URL を取り出す", () => {
    const headers = Buffer.from(
      [
        "References: <a@example.com>",
        "List-Id: Example News <news.example.com>",
        "List-Unsubscribe: <mailto:unsubscribe@example.com?subject=stop>,",
        " <https://example.com/unsubscribe?id=1>",
        "",
      ].join("\r\n"),
    );
    expect(parseListHeaders(headers)).toEqual({
      listId: "news.example.com",
      listUnsubscribe: [
        "mailto:unsubscribe@example.com?subject=stop",
        "https://example.com/unsubscribe?id=1",
      ],
    });
  });

  it("ヘッダーが無ければ空にする", () => {
    expect(parseListHeaders(undefined)).toEqual({
      listId: null,
      listUnsubscribe: [],
    });
    expect(parseListHeaders(Buffer.from("References: <a@b>\r\n"))).toEqual({
      listId: null,
      listUnsubscribe: [],
    });
  });

  it("山かっこの無い List-Id は、空白が無いときだけ使う", () => {
    expect(
      parseListHeaders(Buffer.from("List-ID: list.example.com\r\n")).listId,
    ).toBe("list.example.com");
    expect(
      parseListHeaders(Buffer.from("List-Id: Just a description\r\n")).listId,
    ).toBeNull();
  });

  it("https と mailto 以外の URL、壊れた URL は捨てる", () => {
    const headers = Buffer.from(
      "List-Unsubscribe: <javascript:alert(1)>, <http://example.com/u>, <not a url>, <https://example.com/ok>\r\n",
    );
    expect(parseListHeaders(headers).listUnsubscribe).toEqual([
      "https://example.com/ok",
    ]);
  });

  it("折り返しで URL の途中に入った空白を取り除く", () => {
    const headers = Buffer.from(
      "List-Unsubscribe: <https://example.com/unsubscribe?token=abc\r\n def>\r\n",
    );
    expect(parseListHeaders(headers).listUnsubscribe).toEqual([
      "https://example.com/unsubscribe?token=abcdef",
    ]);
  });
});

describe("listInfoFromGraph", () => {
  it("名前の大文字小文字を区別せずに探す", () => {
    expect(
      listInfoFromGraph([
        { name: "Received", value: "from x" },
        { name: "List-ID", value: "<team.example.com>" },
        { name: "list-unsubscribe", value: "<https://example.com/u>" },
      ]),
    ).toEqual({
      listId: "team.example.com",
      listUnsubscribe: ["https://example.com/u"],
    });
    expect(listInfoFromGraph(null)).toEqual({
      listId: null,
      listUnsubscribe: [],
    });
  });
});
