// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { MessageDetail } from "@/lib/api";
import {
  buildDraftFrom,
  htmlToText,
  parseAddressList,
  resolveRecipients,
  sanitizeHtml,
} from "@/lib/compose";

describe("parseAddressList", () => {
  it("名前付きとアドレスだけの宛先を読み取る", () => {
    expect(
      parseAddressList(
        '山田 太郎 <yamada@example.com>, b@example.com; "Doe, John" <john@example.com>',
      ),
    ).toEqual({
      addresses: [
        { name: "山田 太郎", address: "yamada@example.com" },
        { address: "b@example.com" },
        { name: "Doe, John", address: "john@example.com" },
      ],
      invalid: [],
    });
  });

  it("読み取れないものを invalid に入れ、重複は 1 件にする", () => {
    expect(parseAddressList("a@example.com, 山田, A@example.com,")).toEqual({
      addresses: [{ address: "a@example.com" }],
      invalid: ["山田"],
    });
    expect(parseAddressList("  ")).toEqual({ addresses: [], invalid: [] });
  });
});

describe("resolveRecipients", () => {
  it("入力途中の文字列も宛先として確定し、重複は足さない", () => {
    expect(
      resolveRecipients({
        list: [{ address: "a@example.com" }],
        text: "A@example.com, b@example.com, だれか",
      }),
    ).toEqual({
      addresses: [{ address: "a@example.com" }, { address: "b@example.com" }],
      invalid: ["だれか"],
    });
  });
});

const original: MessageDetail = {
  id: "m1",
  accountId: "acc1",
  threadKey: "t1",
  subject: "打ち合わせの件",
  from: [{ name: "山田", address: "yamada@example.com" }],
  to: [{ address: "me@example.com" }, { address: "sato@example.com" }],
  cc: [{ address: "suzuki@example.com" }],
  bcc: [],
  replyTo: [],
  sentAt: "2026-11-20T01:00:00.000Z",
  receivedAt: "2026-11-20T01:00:05.000Z",
  snippet: "",
  size: 0,
  hasAttachments: false,
  bodyText: "明日の 10 時でいかがですか。\n\n<b>念のため</b>\n> 前の引用",
  bodyHtml: null,
  bodyFetchedAt: "2026-11-20T01:00:06.000Z",
  seen: true,
  flagged: false,
  answered: false,
  draft: false,
  attachments: [],
};
const accounts = [{ id: "acc1", email: "Me@example.com" }];
const build = (
  mode: "reply" | "replyAll" | "forward",
  message: MessageDetail = original,
) => buildDraftFrom(mode, message, message.bodyText ?? "", accounts);

describe("buildDraftFrom", () => {
  it("返信は差出人だけに宛て、本文を引用する", () => {
    const draft = build("reply");
    expect(draft).toMatchObject({
      accountId: "acc1",
      mode: "reply",
      sourceMessageId: "m1",
      to: { list: [{ name: "山田", address: "yamada@example.com" }], text: "" },
      cc: { list: [], text: "" },
      subject: "Re: 打ち合わせの件",
    });
    // 先頭に書き始めるための空行があり、元の本文は引用として入る。
    expect(
      draft.html.startsWith("<div><br></div><div><br></div><blockquote>"),
    ).toBe(true);
    // 元の本文にあったタグは、文字としてそのまま出る。
    expect(draft.html).toContain("&lt;b&gt;念のため&lt;/b&gt;");
    const text = htmlToText(sanitizeHtml(draft.html));
    expect(text).toContain(
      "> 明日の 10 時でいかがですか。\n>\n> <b>念のため</b>\n>> 前の引用",
    );
    expect(text).toMatch(/^> .*山田 <yamada@example\.com>:$/m);
  });

  it("全員に返信は、自分以外の宛先を Cc に入れる", () => {
    const draft = build("replyAll");
    expect(draft.to.list).toEqual([
      { name: "山田", address: "yamada@example.com" },
    ]);
    expect(draft.cc.list).toEqual([
      { address: "sato@example.com" },
      { address: "suzuki@example.com" },
    ]);
  });

  it("Reply-To があればそちらへ返信し、Re: は重ねない", () => {
    const draft = build("reply", {
      ...original,
      subject: "RE: 打ち合わせの件",
      replyTo: [{ address: "list@example.com" }],
    });
    expect(draft.to.list).toEqual([{ address: "list@example.com" }]);
    expect(draft.subject).toBe("RE: 打ち合わせの件");
  });

  it("自分が送ったメールへの返信は、元の宛先へ送る", () => {
    const draft = build("replyAll", {
      ...original,
      from: [{ address: "me@example.com" }],
      to: [{ address: "yamada@example.com" }],
    });
    expect(draft.to.list).toEqual([{ address: "yamada@example.com" }]);
    expect(draft.cc.list).toEqual([{ address: "suzuki@example.com" }]);
  });

  it("転送は宛先を空にし、元のメールの情報を本文に入れる", () => {
    const draft = build("forward");
    expect(draft).toMatchObject({
      mode: "forward",
      to: { list: [], text: "" },
      subject: "Fwd: 打ち合わせの件",
    });
    const text = htmlToText(draft.html);
    expect(text).toContain("---------- 転送メッセージ ----------");
    expect(text).toContain("差出人: 山田 <yamada@example.com>");
    expect(text).toContain("明日の 10 時でいかがですか。\n\n<b>念のため</b>");
  });
});

describe("sanitizeHtml", () => {
  it("許可した書式だけを残し、スクリプトや属性は落とす", () => {
    expect(
      sanitizeHtml(
        '<div onclick="x()">こんにちは <b style="color:red">太字</b><script>alert(1)</script><img src=x onerror=1></div>' +
          '<a href="javascript:alert(1)">危険</a><a href="https://example.com/?a=1&b=2" target="_blank">安全</a>' +
          "<font color=red><i>斜体</i></font>",
      ),
    ).toBe(
      "<div>こんにちは <b>太字</b></div>危険" +
        '<a href="https://example.com/?a=1&amp;b=2">安全</a><i>斜体</i>',
    );
  });

  it("引用には、相手のメールソフトでも分かる見た目を付ける", () => {
    expect(sanitizeHtml("<blockquote>引用</blockquote>")).toMatch(
      /^<blockquote style="[^"]*border-left[^"]*">引用<\/blockquote>$/,
    );
  });
});

describe("htmlToText", () => {
  it("行、空行、箇条書き、リンク、引用をテキストにする", () => {
    expect(
      htmlToText(
        "<div>佐藤さん</div><div><br></div><div>お世話に<b>なって</b>おります。<br>2 行目</div>" +
          '<ul><li>一つ目</li><li>二つ目</li></ul><div><a href="https://example.com">資料</a> と <a href="https://example.org">https://example.org</a></div>' +
          "<blockquote><div>元の本文</div><blockquote>さらに前</blockquote></blockquote>",
      ),
    ).toBe(
      [
        "佐藤さん",
        "",
        "お世話になっております。",
        "2 行目",
        "- 一つ目",
        "- 二つ目",
        "資料 (https://example.com) と https://example.org",
        "> 元の本文",
        ">> さらに前",
      ].join("\n"),
    );
  });
});
