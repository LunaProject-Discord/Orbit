import type { OutboxOperation, OutboxTarget } from "@orbit/core";
import { type Database, outbox } from "@orbit/db";
import { eq } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  insertAccount,
  insertUser,
  type TestDatabase,
} from "./calendar/testing/test-db.js";
import { GraphClient } from "./graph-client.js";
import {
  accountsWithPendingOutbox,
  buildPendingGuard,
  processOutbox,
} from "./outbox.js";
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
  options: {
    uidValidity?: bigint;
    result?: boolean;
    openError?: Error;
    /** MOVE を拒否する (ほかの命令は result に従う)。 */
    rejectMove?: boolean;
    /** MOVE に対応していると名乗る。 */
    moveCapability?: boolean;
    rejectCopy?: boolean;
    /** この UID の保存 (APPEND) を拒否する。 */
    rejectAppendOf?: string[];
  } = {},
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
      return result && !options.rejectMove
        ? { path: "INBOX", destination }
        : false;
    },
    capabilities: new Map(options.moveCapability ? [["MOVE", true]] : []),
    async messageCopy(range: string, destination: string, opts: unknown) {
      calls.push(["copy", range, destination, opts]);
      return options.rejectCopy ? false : { path: "INBOX", destination };
    },
    async fetchOne(uid: string) {
      calls.push(["fetch", uid]);
      return {
        source: Buffer.from(`mail ${uid}`),
        flags: new Set(["\\Seen", "\\Recent"]),
        internalDate: new Date("2026-11-22T00:00:00Z"),
      };
    },
    async append(path: string, content: Buffer, flags: string[]) {
      const uid = content.toString().slice(5);
      calls.push(["append", path, uid, flags]);
      return options.rejectAppendOf?.includes(uid) ? false : { path };
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

  const junkMove: OutboxOperation = {
    kind: "move",
    payload: {
      targets: [target({ uid: "7" }), target({ messageId: "m2", uid: "9" })],
      destination: { mailboxId: "box3", path: "迷惑メール" },
    },
  };

  it("MOVE を拒否されたら、コピーしてから元を削除する", async () => {
    const { client, calls } = fakeImap({
      rejectMove: true,
      moveCapability: true,
    });
    expect(await applyImapOperation(client, junkMove)).toEqual({ ok: true });
    expect(calls).toEqual([
      ["lock", "INBOX"],
      ["move", "7,9", "迷惑メール", { uid: true }],
      ["copy", "7,9", "迷惑メール", { uid: true }],
      ["delete", "7,9", { uid: true }],
      ["release", "INBOX"],
    ]);
  });

  it("コピーも拒否されたら、移動先へ保存し直してから元を削除する", async () => {
    const { client, calls } = fakeImap({
      rejectMove: true,
      moveCapability: true,
      rejectCopy: true,
    });
    expect(await applyImapOperation(client, junkMove)).toEqual({ ok: true });
    expect(calls).toEqual([
      ["lock", "INBOX"],
      ["move", "7,9", "迷惑メール", { uid: true }],
      ["copy", "7,9", "迷惑メール", { uid: true }],
      ["fetch", "7"],
      ["append", "迷惑メール", "7", ["\\Seen"]],
      ["fetch", "9"],
      ["append", "迷惑メール", "9", ["\\Seen"]],
      ["delete", "7,9", { uid: true }],
      ["release", "INBOX"],
    ]);
  });

  it("MOVE に対応していないサーバーでは、コピーを試し直さない", async () => {
    const { client, calls } = fakeImap({ rejectMove: true });
    expect(await applyImapOperation(client, junkMove)).toEqual({ ok: true });
    expect(calls.map(([name]) => name)).not.toContain("copy");
  });

  it("どの方法も拒否されたら、元のメールを消さずに失敗にする", async () => {
    const { client, calls } = fakeImap({
      rejectMove: true,
      rejectAppendOf: ["7"],
    });
    const result = await applyImapOperation(client, junkMove);
    expect(result.ok).toBe(false);
    expect(calls.map(([name]) => name)).not.toContain("delete");
  });

  it("途中で拒否されたら、移動先に入った分だけ元を消して失敗にする", async () => {
    const { client, calls } = fakeImap({
      rejectMove: true,
      rejectAppendOf: ["9"],
    });
    const result = await applyImapOperation(client, junkMove);
    expect(result.ok).toBe(false);
    expect(calls).toContainEqual(["delete", "7", { uid: true }]);
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

const adminUrl = process.env.DATABASE_URL;

describe.skipIf(!adminUrl)("メールの outbox と予定の書き戻しの切り分け", () => {
  let test: TestDatabase;
  let db: Database;
  let userId: string;

  beforeAll(async () => {
    test = await createTestDatabase(adminUrl as string, "orbit_mailoutbox");
    db = test.db;
    userId = await insertUser(db, "mailoutbox@example.com");
  });

  afterAll(async () => {
    await test?.drop();
  });

  const insertRow = (
    accountId: string,
    kind: "set_flags" | "event_update",
    payload: Record<string, unknown>,
  ) =>
    db
      .insert(outbox)
      .values({
        accountId,
        kind,
        payload,
        idempotencyKey: `${kind}:${crypto.randomUUID()}`,
      })
      .returning()
      .then((rows) => rows[0]);

  it("event_update の行があっても、processOutbox は触らない", async () => {
    const account = await insertAccount(db, userId);
    const event = await insertRow(account.id, "event_update", {
      eventId: crypto.randomUUID(),
      calendarId: crypto.randomUUID(),
      fields: ["summary"],
    });
    const flags = await insertRow(account.id, "set_flags", {
      targets: [],
      seen: true,
    });
    const executed: string[] = [];
    const result = await processOutbox(
      db,
      account.id,
      async (operation) => {
        executed.push(operation.kind);
        return { ok: true };
      },
      () => {},
    );
    expect(result).toEqual({ done: 1, failed: 0 });
    expect(executed).toEqual(["set_flags"]);
    const [eventAfter] = await db
      .select()
      .from(outbox)
      .where(eq(outbox.id, event?.id as string));
    expect(eventAfter?.status).toBe("pending");
    expect(eventAfter?.attempts).toBe(0);
    const [flagsAfter] = await db
      .select()
      .from(outbox)
      .where(eq(outbox.id, flags?.id as string));
    expect(flagsAfter?.status).toBe("done");
  });

  it("accountsWithPendingOutbox は、メールと予定の書き戻しを分けて数える", async () => {
    const mail = await insertAccount(db, userId);
    const calendar = await insertAccount(db, userId);
    await insertRow(mail.id, "set_flags", { targets: [], seen: true });
    await insertRow(calendar.id, "event_update", {
      eventId: crypto.randomUUID(),
      calendarId: crypto.randomUUID(),
      fields: ["summary"],
    });
    const mailIds = await accountsWithPendingOutbox(db);
    const calendarIds = await accountsWithPendingOutbox(db, "calendar");
    expect(mailIds).toContain(mail.id);
    expect(mailIds).not.toContain(calendar.id);
    expect(calendarIds).toContain(calendar.id);
    expect(calendarIds).not.toContain(mail.id);
  });
});
