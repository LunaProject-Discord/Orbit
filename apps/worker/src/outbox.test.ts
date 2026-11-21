import type { OutboxOperation, OutboxTarget } from "@mail/core";
import type { ImapFlow } from "imapflow";
import { describe, expect, it } from "vitest";
import { GraphClient } from "./graph-client.js";
import { buildPendingGuard } from "./outbox.js";
import { applyGraphOperation } from "./outbox-graph.js";
import { applyImapOperation } from "./outbox-imap.js";

function target(overrides: Partial<OutboxTarget> = {}): OutboxTarget {
  return {
    messageId: "m1",
    providerMessageId: null,
    mailboxId: "box1",
    mailboxPath: "INBOX",
    uid: "7",
    uidValidity: "100",
    ...overrides,
  };
}

describe("buildPendingGuard", () => {
  it("反映待ちの操作の対象を、種類ごとにまとめる", () => {
    const guard = buildPendingGuard([
      {
        kind: "set_flags",
        payload: {
          targets: [target({ messageId: "m1", providerMessageId: "g1" })],
          seen: true,
        },
      },
      {
        kind: "move",
        payload: {
          targets: [
            target({ messageId: "m2", uid: "8" }),
            target({ messageId: "m3", uid: null, providerMessageId: "g3" }),
          ],
        },
      },
      {
        kind: "delete",
        payload: { targets: [target({ mailboxId: "box2", uid: "9" })] },
      },
      { kind: "send", payload: {} },
    ]);
    expect([...guard.flagMessageIds]).toEqual(["m1"]);
    expect([...guard.flagProviderIds]).toEqual(["g1"]);
    expect([...guard.removedProviderIds]).toEqual(["g3"]);
    expect([...(guard.removedUids.get("box1") ?? [])]).toEqual([8]);
    expect([...(guard.removedUids.get("box2") ?? [])]).toEqual([9]);
  });
});

type ImapCall = [string, ...unknown[]];

function fakeImap(
  options: { uidValidity?: bigint; result?: boolean; openError?: Error } = {},
) {
  const calls: ImapCall[] = [];
  const result = options.result ?? true;
  const client = {
    mailbox: false as false | { path: string; uidValidity: bigint },
    async getMailboxLock(path: string) {
      if (options.openError) throw options.openError;
      calls.push(["lock", path]);
      client.mailbox = { path, uidValidity: options.uidValidity ?? 100n };
      return { release: () => calls.push(["release", path]) };
    },
    async messageFlagsAdd(range: string, flags: string[], opts: unknown) {
      calls.push(["add", range, flags, opts]);
      return result;
    },
    async messageFlagsRemove(range: string, flags: string[], opts: unknown) {
      calls.push(["remove", range, flags, opts]);
      return result;
    },
    async messageMove(range: string, destination: string, opts: unknown) {
      calls.push(["move", range, destination, opts]);
      return result ? { path: "INBOX", destination } : false;
    },
    async messageDelete(range: string, opts: unknown) {
      calls.push(["delete", range, opts]);
      return result;
    },
  };
  return { client: client as unknown as ImapFlow, calls };
}

describe("applyImapOperation", () => {
  it("既読とスターを UID 指定で反映する", async () => {
    const { client, calls } = fakeImap();
    const result = await applyImapOperation(client, {
      kind: "set_flags",
      payload: {
        targets: [target({ uid: "7" }), target({ messageId: "m2", uid: "9" })],
        seen: true,
        flagged: false,
      },
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      ["lock", "INBOX"],
      ["add", "7,9", ["\\Seen"], { uid: true }],
      ["remove", "7,9", ["\\Flagged"], { uid: true }],
      ["release", "INBOX"],
    ]);
  });

  it("フォルダごとに選択し直して移動する", async () => {
    const { client, calls } = fakeImap();
    const result = await applyImapOperation(client, {
      kind: "move",
      payload: {
        targets: [
          target(),
          target({ mailboxId: "box2", mailboxPath: "Lists", uid: "3" }),
        ],
        destination: { mailboxId: "box3", path: "Trash" },
      },
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      ["lock", "INBOX"],
      ["move", "7", "Trash", { uid: true }],
      ["release", "INBOX"],
      ["lock", "Lists"],
      ["move", "3", "Trash", { uid: true }],
      ["release", "Lists"],
    ]);
  });

  it("UIDVALIDITY が変わっていたら、何もせずに失敗にする", async () => {
    const { client, calls } = fakeImap({ uidValidity: 101n });
    const result = await applyImapOperation(client, {
      kind: "delete",
      payload: { targets: [target()] },
    });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([
      ["lock", "INBOX"],
      ["release", "INBOX"],
    ]);
  });

  it("サーバーに拒否されたら失敗にする", async () => {
    const { client } = fakeImap({ result: false });
    const result = await applyImapOperation(client, {
      kind: "delete",
      payload: { targets: [target()] },
    });
    expect(result.ok).toBe(false);
  });

  it("フォルダが無ければ失敗にし、接続の問題はそのまま投げる", async () => {
    const missing = Object.assign(new Error("no such mailbox"), {
      responseStatus: "NO",
    });
    const operation: OutboxOperation = {
      kind: "delete",
      payload: { targets: [target()] },
    };
    expect(
      (
        await applyImapOperation(
          fakeImap({ openError: missing }).client,
          operation,
        )
      ).ok,
    ).toBe(false);
    await expect(
      applyImapOperation(
        fakeImap({ openError: new Error("connection closed") }).client,
        operation,
      ),
    ).rejects.toThrow("connection closed");
  });
});

