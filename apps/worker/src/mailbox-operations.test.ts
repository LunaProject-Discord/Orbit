import type { MailboxOperation } from "@mail/core";
import type { ImapFlow } from "imapflow";
import { describe, expect, it } from "vitest";
import { type GraphClient, GraphError } from "./graph-client.js";
import {
  applyGraphMailboxOperation,
  applyImapMailboxOperation,
} from "./mailbox-operations.js";

const create: MailboxOperation = {
  kind: "mailbox_create",
  payload: {
    name: "請求書",
    parentPath: "案件",
    path: "案件/請求書",
    targets: [],
  },
};
const rename: MailboxOperation = {
  kind: "mailbox_rename",
  payload: {
    mailboxId: "m1",
    path: "案件",
    newPath: "仕事",
    name: "仕事",
    delimiter: "/",
    targets: [],
  },
};
const remove: MailboxOperation = {
  kind: "mailbox_delete",
  payload: { mailboxId: "m1", path: "案件", name: "案件", targets: [] },
};

function imap(selected: string | false, fail?: Error) {
  const calls: string[] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push(`${name} ${args.join(" → ")}`.trim());
      if (fail && name !== "close") throw fail;
    };
  const client = {
    mailbox: selected === false ? false : { path: selected },
    mailboxCreate: record("create"),
    mailboxRename: record("rename"),
    mailboxDelete: record("delete"),
    mailboxClose: record("close"),
  } as unknown as ImapFlow;
  return { client, calls };
}

describe("applyImapMailboxOperation", () => {
  it("作成、名前の変更、削除をパスで行う", async () => {
    const { client, calls } = imap("INBOX");
    for (const operation of [create, rename, remove]) {
      expect(await applyImapMailboxOperation(client, operation)).toEqual({
        ok: true,
      });
    }
    expect(calls).toEqual([
      "create 案件/請求書",
      "rename 案件 → 仕事",
      "delete 案件",
    ]);
  });

  it("対象を選択中なら、先に閉じる", async () => {
    const { client, calls } = imap("案件");
    await applyImapMailboxOperation(client, remove);
    expect(calls).toEqual(["close", "delete 案件"]);
  });

  it("サーバーに拒否されたら失敗として返し、接続の問題は投げる", async () => {
    const rejected = Object.assign(new Error("Command failed"), {
      responseStatus: "NO",
      responseText: "Mailbox already exists",
    });
    expect(
      await applyImapMailboxOperation(imap(false, rejected).client, rename),
    ).toEqual({ ok: false, reason: "Mailbox already exists" });
    await expect(
      applyImapMailboxOperation(
        imap(false, new Error("closed")).client,
        rename,
      ),
    ).rejects.toThrow("closed");
  });
});

function graph(fail?: Error) {
  const calls: unknown[][] = [];
  const client = {
    request: async (method: string, path: string, body?: unknown) => {
      calls.push(body === undefined ? [method, path] : [method, path, body]);
      if (fail) throw fail;
    },
  } as unknown as GraphClient;
  return { client, calls };
}

describe("applyGraphMailboxOperation", () => {
  it("親フォルダの下に作り、ID を指して名前の変更と削除を行う", async () => {
    const { client, calls } = graph();
    for (const operation of [create, rename, remove]) {
      expect(await applyGraphMailboxOperation(client, operation)).toEqual({
        ok: true,
      });
    }
    expect(calls).toEqual([
      [
        "POST",
        `/me/mailFolders/${encodeURIComponent("案件")}/childFolders`,
        { displayName: "請求書" },
      ],
      [
        "PATCH",
        `/me/mailFolders/${encodeURIComponent("案件")}`,
        { displayName: "仕事" },
      ],
      ["DELETE", `/me/mailFolders/${encodeURIComponent("案件")}`],
    ]);
  });

  it("最上位に作るときは mailFolders へ送る", async () => {
    const { client, calls } = graph();
    await applyGraphMailboxOperation(client, {
      kind: "mailbox_create",
      payload: { name: "新規", parentPath: null, path: "新規", targets: [] },
    });
    expect(calls).toEqual([
      ["POST", "/me/mailFolders", { displayName: "新規" }],
    ]);
  });

  it("すでに無いフォルダの削除は成功、拒否は失敗、制限はやり直しにする", async () => {
    const gone = new GraphError(404, "ErrorItemNotFound", "not found");
    expect(
      await applyGraphMailboxOperation(graph(gone).client, remove),
    ).toEqual({ ok: true });
    const exists = new GraphError(409, "ErrorFolderExists", "exists");
    expect(
      await applyGraphMailboxOperation(graph(exists).client, create),
    ).toEqual({ ok: false, reason: "exists" });
    const throttled = new GraphError(429, "TooManyRequests", "slow down");
    await expect(
      applyGraphMailboxOperation(graph(throttled).client, create),
    ).rejects.toBe(throttled);
  });
});
