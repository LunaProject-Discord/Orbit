import { describe, expect, it } from "vitest";
import type { MessageDetail } from "@/lib/api";
import {
  buildDraftFrom,
  formatAddressList,
  parseAddressList,
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

  it("formatAddressList の結果を読み戻せる", () => {
    const list = [
      { name: "Doe, John", address: "john@example.com" },
      { address: "b@example.com" },
    ];
    expect(parseAddressList(formatAddressList(list)).addresses).toEqual(list);
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
  bodyText: "明日の 10 時でいかがですか。\n> 前の引用",
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
      to: "山田 <yamada@example.com>",
      cc: "",
      subject: "Re: 打ち合わせの件",
    });
    expect(draft.text).toContain("山田 <yamada@example.com> のメッセージ:");
    expect(draft.text).toContain("> 明日の 10 時でいかがですか。\n>> 前の引用");
    expect(draft.text.startsWith("\n\n")).toBe(true);
  });

  it("全員に返信は、自分以外の宛先を Cc に入れる", () => {
    const draft = build("replyAll");
    expect(draft.to).toBe("山田 <yamada@example.com>");
    expect(draft.cc).toBe("sato@example.com, suzuki@example.com");
  });

  it("Reply-To があればそちらへ返信し、Re: は重ねない", () => {
    const draft = build("reply", {
      ...original,
      subject: "RE: 打ち合わせの件",
      replyTo: [{ address: "list@example.com" }],
    });
    expect(draft.to).toBe("list@example.com");
    expect(draft.subject).toBe("RE: 打ち合わせの件");
  });

  it("自分が送ったメールへの返信は、元の宛先へ送る", () => {
    const draft = build("replyAll", {
      ...original,
      from: [{ address: "me@example.com" }],
      to: [{ address: "yamada@example.com" }],
    });
    expect(draft.to).toBe("yamada@example.com");
    expect(draft.cc).toBe("suzuki@example.com");
  });

  it("転送は宛先を空にし、元のメールの情報を本文に入れる", () => {
    const draft = build("forward");
    expect(draft).toMatchObject({
      mode: "forward",
      to: "",
      subject: "Fwd: 打ち合わせの件",
    });
    expect(draft.text).toContain("---------- 転送メッセージ ----------");
    expect(draft.text).toContain("差出人: 山田 <yamada@example.com>");
    expect(draft.text).toContain("明日の 10 時でいかがですか。");
  });
});
