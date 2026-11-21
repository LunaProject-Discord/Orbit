import type { MessageStructureObject } from "imapflow";
import { describe, expect, it } from "vitest";
import {
  analyzeStructure,
  flagsOf,
  htmlToText,
  makeSnippet,
  parseReferences,
  threadKeyOf,
  toAddresses,
  toSpecialUse,
} from "./message-parse.js";

describe("analyzeStructure", () => {
  it("単一パートのメールは part 1 を本文にする", () => {
    expect(analyzeStructure({ type: "text/plain" })).toEqual({
      textPart: "1",
      htmlPart: null,
      attachments: [],
    });
  });

  it("alternative の本文と添付、インライン画像を分ける", () => {
    const structure: MessageStructureObject = {
      type: "multipart/mixed",
      childNodes: [
        {
          part: "1",
          type: "multipart/related",
          childNodes: [
            {
              part: "1.1",
              type: "multipart/alternative",
              childNodes: [
                { part: "1.1.1", type: "text/plain" },
                { part: "1.1.2", type: "text/html" },
              ],
            },
            {
              part: "1.2",
              type: "image/png",
              id: "<logo@example>",
              size: 1200,
            },
          ],
        },
        {
          part: "2",
          type: "application/pdf",
          disposition: "attachment",
          dispositionParameters: { filename: "請求書.pdf" },
          size: 34567,
        },
        {
          part: "3",
          type: "text/plain",
          disposition: "attachment",
          dispositionParameters: { filename: "memo.txt" },
        },
      ],
    };
    expect(analyzeStructure(structure)).toEqual({
      textPart: "1.1.1",
      htmlPart: "1.1.2",
      attachments: [
        {
          partId: "1.2",
          filename: null,
          contentType: "image/png",
          size: 1200,
          contentId: "<logo@example>",
          inline: true,
        },
        {
          partId: "2",
          filename: "請求書.pdf",
          contentType: "application/pdf",
          size: 34567,
          contentId: null,
          inline: false,
        },
        {
          partId: "3",
          filename: "memo.txt",
          contentType: "text/plain",
          size: 0,
          contentId: null,
          inline: false,
        },
      ],
    });
  });
});

describe("ヘッダーの解析", () => {
  it("折り返された References を読む", () => {
    const headers = Buffer.from(
      "References: <a@example.com>\r\n <b@example.com>\r\n\t<c@example.com>\r\n\r\n",
    );
    expect(parseReferences(headers)).toEqual([
      "<a@example.com>",
      "<b@example.com>",
      "<c@example.com>",
    ]);
    expect(parseReferences(Buffer.from("\r\n"))).toEqual([]);
    expect(parseReferences(undefined)).toEqual([]);
  });

  it("スレッドのキーは会話の起点を優先する", () => {
    expect(
      threadKeyOf({
        references: ["<root@x>", "<mid@x>"],
        inReplyTo: "<mid@x>",
        messageId: "<me@x>",
        fallback: "f",
      }),
    ).toBe("<root@x>");
    expect(
      threadKeyOf({ references: [], messageId: "<me@x>", fallback: "f" }),
    ).toBe("<me@x>");
    expect(threadKeyOf({ references: [], fallback: "f" })).toBe("f");
  });

  it("アドレスの無い要素を除く", () => {
    expect(
      toAddresses([
        { name: "あおい", address: "aoi@example.com" },
        { name: "undisclosed-recipients" },
        { address: "b@example.com" },
      ]),
    ).toEqual([
      { name: "あおい", address: "aoi@example.com" },
      { address: "b@example.com" },
    ]);
  });
});

describe("抜粋", () => {
  it("テキスト本文の空白をまとめる", () => {
    expect(makeSnippet("こんにちは\r\n\r\n  本文です。 ", null)).toBe(
      "こんにちは 本文です。",
    );
  });

  it("HTML しか無い場合はタグを除く", () => {
    const html =
      "<html><head><style>p{color:red}</style></head><body><p>A &amp; B&nbsp;&#12354;</p><script>x()</script></body></html>";
    expect(htmlToText(html).replace(/\s+/g, " ").trim()).toBe("A & B あ");
    expect(makeSnippet("  ", html)).toBe("A & B あ");
  });

  it("200 文字で切り、絵文字を壊さない", () => {
    const snippet = makeSnippet("😀".repeat(300), null);
    expect(Array.from(snippet)).toHaveLength(200);
    expect(snippet.endsWith("😀")).toBe(true);
  });
});

describe("フラグとフォルダ種別", () => {
  it("IMAP のフラグを真偽値にする", () => {
    expect(flagsOf(new Set(["\\Seen", "\\Flagged", "$Forwarded"]))).toEqual({
      seen: true,
      flagged: true,
      answered: false,
      draft: false,
    });
  });

  it("SPECIAL-USE を列挙値にする", () => {
    expect(toSpecialUse("\\Inbox")).toBe("inbox");
    expect(toSpecialUse("\\Sent")).toBe("sent");
    expect(toSpecialUse("\\Unknown")).toBeNull();
    expect(toSpecialUse(undefined)).toBeNull();
  });
});
