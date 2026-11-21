import type { ImapFlow } from "imapflow";
import { describe, expect, it } from "vitest";
import { graphDraftRemote } from "./draft-graph.js";
import { imapDraftRemote } from "./draft-imap.js";
import {
  DRAFT_SETTLE_MS,
  DraftRejected,
  type DraftRemote,
  type DraftRemoteRef,
  type DraftRow,
  type DraftStore,
  draftMessageId,
  processDrafts,
} from "./draft-sync.js";
import { GraphClient } from "./graph-client.js";

const account = { email: "me@example.com", displayName: "あおい" };
const now = Date.parse("2026-11-21T12:00:00Z");

function draft(overrides: Partial<DraftRow> = {}): DraftRow {
  return {
    id: "0192f1c8-aaaa-7bbb-8ccc-000000000001",
    userId: "0192f1c8-0000-7000-8000-000000000001",
    accountId: "0192f1c8-0000-7000-8000-0000000000aa",
    to: { list: [{ address: "yamada@example.com" }], text: "" },
    cc: { list: [], text: "" },
    bcc: { list: [], text: "" },
    subject: "打ち合わせ",
    html: "<div>こんにちは</div>",
    text: "こんにちは",
    attachments: [],
    mode: "new",
    sourceMessageId: null,
    revision: 3,
    syncedRevision: null,
    remoteMessageId: null,
    remoteMailboxPath: null,
    remoteUid: null,
    remoteUidValidity: null,
    remoteProviderId: null,
    createdAt: new Date(now - 600_000),
    updatedAt: new Date(now - 60_000),
    ...overrides,
  };
}

const imapRef = (uid: bigint): DraftRemoteRef => ({
  messageId: "<draft@example.com>",
  mailboxPath: "Drafts",
  uid,
  uidValidity: 100n,
  providerId: null,
});

function setup(
  rows: DraftRow[],
  options: { kept?: boolean; save?: DraftRemote["save"] } = {},
) {
  const calls: unknown[][] = [];
  const store: DraftStore = {
    loadUnsynced: async () => rows,
    recordSynced: async (id, revision, ref) => {
      calls.push(["record", id, revision, ref?.uid ?? ref?.providerId ?? null]);
      return options.kept ?? true;
    },
  };
  const remote: DraftRemote = {
    save:
      options.save ??
      (async (message, previous) => {
        calls.push(["save", message.subject, previous?.uid ?? null]);
        return imapRef(8n);
      }),
    remove: async (ref) => {
      calls.push(["remove", ref.uid]);
    },
  };
  const logs: string[] = [];
  const run = () =>
    processDrafts(store, account, remote, (line) => logs.push(line), now);
  return { run, calls, logs };
}

describe("processDrafts", () => {
  it("書く手が止まった下書きを置き、置いた場所を記録する", async () => {
    const { run, calls } = setup([draft()]);
    expect(await run()).toEqual({ saved: 1, nextDueAt: null });
    expect(calls).toEqual([
      ["save", "打ち合わせ", null],
      ["record", draft().id, 3, 8n],
    ]);
  });

  it("書いている途中の下書きは置かず、次に確認する時刻を返す", async () => {
    const updatedAt = new Date(now - 5_000);
    const { run, calls } = setup([draft({ updatedAt })]);
    expect(await run()).toEqual({
      saved: 0,
      nextDueAt: updatedAt.getTime() + DRAFT_SETTLE_MS,
    });
    expect(calls).toEqual([]);
  });

  it("置き直したら、記録してから前の控えを消す", async () => {
    const { run, calls } = setup([
      draft({
        syncedRevision: 2,
        remoteMailboxPath: "Drafts",
        remoteUid: 7n,
        remoteUidValidity: 100n,
      }),
    ]);
    await run();
    expect(calls).toEqual([
      ["save", "打ち合わせ", 7n],
      ["record", draft().id, 3, 8n],
      ["remove", 7n],
    ]);
  });

  it("同じ場所を書き換える方式 (Graph) では、控えを消さない", async () => {
    const ref: DraftRemoteRef = {
      messageId: null,
      mailboxPath: null,
      uid: null,
      uidValidity: null,
      providerId: "g1",
    };
    const { run, calls } = setup(
      [draft({ syncedRevision: 2, remoteProviderId: "g1" })],
      { save: async () => ref },
    );
    await run();
    expect(calls).toEqual([["record", draft().id, 3, "g1"]]);
  });

  it("置いている間に送信・破棄されていたら、置いたばかりの控えを消す", async () => {
    const { run, calls } = setup(
      [draft({ remoteMailboxPath: "Drafts", remoteUid: 7n })],
      { kept: false },
    );
    expect((await run()).saved).toBe(0);
    expect(calls.at(-1)).toEqual(["remove", 8n]);
  });

  it("拒否されたら、内容が変わるまでやり直さない。接続の問題はそのまま投げる", async () => {
    const rejected = setup([draft()], {
      save: async () => {
        throw new DraftRejected("容量が足りません");
      },
    });
    expect((await rejected.run()).saved).toBe(0);
    expect(rejected.calls).toEqual([["record", draft().id, 3, null]]);
    expect(rejected.logs[0]).toContain("容量が足りません");

    const broken = setup([draft()], {
      save: async () => {
        throw new Error("connection closed");
      },
    });
    await expect(broken.run()).rejects.toThrow("connection closed");
    expect(broken.calls).toEqual([]);
  });

  it("下書きフォルダが無ければ、置かずに済ませる", async () => {
    const { run, calls } = setup([draft()], { save: async () => null });
    expect((await run()).saved).toBe(0);
    expect(calls).toEqual([["record", draft().id, 3, null]]);
  });
});

