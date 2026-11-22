import { describe, expect, it } from "vitest";
import { toAttachmentInfos, toBody, toMessageValues } from "./graph-parse.js";

describe("toMessageValues", () => {
  it("Graph の message を DB の値に変換する", () => {
    const values = toMessageValues({
      id: "AAA",
      conversationId: "conv-1",
      internetMessageId: "<a@example.com>",
      subject: "こんにちは",
      from: { emailAddress: { name: "山田", address: "yamada@example.com" } },
      toRecipients: [
        { emailAddress: { name: "me@example.com", address: "me@example.com" } },
        { emailAddress: { name: "宛先なし" } },
      ],
      ccRecipients: [],
      bccRecipients: [],
      replyTo: [],
      sender: { emailAddress: { name: "秘書", address: "staff@example.com" } },
      sentDateTime: "2026-11-20T01:02:03Z",
      receivedDateTime: "2026-11-20T01:02:05Z",
      bodyPreview: "  本文の\r\n冒頭  ",
      hasAttachments: true,
      isRead: false,
      isDraft: false,
      flag: { flagStatus: "flagged" },
    });
    expect(values).toEqual({
      threadKey: "conv-1",
      messageIdHeader: "<a@example.com>",
      subject: "こんにちは",
      from: [{ name: "山田", address: "yamada@example.com" }],
      // 名前がアドレスと同じなら省き、アドレスの無い宛先は捨てる。
      to: [{ address: "me@example.com" }],
      cc: [],
      bcc: [],
      replyTo: [],
      sender: [{ name: "秘書", address: "staff@example.com" }],
      sentAt: new Date("2026-11-20T01:02:03Z"),
      receivedAt: new Date("2026-11-20T01:02:05Z"),
      snippet: "本文の 冒頭",
      hasAttachments: true,
      seen: false,
      draft: false,
      flagged: true,
    });
  });

  it("届かなかった項目は含めない (既存の値を上書きしない)", () => {
    expect(toMessageValues({ id: "AAA", isRead: true })).toEqual({
      seen: true,
    });
    expect(
      toMessageValues({ id: "AAA", flag: { flagStatus: "notFlagged" } }),
    ).toEqual({ flagged: false });
    expect(toMessageValues({ id: "AAA" })).toEqual({});
  });

  it("差出人の無い下書きや NUL 文字を扱える", () => {
    const values = toMessageValues({
      id: "AAA",
      subject: "a\u0000b",
      from: null,
      sentDateTime: null,
    });
    expect(values).toEqual({ subject: "ab", from: [], sentAt: null });
  });
});

describe("toBody", () => {
  it("種類に応じてテキストか HTML に振り分ける", () => {
    expect(toBody({ contentType: "html", content: "<p>a</p>" })).toEqual({
      bodyText: null,
      bodyHtml: "<p>a</p>",
    });
    expect(toBody({ contentType: "text", content: "a" })).toEqual({
      bodyText: "a",
      bodyHtml: null,
    });
    expect(toBody(null)).toEqual({ bodyText: null, bodyHtml: null });
  });
});

describe("toAttachmentInfos", () => {
  it("ファイル、埋め込み画像、添付されたメールを変換し、リンクは除く", () => {
    expect(
      toAttachmentInfos([
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          id: "AAA",
          name: "議題.pdf",
          contentType: "Application/PDF",
          size: 1234,
          isInline: false,
          contentId: null,
        },
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          id: "BBB",
          name: "image001.png",
          contentType: "image/png",
          size: 99,
          isInline: true,
          contentId: "image001.png@01DC",
        },
        {
          "@odata.type": "#microsoft.graph.itemAttachment",
          id: "CCC",
          name: "転送するメール",
          contentType: null,
          size: 5000,
        },
        {
          "@odata.type": "#microsoft.graph.referenceAttachment",
          id: "DDD",
          name: "OneDrive のファイル",
        },
      ]),
    ).toEqual([
      {
        partId: "AAA",
        filename: "議題.pdf",
        contentType: "application/pdf",
        size: 1234,
        contentId: null,
        inline: false,
      },
      {
        partId: "BBB",
        filename: "image001.png",
        contentType: "image/png",
        size: 99,
        contentId: "image001.png@01DC",
        inline: true,
      },
      {
        partId: "CCC",
        filename: "転送するメール.eml",
        contentType: "message/rfc822",
        size: 5000,
        contentId: null,
        inline: false,
      },
    ]);
  });
});
