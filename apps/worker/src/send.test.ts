import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachmentKey,
  type OutgoingMessage,
  readAttachmentMeta,
  sweepAttachments,
  writeAttachment,
} from "@mail/core";
import type { ImapFlow } from "imapflow";
import { describe, expect, it } from "vitest";
import { GraphClient } from "./graph-client.js";
import { buildMime, envelopeOf, missingAttachments } from "./mime.js";
import { applyImapOperation } from "./outbox-imap.js";
import { savesSentCopy } from "./send.js";
import { sendViaGraph } from "./send-graph.js";
import { classifySmtpError } from "./send-smtp.js";

const message: OutgoingMessage = {
  from: { name: "あおい", address: "me@example.com" },
  to: [{ name: "山田", address: "yamada@example.com" }],
  cc: [{ address: "cc@example.com" }],
  bcc: [{ address: "hidden@example.com" }],
  subject: "Re: 打ち合わせの件",
  text: "承知しました。\nよろしくお願いします。",
  messageId: "<0192f1c8-aaaa-7bbb-8ccc-000000000001@example.com>",
  date: "2026-11-21T11:00:00.000Z",
  inReplyTo: "<original@example.net>",
  references: ["<first@example.net>", "<original@example.net>"],
};

describe("buildMime", () => {
  it("返信のヘッダーと決めておいた Message-ID・日時を入れる", async () => {
    const mime = (await buildMime(message, { keepBcc: false })).toString();
    expect(mime).toContain(`Message-ID: ${message.messageId}`);
    expect(mime).toContain("Date: Sat, 21 Nov 2026 11:00:00 +0000");
    expect(mime).toContain("In-Reply-To: <original@example.net>");
    expect(mime).toContain(
      "References: <first@example.net> <original@example.net>",
    );
    expect(mime).toContain("To: =?UTF-8?B?5bGx55Sw?= <yamada@example.com>");
    expect(mime).toContain("Cc: cc@example.com");
  });

  it("SMTP で送る分には Bcc を残さず、控えには残す", async () => {
    const sent = (await buildMime(message, { keepBcc: false })).toString();
    const copy = (await buildMime(message, { keepBcc: true })).toString();
    expect(sent).not.toContain("hidden@example.com");
    expect(copy).toContain("Bcc: hidden@example.com");
  });

  it("封筒には Bcc も含め、重複は 1 件にまとめる", () => {
    expect(
      envelopeOf({
        ...message,
        cc: [{ address: "yamada@example.com" }, { address: "cc@example.com" }],
      }),
    ).toEqual({
      from: "me@example.com",
      to: ["yamada@example.com", "cc@example.com", "hidden@example.com"],
    });
  });
});

