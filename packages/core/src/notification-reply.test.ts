import { describe, expect, it } from "vitest";
import {
  buildNotificationReply,
  htmlToPlainText,
  type ReplySource,
  replyRecipients,
  stripActiveContent,
} from "./notification-reply.js";

const source: ReplySource = {
  from: [{ name: "山田", address: "yamada@example.com" }],
  to: [{ address: "me@example.jp" }],
  replyTo: [],
  subject: "打ち合わせ",
  bodyText: "明日はどうですか。\n\nよろしくお願いします。",
  bodyHtml: null,
  sentAt: new Date("2026-11-24T01:00:00Z"),
  receivedAt: new Date("2026-11-24T01:00:05Z"),
};

describe("replyRecipients", () => {
  it("返信先が無ければ差出人へ", () => {
    expect(replyRecipients(source, ["me@example.jp"])).toEqual(source.from);
  });

  it("返信先 (Reply-To) があればそちらへ", () => {
    const replyTo = [{ address: "list@example.com" }];
    expect(replyRecipients({ ...source, replyTo }, [])).toEqual(replyTo);
  });

  it("自分が送ったメールへの返信は、元の宛先へ", () => {
    expect(
      replyRecipients(
        {
          ...source,
          from: [{ address: "Me@Example.jp" }],
          to: [{ address: "friend@example.com" }],
        },
        ["me@example.jp"],
      ),
    ).toEqual([{ address: "friend@example.com" }]);
  });
});

describe("buildNotificationReply", () => {
  it("書いた文章、署名、引用の順に並べ、件名に Re: を付ける", () => {
    const reply = buildNotificationReply({
      source,
      ownAddresses: ["me@example.jp"],
      signatureHtml: "<div>-- <br>あおい</div>",
      text: "大丈夫です。\n<よろしく>",
    });
    expect(reply.to).toEqual(source.from);
    expect(reply.subject).toBe("Re: 打ち合わせ");
    expect(reply.text.split("\n")).toEqual([
      "大丈夫です。",
      "<よろしく>",
      "",
      "--",
      "あおい",
      "",
      expect.stringContaining("山田 <yamada@example.com>:"),
      "> 明日はどうですか。",
      ">",
      "> よろしくお願いします。",
    ]);
    expect(reply.html).toContain(
      "<div>大丈夫です。</div><div>&lt;よろしく&gt;</div>",
    );
    expect(reply.html).toContain(
      '<div data-signature=""><div>-- <br>あおい</div></div>',
    );
    expect(reply.html).toContain(
      "<blockquote><div>明日はどうですか。</div><div><br></div><div>よろしくお願いします。</div></blockquote>",
    );
  });

  it("件名にすでに Re: があれば付け足さない", () => {
    const reply = buildNotificationReply({
      source: { ...source, subject: "RE: 打ち合わせ" },
      ownAddresses: [],
      signatureHtml: null,
      text: "了解",
    });
    expect(reply.subject).toBe("RE: 打ち合わせ");
    expect(reply.html).not.toContain("data-signature");
  });

  it("テキストの本文が無ければ、HTML から引用を作る", () => {
    const reply = buildNotificationReply({
      source: {
        ...source,
        bodyText: null,
        bodyHtml: "<p>こんにちは&amp;<b>どうも</b></p><script>x()</script>",
      },
      ownAddresses: [],
      signatureHtml: null,
      text: "はい",
    });
    expect(reply.text).toContain("> こんにちは&どうも");
    expect(reply.text).not.toContain("x()");
    expect(reply.html).toContain("<div>こんにちは&amp;どうも</div>");
  });

  it("本文が無ければ引用しない", () => {
    const reply = buildNotificationReply({
      source: { ...source, bodyText: null, bodyHtml: null },
      ownAddresses: [],
      signatureHtml: null,
      text: "はい",
    });
    expect(reply.text).toBe("はい");
    expect(reply.html).toBe("<div>はい</div>");
  });
});

describe("htmlToPlainText", () => {
  it("改行とブロックを改行にし、文字参照を戻す", () => {
    expect(
      htmlToPlainText("<div>a<br>b</div><p>&lt;c&gt;&#x41;&#66;</p>"),
    ).toBe("a\nb\n<c>AB");
  });
});

describe("stripActiveContent", () => {
  it("スクリプトと on〜 属性、javascript: のリンクを除く", () => {
    expect(
      stripActiveContent(
        '<a href="javascript:alert(1)" onclick="x()">名前</a><script>y()</script><img src="a.png" onerror=z()>',
      ),
    ).toBe('<a href="#">名前</a><img src="a.png">');
  });
});
