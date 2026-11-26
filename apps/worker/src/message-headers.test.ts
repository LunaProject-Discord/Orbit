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
    expect(parseListHeaders(headers, [])).toMatchObject({
      listId: "news.example.com",
      listUnsubscribe: [
        "mailto:unsubscribe@example.com?subject=stop",
        "https://example.com/unsubscribe?id=1",
      ],
    });
  });

  it("ヘッダーが無ければ空にする", () => {
    expect(parseListHeaders(undefined, [])).toMatchObject({
      listId: null,
      listUnsubscribe: [],
    });
    expect(
      parseListHeaders(Buffer.from("References: <a@b>\r\n"), []),
    ).toMatchObject({
      listId: null,
      listUnsubscribe: [],
    });
  });

  it("山かっこの無い List-Id は、空白が無いときだけ使う", () => {
    expect(
      parseListHeaders(Buffer.from("List-ID: list.example.com\r\n"), []).listId,
    ).toBe("list.example.com");
    expect(
      parseListHeaders(Buffer.from("List-Id: Just a description\r\n"), [])
        .listId,
    ).toBeNull();
  });

  it("https と mailto 以外の URL、壊れた URL は捨てる", () => {
    const headers = Buffer.from(
      "List-Unsubscribe: <javascript:alert(1)>, <http://example.com/u>, <not a url>, <https://example.com/ok>\r\n",
    );
    expect(parseListHeaders(headers, []).listUnsubscribe).toEqual([
      "https://example.com/ok",
    ]);
  });

  it("折り返しで URL の途中に入った空白を取り除く", () => {
    const headers = Buffer.from(
      "List-Unsubscribe: <https://example.com/unsubscribe?token=abc\r\n def>\r\n",
    );
    expect(parseListHeaders(headers, []).listUnsubscribe).toEqual([
      "https://example.com/unsubscribe?token=abcdef",
    ]);
  });
});

describe("listInfoFromGraph", () => {
  it("名前の大文字小文字を区別せずに探す", () => {
    expect(
      listInfoFromGraph(
        [
          { name: "Received", value: "from x" },
          { name: "List-ID", value: "<team.example.com>" },
          { name: "list-unsubscribe", value: "<https://example.com/u>" },
        ],
        [],
      ),
    ).toMatchObject({
      listId: "team.example.com",
      listUnsubscribe: ["https://example.com/u"],
    });
    expect(listInfoFromGraph(null, [])).toMatchObject({
      listId: null,
      listUnsubscribe: [],
    });
  });
});

describe("認証結果", () => {
  const from = [{ name: "Example", address: "news@example.com" }];

  it("いちばん上の Authentication-Results を読む", () => {
    const headers = Buffer.from(
      [
        "Authentication-Results: mx.google.com;",
        "       dkim=pass header.i=@example.com header.s=s1;",
        "       spf=pass (google.com: domain of bounce@mail.example.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@mail.example.com;",
        "       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com",
        "Authentication-Results: forged.example; dmarc=fail header.from=example.com",
        "",
      ].join("\r\n"),
    );
    const info = parseListHeaders(headers, from);
    expect(info.authResults).toEqual({
      authservId: "mx.google.com",
      spf: { result: "pass", domain: "mail.example.com" },
      dkim: [{ result: "pass", domain: "example.com" }],
      dmarc: { result: "pass", domain: "example.com" },
      compauth: null,
    });
    expect(info.senderCheck).toEqual({
      verified: true,
      warnings: [],
      claimed: null,
    });
  });

  it("ARC-Authentication-Results は使わない", () => {
    const headers = Buffer.from(
      "ARC-Authentication-Results: i=1; mx.example; dmarc=pass header.from=example.com\r\n",
    );
    const info = parseListHeaders(headers, from);
    expect(info.authResults).toBeNull();
    expect(info.senderCheck.verified).toBe(false);
  });

  it("Graph のヘッダーからも読む", () => {
    const info = listInfoFromGraph(
      [
        {
          name: "Authentication-Results",
          value:
            "spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=example.com; dkim=pass (signature was verified) header.d=example.com;dmarc=fail action=quarantine header.from=example.com;compauth=fail reason=000",
        },
      ],
      from,
    );
    expect(info.authResults?.dmarc).toEqual({
      result: "fail",
      domain: "example.com",
    });
    expect(info.senderCheck.warnings).toEqual(["dmarc_fail"]);
  });
});