describe("imapDraftRemote", () => {
  const message = {
    from: { address: "me@example.com" },
    to: [{ address: "yamada@example.com" }],
    cc: [],
    bcc: [],
    subject: "打ち合わせ",
    text: "こんにちは",
    messageId: draftMessageId("d1", "me@example.com"),
    date: "2026-11-21T11:00:00.000Z",
    inReplyTo: null,
    references: [],
  };

  function fakeImap(appended: unknown, found: number[] = []) {
    const calls: unknown[][] = [];
    const client = {
      mailbox: { uidValidity: 100n },
      async getMailboxLock(path: string) {
        calls.push(["lock", path]);
        return { release: () => calls.push(["release", path]) };
      },
      async append(path: string, raw: Buffer, flags: string[]) {
        calls.push(["append", path, flags]);
        expect(raw.toString()).toContain("Message-ID: <draft.d1@example.com>");
        return appended;
      },
      async search(query: unknown) {
        calls.push(["search", query]);
        return found;
      },
      async messageDelete(range: string, options: unknown) {
        calls.push(["delete", range, options]);
        return true;
      },
    } as unknown as ImapFlow;
    return { client, calls };
  }

  it("下書きの印を付けて追加し、サーバーが返した場所を使う", async () => {
    const { client, calls } = fakeImap({ uid: 12, uidValidity: 100n });
    const remote = imapDraftRemote(client, async () => "Drafts");
    expect(await remote.save(message, null)).toEqual({
      messageId: "<draft.d1@example.com>",
      mailboxPath: "Drafts",
      uid: 12n,
      uidValidity: 100n,
      providerId: null,
    });
    expect(calls).toEqual([["append", "Drafts", ["\\Draft", "\\Seen"]]]);
  });

  it("場所を返さないサーバーでは、Message-ID で探していちばん新しいものを選ぶ", async () => {
    const { client } = fakeImap({ destination: "Drafts" }, [7, 12]);
    const remote = imapDraftRemote(client, async () => "Drafts");
    expect((await remote.save(message, null))?.uid).toBe(12n);
  });

  it("下書きフォルダが無ければ置かない", async () => {
    const { client, calls } = fakeImap({ uid: 1, uidValidity: 100n });
    const remote = imapDraftRemote(client, async () => null);
    expect(await remote.save(message, null)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("前の控えを UID で消す。フォルダが作り直されていたら消さない", async () => {
    const { client, calls } = fakeImap(null);
    const remote = imapDraftRemote(client, async () => "Drafts");
    await remote.remove(imapRef(7n));
    expect(calls).toContainEqual(["delete", "7", { uid: true }]);
    calls.length = 0;
    await remote.remove({ ...imapRef(7n), uidValidity: 99n });
    expect(calls.some((call) => call[0] === "delete")).toBe(false);
  });
});

describe("graphDraftRemote", () => {
  const message = {
    from: { address: "me@example.com" },
    to: [{ name: "山田", address: "yamada@example.com" }],
    cc: [],
    bcc: [],
    subject: "打ち合わせ",
    text: "こんにちは",
    html: "<div>こんにちは</div>",
    messageId: draftMessageId("d1", "me@example.com"),
    date: "2026-11-21T11:00:00.000Z",
    inReplyTo: null,
    references: [],
  };

  function fakeGraph(
    respond: (method: string, path: string) => Response | undefined,
  ) {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const client = new GraphClient({
      getToken: async () => "token",
      sleep: async () => {},
      fetchFn: (async (url: string, init: RequestInit) => {
        const path = url.replace("https://graph.microsoft.com/v1.0", "");
        const method = init.method ?? "GET";
        calls.push({
          method,
          path,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        return (
          respond(method, path) ??
          new Response(JSON.stringify({ value: [] }), { status: 200 })
        );
      }) as unknown as typeof fetch,
    });
    return { remote: graphDraftRemote(client), calls };
  }

  it("初めての下書きは作り、返ってきた ID を覚える", async () => {
    const { remote, calls } = fakeGraph((method, path) =>
      method === "POST" && path === "/me/messages"
        ? new Response(
            JSON.stringify({ id: "g1", internetMessageId: "<x@outlook.com>" }),
            { status: 201 },
          )
        : undefined,
    );
    expect(await remote.save(message, null)).toEqual({
      messageId: "<x@outlook.com>",
      mailboxPath: null,
      uid: null,
      uidValidity: null,
      providerId: "g1",
    });
    expect(calls[0]?.body).toEqual({
      subject: "打ち合わせ",
      body: { contentType: "html", content: "<div>こんにちは</div>" },
      toRecipients: [
        { emailAddress: { address: "yamada@example.com", name: "山田" } },
      ],
      ccRecipients: [],
      bccRecipients: [],
    });
  });

  it("2 回目からは同じメッセージを書き換え、余分な添付ファイルを消す", async () => {
    const { remote, calls } = fakeGraph((method) => {
      if (method === "PATCH") return new Response("{}", { status: 200 });
      if (method === "GET") {
        return new Response(
          JSON.stringify({ value: [{ id: "a1", name: "old.txt", size: 3 }] }),
          { status: 200 },
        );
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
      return undefined;
    });
    const previous = {
      messageId: "<x@outlook.com>",
      mailboxPath: null,
      uid: null,
      uidValidity: null,
      providerId: "g1",
    };
    expect(await remote.save(message, previous)).toEqual(previous);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "PATCH /me/messages/g1",
      "GET /me/messages/g1/attachments?$select=id,name,size",
      "DELETE /me/messages/g1/attachments/a1",
    ]);
  });

  it("Microsoft 側で消されていたら作り直す", async () => {
    const { remote, calls } = fakeGraph((method) => {
      if (method === "PATCH") {
        return new Response(
          JSON.stringify({ error: { code: "ErrorItemNotFound" } }),
          { status: 404 },
        );
      }
      if (method === "POST") {
        return new Response(JSON.stringify({ id: "g2" }), { status: 201 });
      }
      return undefined;
    });
    const saved = await remote.save(message, {
      messageId: null,
      mailboxPath: null,
      uid: null,
      uidValidity: null,
      providerId: "g1",
    });
    expect(saved?.providerId).toBe("g2");
    expect(calls[1]?.method).toBe("POST");
  });

  it("権限が無ければ拒否として扱い、すでに無い控えの削除は成功にする", async () => {
    const denied = fakeGraph(
      () =>
        new Response(JSON.stringify({ error: { message: "Access denied" } }), {
          status: 403,
        }),
    );
    await expect(denied.remote.save(message, null)).rejects.toBeInstanceOf(
      DraftRejected,
    );
    const missing = fakeGraph(() => new Response("{}", { status: 404 }));
    await missing.remote.remove({
      messageId: null,
      mailboxPath: null,
      uid: null,
      uidValidity: null,
      providerId: "g1",
    });
  });
});
