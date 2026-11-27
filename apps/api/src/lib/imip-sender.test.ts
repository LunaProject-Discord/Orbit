import { describe, expect, it } from "vitest";
import {
  pickImipSender,
  pickImipSenderForAddress,
  type SenderAccount,
} from "./imip-sender.js";

/** 送信できるアカウント (SMTP あり)。 */
const smtp = (id: string, email: string): SenderAccount => ({
  id,
  email,
  username: email,
  displayName: null,
  mailEnabled: true,
  protocol: "imap",
  smtpHost: "smtp.example.com",
  status: "active",
});
/** 受信専用 (SMTP なし)。 */
const receiveOnly = (id: string, email: string): SenderAccount => ({
  ...smtp(id, email),
  smtpHost: null,
});
/** カレンダーだけの CalDAV アカウント (メールを使わない)。 */
const davOnly = (id: string, email: string): SenderAccount => ({
  ...smtp(id, email),
  mailEnabled: false,
  smtpHost: null,
});

const local = { accountId: null, imipAccountId: null };

describe("pickImipSender (imip-design 4.2)", () => {
  it("1. 選んだ送信元が送信できればそれ。受信専用ならほかへ進まず receive_only", () => {
    const list = [smtp("a", "a@example.com"), smtp("b", "b@example.com")];
    expect(pickImipSender(list, { ...local, imipAccountId: "b" })).toEqual({
      sender: { accountId: "b", email: "b@example.com", displayName: null },
      blocked: null,
    });
    const blocked = [smtp("a", "a@example.com"), receiveOnly("r", "r@x.jp")];
    expect(pickImipSender(blocked, { ...local, imipAccountId: "r" })).toEqual({
      sender: null,
      blocked: "receive_only",
    });
    // 止めたアカウント (disabled) も送信できない。
    const disabled = [{ ...smtp("d", "d@x.jp"), status: "disabled" }];
    expect(
      pickImipSender(disabled, { ...local, imipAccountId: "d" }).blocked,
    ).toBe("receive_only");
  });

  it("2. カレンダーのアカウント自身が送信できればそれ (並び順より先)", () => {
    const list = [smtp("first", "first@x.jp"), smtp("own", "own@x.jp")];
    expect(
      pickImipSender(list, { accountId: "own", imipAccountId: null }).sender
        ?.accountId,
    ).toBe("own");
  });

  it("3. カレンダーのアカウントと同じアドレスの、送信できる別のアカウント", () => {
    const list = [
      smtp("first", "first@x.jp"),
      davOnly("dav", "me@x.jp"),
      smtp("mail", "ME@x.jp"),
    ];
    expect(
      pickImipSender(list, { accountId: "dav", imipAccountId: null }).sender
        ?.accountId,
    ).toBe("mail");
  });

  it("2・3 で当たるのが受信専用だけなら receive_only (黙って別のアドレスから送らない)", () => {
    const list = [smtp("first", "first@x.jp"), receiveOnly("own", "own@x.jp")];
    expect(
      pickImipSender(list, { accountId: "own", imipAccountId: null }),
    ).toEqual({ sender: null, blocked: "receive_only" });
  });

  it("4・5. メールを使わないカレンダーのアカウントなら、送信できるアカウントの並び順の先頭", () => {
    const list = [
      receiveOnly("r", "r@x.jp"),
      davOnly("dav", "dav@x.jp"),
      smtp("second", "second@x.jp"),
      smtp("third", "third@x.jp"),
    ];
    expect(
      pickImipSender(list, { accountId: "dav", imipAccountId: null }).sender
        ?.accountId,
    ).toBe("second");
    expect(pickImipSender(list, local).sender?.accountId).toBe("second");
    // Graph は SMTP が無くても送れる。
    const graph = [{ ...receiveOnly("g", "g@x.jp"), protocol: "graph" }];
    expect(pickImipSender(graph, local).sender?.accountId).toBe("g");
  });

  it("6. 送信できるアカウントが無ければ no_sender。選んだアカウントが消えていれば自動に戻る", () => {
    expect(pickImipSender([receiveOnly("r", "r@x.jp")], local)).toEqual({
      sender: null,
      blocked: "no_sender",
    });
    expect(pickImipSender([], local).blocked).toBe("no_sender");
    expect(
      pickImipSender([smtp("a", "a@x.jp")], {
        accountId: null,
        imipAccountId: "deleted",
      }).sender?.accountId,
    ).toBe("a");
  });
});

describe("pickImipSenderForAddress", () => {
  it("同じアドレス (大文字小文字を無視) の送信できるアカウント。imipAccountId → accountId → 並び順", () => {
    const list = [
      receiveOnly("r", "me@x.jp"),
      smtp("one", "me@x.jp"),
      smtp("two", "Me@X.jp"),
      smtp("other", "other@x.jp"),
    ];
    expect(pickImipSenderForAddress(list, "ME@x.jp")?.accountId).toBe("one");
    expect(
      pickImipSenderForAddress(list, "me@x.jp", {
        accountId: "two",
        imipAccountId: null,
      })?.accountId,
    ).toBe("two");
    expect(
      pickImipSenderForAddress(list, "me@x.jp", {
        accountId: "two",
        imipAccountId: "one",
      })?.accountId,
    ).toBe("one");
    expect(pickImipSenderForAddress(list, "nobody@x.jp")).toBeNull();
    expect(
      pickImipSenderForAddress([receiveOnly("r", "me@x.jp")], "me@x.jp"),
    ).toBeNull();
  });
});