describe("添付ファイルと書式付きの本文", () => {
  it("HTML 版と添付ファイルを入れ、無くなった添付を見つける", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mail-attachments-"));
    const previous = process.env.ATTACHMENTS_DIR;
    process.env.ATTACHMENTS_DIR = dir;
    try {
      const userId = "0192f1c8-aaaa-7bbb-8ccc-0000000000aa";
      const stored = await writeAttachment(
        dir,
        userId,
        { filename: "../資料 1.pdf", contentType: "application/pdf; x=1" },
        new Blob(["PDF の中身"]).stream(),
        1024,
      );
      if (stored === "too_large") throw new Error("想定外");
      expect(stored).toMatchObject({
        filename: ".._資料 1.pdf",
        contentType: "application/pdf",
        size: 13,
      });
      const file = { ...stored, storageKey: attachmentKey(userId, stored.id) };
      const withFile = {
        ...message,
        html: "<div>承知<b>しました</b>。</div>",
        attachments: [file],
      };
      expect(await missingAttachments(withFile)).toEqual([]);
      const mime = (await buildMime(withFile, { keepBcc: false })).toString();
      expect(mime).toContain("multipart/mixed");
      expect(mime).toContain("multipart/alternative");
      expect(mime).toContain("Content-Type: text/html; charset=utf-8");
      expect(mime).toContain("Content-Type: application/pdf;");
      expect(mime).toContain(Buffer.from("PDF の中身").toString("base64"));

      // 上限を超える内容は受け取らず、途中まで書いたファイルも残さない。
      expect(
        await writeAttachment(
          dir,
          userId,
          { filename: "big.bin", contentType: "" },
          new Blob(["x".repeat(2000)]).stream(),
          1024,
        ),
      ).toBe("too_large");
      // 他人のものは見つからない扱いになる。
      expect(
        await readAttachmentMeta(
          dir,
          "0192f1c8-aaaa-7bbb-8ccc-0000000000bb",
          stored.id,
        ),
      ).toBeNull();
      expect(() => attachmentKey(userId, "../../etc/passwd")).toThrow();

      // 期限を過ぎたものだけが消える。
      expect(await sweepAttachments(dir, 60_000)).toBe(0);
      // 下書きに付いているファイルは、期限を過ぎても残す。
      expect(
        await sweepAttachments(
          dir,
          60_000,
          Date.now() + 120_000,
          new Set([attachmentKey(userId, stored.id)]),
        ),
      ).toBe(0);
      expect(await readAttachmentMeta(dir, userId, stored.id)).not.toBeNull();
      expect(await sweepAttachments(dir, 60_000, Date.now() + 120_000)).toBe(1);
      expect(await missingAttachments(withFile)).toEqual([".._資料 1.pdf"]);
    } finally {
      if (previous === undefined) delete process.env.ATTACHMENTS_DIR;
      else process.env.ATTACHMENTS_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("classifySmtpError", () => {
  const error = (fields: Record<string, unknown>) =>
    Object.assign(new Error("smtp error"), fields);

  it("接続や一時的な拒否はやり直す", () => {
    expect(
      classifySmtpError(error({ code: "ECONNECTION", command: "CONN" })).status,
    ).toBe("retry");
    expect(classifySmtpError(error({ code: "EDNS" })).status).toBe("retry");
    expect(
      classifySmtpError(
        error({ responseCode: 451, command: "RCPT TO", response: "451 later" }),
      ),
    ).toEqual({ status: "retry", reason: "451 later" });
  });

  it("認証の失敗と恒久的な拒否は、やり直さない", () => {
    expect(
      classifySmtpError(
        error({ code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" }),
      ).status,
    ).toBe("failed");
    expect(
      classifySmtpError(error({ responseCode: 550, command: "RCPT TO" }))
        .status,
    ).toBe("failed");
  });

  it("本文の送信中に切れたら、二重に送らないようやり直さない", () => {
    expect(
      classifySmtpError(error({ code: "ETIMEDOUT", command: "DATA" })).status,
    ).toBe("failed");
    expect(classifySmtpError(error({ code: "ESOCKET" })).status).toBe("failed");
  });
});

describe("sendViaGraph", () => {
  function setup(respond: () => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new GraphClient({
      getToken: async () => "token",
      fetchFn: (async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return respond();
      }) as typeof fetch,
      sleep: async () => {},
    });
    return { client, calls };
  }

  it("MIME を base64 にして sendMail へ送る", async () => {
    const { client, calls } = setup(() => new Response(null, { status: 202 }));
    expect(await sendViaGraph(client, message)).toEqual({ status: "sent" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://graph.microsoft.com/v1.0/me/sendMail");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("text/plain");
    const mime = Buffer.from(String(calls[0]?.init.body), "base64").toString();
    expect(mime).toContain(`Message-ID: ${message.messageId}`);
    // Graph は Bcc の宛先をヘッダーから読む。
    expect(mime).toContain("Bcc: hidden@example.com");
  });

  it("拒否されたら失敗、制限が続いたらやり直しにする", async () => {
    const rejected = setup(() =>
      Response.json(
        { error: { code: "ErrorInvalidRecipients", message: "bad recipient" } },
        { status: 400 },
      ),
    );
    expect((await sendViaGraph(rejected.client, message)).status).toBe(
      "failed",
    );
    const throttled = setup(() => new Response(null, { status: 429 }));
    expect((await sendViaGraph(throttled.client, message)).status).toBe(
      "retry",
    );
  });
});

describe("送信済みフォルダへの保存", () => {
  function fakeImap(options: { existing?: number[]; appendError?: Error }) {
    const calls: unknown[][] = [];
    const client = {
      async getMailboxLock(path: string) {
        calls.push(["lock", path]);
        return { release: () => calls.push(["release", path]) };
      },
      async search(query: unknown) {
        calls.push(["search", query]);
        return options.existing ?? [];
      },
      async append(path: string, raw: Buffer, flags: string[], date: Date) {
        calls.push(["append", path, flags, date.toISOString()]);
        if (options.appendError) throw options.appendError;
        expect(raw.toString()).toContain("Bcc: hidden@example.com");
        return { uid: 1 };
      },
    } as unknown as ImapFlow;
    return { client, calls };
  }
  const operation = {
    kind: "append" as const,
    payload: { message, mailboxPath: "Sent", targets: [] },
  };

  it("既読の印を付けて、送信した日時で保存する", async () => {
    const { client, calls } = fakeImap({});
    expect(await applyImapOperation(client, operation)).toEqual({ ok: true });
    expect(calls).toEqual([
      ["lock", "Sent"],
      ["search", { header: { "message-id": message.messageId } }],
      ["release", "Sent"],
      ["append", "Sent", ["\\Seen"], "2026-11-21T11:00:00.000Z"],
    ]);
  });

  it("同じ Message-ID のメールがあれば、二重に保存しない", async () => {
    const { client, calls } = fakeImap({ existing: [42] });
    expect(await applyImapOperation(client, operation)).toEqual({ ok: true });
    expect(calls.some((call) => call[0] === "append")).toBe(false);
  });

  it("拒否されたら失敗にし、接続の問題はそのまま投げる", async () => {
    const rejected = Object.assign(new Error("over quota"), {
      responseStatus: "NO",
    });
    expect(
      (
        await applyImapOperation(
          fakeImap({ appendError: rejected }).client,
          operation,
        )
      ).ok,
    ).toBe(false);
    await expect(
      applyImapOperation(
        fakeImap({ appendError: new Error("connection closed") }).client,
        operation,
      ),
    ).rejects.toThrow("connection closed");
  });
});

describe("savesSentCopy", () => {
  it("サーバーが自動で保存するプロバイダでは、控えを保存しない", () => {
    expect(savesSentCopy({ protocol: "imap", provider: "generic" })).toBe(true);
    expect(savesSentCopy({ protocol: "imap", provider: "icloud" })).toBe(true);
    expect(savesSentCopy({ protocol: "imap", provider: "gmail" })).toBe(false);
    expect(savesSentCopy({ protocol: "graph", provider: "microsoft" })).toBe(
      false,
    );
  });
});