type GraphCall = { method: string; url: string; body: unknown };

function fakeGraph(respond: (call: GraphCall) => Response) {
  const calls: GraphCall[] = [];
  const client = new GraphClient({
    getToken: async () => "token",
    fetchFn: (async (url: unknown, init?: RequestInit) => {
      const call = {
        method: init?.method ?? "GET",
        url: String(url).replace("https://graph.microsoft.com/v1.0", ""),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return respond(call);
    }) as typeof fetch,
    sleep: async () => {},
  });
  return { client, calls };
}

const graphTargets = [
  target({ messageId: "m1", providerMessageId: "A/1=", uid: null }),
  target({ messageId: "m2", providerMessageId: "B2", uid: null }),
];

describe("applyGraphOperation", () => {
  it("既読とスターを PATCH で反映する", async () => {
    const { client, calls } = fakeGraph(() => Response.json({}));
    const result = await applyGraphOperation(client, {
      kind: "set_flags",
      payload: { targets: graphTargets, seen: false, flagged: true },
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        method: "PATCH",
        url: "/me/messages/A%2F1%3D",
        body: { isRead: false, flag: { flagStatus: "flagged" } },
      },
      {
        method: "PATCH",
        url: "/me/messages/B2",
        body: { isRead: false, flag: { flagStatus: "flagged" } },
      },
    ]);
  });

  it("移動と削除を反映する", async () => {
    const { client, calls } = fakeGraph((call) =>
      call.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({ id: "x" }, { status: 201 }),
    );
    await applyGraphOperation(client, {
      kind: "move",
      payload: {
        targets: [graphTargets[1] as OutboxTarget],
        destination: { mailboxId: "box3", path: "folder-id" },
      },
    });
    await applyGraphOperation(client, {
      kind: "delete",
      payload: { targets: [graphTargets[1] as OutboxTarget] },
    });
    expect(calls).toEqual([
      {
        method: "POST",
        url: "/me/messages/B2/move",
        body: { destinationId: "folder-id" },
      },
      { method: "DELETE", url: "/me/messages/B2", body: undefined },
    ]);
  });

  it("すでに無いメッセージは成功として扱う", async () => {
    const { client } = fakeGraph(() =>
      Response.json({ error: { code: "ErrorItemNotFound" } }, { status: 404 }),
    );
    const result = await applyGraphOperation(client, {
      kind: "delete",
      payload: { targets: graphTargets },
    });
    expect(result).toEqual({ ok: true });
  });

  it("権限が無いなどで拒否されたら失敗にする", async () => {
    const { client } = fakeGraph(() =>
      Response.json(
        { error: { code: "ErrorAccessDenied", message: "Access is denied." } },
        { status: 403 },
      ),
    );
    const result = await applyGraphOperation(client, {
      kind: "set_flags",
      payload: { targets: graphTargets, seen: true },
    });
    expect(result).toEqual({ ok: false, reason: "Access is denied." });
  });

  it("障害が続いたら、やり直せるよう例外にする", async () => {
    const { client } = fakeGraph(() => new Response(null, { status: 503 }));
    await expect(
      applyGraphOperation(client, {
        kind: "set_flags",
        payload: { targets: graphTargets, seen: true },
      }),
    ).rejects.toThrow();
  });
});
