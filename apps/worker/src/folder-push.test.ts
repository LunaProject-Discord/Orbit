import { EventEmitter } from "node:events";
import type { ImapFlow } from "imapflow";
import { describe, expect, it } from "vitest";
import {
  decodeMailboxName,
  FolderPush,
  idleTargets,
  type NotifyEvent,
  notifiedPath,
  type PushCandidate,
  pushConnectionLimit,
} from "./folder-push.js";

const folder = (
  path: string,
  specialUse: PushCandidate["specialUse"] = null,
  latestAt: string | null = null,
): PushCandidate => ({
  path,
  specialUse,
  latestAt: latestAt ? new Date(latestAt) : null,
});

describe("pushConnectionLimit", () => {
  it("設定が無ければ、サービスに合わせた数にする", () => {
    expect(
      pushConnectionLimit({ provider: "gmail", pushConnections: null }),
    ).toBe(2);
    expect(
      pushConnectionLimit({ provider: "generic", pushConnections: null }),
    ).toBe(3);
  });

  it("設定があればそれを使い、範囲に収める", () => {
    expect(pushConnectionLimit({ provider: "gmail", pushConnections: 0 })).toBe(
      0,
    );
    expect(
      pushConnectionLimit({ provider: "generic", pushConnections: 99 }),
    ).toBe(8);
    expect(
      pushConnectionLimit({ provider: "generic", pushConnections: -1 }),
    ).toBe(0);
  });
});

describe("idleTargets", () => {
  it("迷惑メール、送信済み、利用者のフォルダの順に並べ、受信トレイは含めない", () => {
    const targets = idleTargets(
      [
        folder("INBOX", "inbox"),
        folder("Trash", "trash"),
        folder("Drafts", "drafts"),
        folder("古い", null, "2026-01-01T00:00:00Z"),
        folder("最近", null, "2026-11-01T00:00:00Z"),
        folder("Sent", "sent"),
        folder("Junk", "junk"),
        folder("Archive", "archive"),
      ],
      "generic",
    );
    expect(targets).toEqual([
      "Junk",
      "Sent",
      "最近",
      "古い",
      "Archive",
      "Drafts",
      "Trash",
    ]);
  });

  it("同じ種類の中では、すでに見張っているフォルダを優先する", () => {
    const targets = idleTargets(
      [
        folder("a", null, "2026-11-01T00:00:00Z"),
        folder("b", null, "2026-01-01T00:00:00Z"),
        folder("Junk", "junk"),
      ],
      "generic",
      new Set(["b"]),
    );
    expect(targets).toEqual(["Junk", "b", "a"]);
  });

  it("Gmail は「すべてのメール」と迷惑メール、ごみ箱だけにする", () => {
    const targets = idleTargets(
      [
        folder("INBOX", "inbox"),
        folder("[Gmail]/送信済みメール", "sent"),
        folder("[Gmail]/ゴミ箱", "trash"),
        folder("[Gmail]/迷惑メール", "junk"),
        folder("[Gmail]/すべてのメール", "all"),
        folder("仕事"),
      ],
      "gmail",
    );
    expect(targets).toEqual([
      "[Gmail]/すべてのメール",
      "[Gmail]/迷惑メール",
      "[Gmail]/ゴミ箱",
    ]);
  });

  it("Gmail でも「すべてのメール」が見えなければ、ふつうの順にする", () => {
    const targets = idleTargets(
      [folder("[Gmail]/送信済みメール", "sent"), folder("仕事")],
      "gmail",
    );
    expect(targets).toEqual(["[Gmail]/送信済みメール", "仕事"]);
  });
});

describe("decodeMailboxName / notifiedPath", () => {
  it("modified UTF-7 のフォルダ名を元に戻す", () => {
    expect(decodeMailboxName("&TtVOiw-/&istsQmb4-")).toBe("仕事/請求書");
    expect(decodeMailboxName("A &- B")).toBe("A & B");
    expect(decodeMailboxName("Sent")).toBe("Sent");
  });

  it("STATUS 応答からパスを取り出す", () => {
    const untagged = (value: string) => ({
      attributes: [{ type: "ATOM", value }, []],
    });
    expect(notifiedPath(untagged("&TtVOiw-"), false)).toBe("仕事");
    expect(notifiedPath(untagged("仕事"), true)).toBe("仕事");
    expect(notifiedPath(untagged("inbox"), false)).toBe("INBOX");
    expect(notifiedPath({ attributes: [] }, false)).toBeNull();
  });
});

/** ImapFlow の代わり。接続の成否と NOTIFY の対応を切り替えられる。 */
class FakeClient extends EventEmitter {
  capabilities = new Map<string, boolean>();
  enabled = new Set<string>();
  untaggedHandlers: Record<string, (untagged: unknown) => void> = {};
  opened: string | null = null;
  commands: string[] = [];
  closed = false;

  constructor(
    private readonly behavior: {
      failConnect?: boolean;
      notify?: "ok" | "refuse" | "missing";
    },
  ) {
    super();
    if (behavior.notify && behavior.notify !== "missing") {
      this.capabilities.set("NOTIFY", true);
    }
  }

  async connect() {
    if (this.behavior.failConnect) {
      throw Object.assign(new Error("Command failed"), {
        responseText: "Maximum number of connections exceeded",
      });
    }
  }

  async exec(command: string) {
    this.commands.push(command);
    if (this.behavior.notify === "refuse") {
      throw Object.assign(new Error("Command failed"), {
        responseStatus: "NO",
        responseText: "NOTIFY は使えません",
      });
    }
    return { next: () => {} };
  }

  async mailboxOpen(path: string) {
    this.opened = path;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options: {
  limit: number;
  provider?: string;
  clients: (index: number) => FakeClient;
}) {
  const clients: FakeClient[] = [];
  const events: NotifyEvent[] = [];
  const logs: string[] = [];
  let now = 0;
  const push = new FolderPush({
    createClient: async () => {
      const client = options.clients(clients.length);
      clients.push(client);
      return client as unknown as ImapFlow;
    },
    onEvent: (event) => events.push(event),
    log: (message) => logs.push(message),
    limit: options.limit,
    provider: options.provider ?? "generic",
    now: () => now,
  });
  return {
    push,
    clients,
    events,
    logs,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const CANDIDATES = [
  folder("INBOX", "inbox"),
  folder("Sent", "sent"),
  folder("Junk", "junk"),
  folder("Trash", "trash"),
  folder("仕事"),
];

describe("FolderPush", () => {
  it("NOTIFY に対応していれば、接続 1 本で全フォルダの通知を受ける", async () => {
    const { push, clients, events } = setup({
      limit: 3,
      clients: () => new FakeClient({ notify: "ok" }),
    });
    push.configure(CANDIDATES, true);
    await settle();
    expect(clients).toHaveLength(1);
    expect(clients[0]?.commands).toEqual(["NOTIFY"]);
    expect(clients[0]?.opened).toBe("INBOX");
    expect(push.notifyActive).toBe(true);
    expect(push.isActive("仕事")).toBe(true);
    expect(push.idlePaths).toEqual([]);

    clients[0]?.untaggedHandlers.STATUS?.({
      attributes: [{ type: "STRING", value: "&TtVOiw-" }, []],
    });
    clients[0]?.untaggedHandlers.LIST?.({});
    expect(events).toEqual([
      { kind: "folders" },
      { kind: "mailbox", path: "仕事" },
      { kind: "folders" },
    ]);

    // 何度呼んでも、接続は増えない。
    push.configure(CANDIDATES, true);
    await settle();
    expect(clients).toHaveLength(1);
    push.close();
    expect(clients[0]?.closed).toBe(true);
  });

  it("NOTIFY を断られたら、フォルダごとの IDLE に切り替える", async () => {
    const { push, clients, logs } = setup({
      limit: 2,
      clients: (index) =>
        new FakeClient(index === 0 ? { notify: "refuse" } : {}),
    });
    push.configure(CANDIDATES, true);
    await settle();
    await settle();
    expect(push.notifyActive).toBe(false);
    expect(push.idlePaths).toEqual(["Junk", "Sent"]);
    expect(clients.slice(1).map((client) => client.opened)).toEqual([
      "Junk",
      "Sent",
    ]);
    expect(push.isActive("Junk")).toBe(true);
    expect(push.isActive("Trash")).toBe(false);
    expect(push.isWatching("Trash")).toBe(false);
    expect(logs.some((line) => line.includes("NOTIFY を使えない"))).toBe(true);
    push.close();
  });

  it("上限まで、大事なフォルダから順に IDLE し、変化を知らせる", async () => {
    const { push, clients, events } = setup({
      limit: 3,
      clients: () => new FakeClient({}),
    });
    push.configure(CANDIDATES, false);
    await settle();
    expect(push.idlePaths).toEqual(["Junk", "Sent", "仕事"]);
    events.length = 0;
    clients[1]?.emit("exists", { path: "Sent" });
    expect(events).toEqual([{ kind: "mailbox", path: "Sent" }]);

    // 消されたフォルダの接続は閉じ、空いた分を次のフォルダに回す。
    push.configure(
      CANDIDATES.filter((item) => item.path !== "Sent"),
      false,
    );
    await settle();
    expect(clients[1]?.closed).toBe(true);
    expect(push.idlePaths).toEqual(["Junk", "仕事", "Trash"]);
    push.close();
  });

  it("上限が 0 なら何も張らない", async () => {
    const { push, clients } = setup({
      limit: 0,
      clients: () => new FakeClient({ notify: "ok" }),
    });
    push.configure(CANDIDATES, true);
    await settle();
    expect(clients).toHaveLength(0);
    expect(push.isWatching("Sent")).toBe(false);
  });

  it("接続を張れなければ本数を抑え、時間がたつか、つなぎ直したら戻す", async () => {
    let failing = true;
    const { push, clients, logs, advance } = setup({
      limit: 3,
      clients: (index) =>
        new FakeClient({ failConnect: failing && index >= 1 }),
    });
    push.configure(CANDIDATES, false);
    await settle();
    expect(push.idlePaths).toEqual(["Junk"]);
    expect(logs.join("\n")).toContain("Maximum number of connections");

    // 抑えている間は、張り直そうとしない。
    push.configure(CANDIDATES, false);
    await settle();
    expect(clients).toHaveLength(3);

    failing = false;
    advance(31 * 60_000);
    push.configure(CANDIDATES, false);
    await settle();
    expect(push.idlePaths).toEqual(["Junk", "Sent", "仕事"]);
    push.close();
  });

  it("同期用の接続が断られたら、すべて手放して、しばらく張らない", async () => {
    const { push, clients, advance } = setup({
      limit: 2,
      clients: () => new FakeClient({}),
    });
    push.configure(CANDIDATES, false);
    await settle();
    expect(push.idlePaths).toEqual(["Junk", "Sent"]);
    push.suspend();
    expect(push.idlePaths).toEqual([]);
    expect(clients.every((client) => client.closed)).toBe(true);
    // つなぎ直しても、時間がたつまでは張らない。
    push.reset();
    push.configure(CANDIDATES, false);
    await settle();
    expect(clients).toHaveLength(2);
    advance(31 * 60_000);
    push.configure(CANDIDATES, false);
    await settle();
    expect(push.idlePaths).toEqual(["Junk", "Sent"]);
    push.close();
  });

  it("つなぎ直したら、抑えていた本数をすぐに戻す", async () => {
    let failing = true;
    const { push } = setup({
      limit: 2,
      clients: () => new FakeClient({ failConnect: failing }),
    });
    push.configure(CANDIDATES, false);
    await settle();
    expect(push.idlePaths).toEqual([]);
    failing = false;
    push.reset();
    push.configure(CANDIDATES, false);
    await settle();
    expect(push.idlePaths).toEqual(["Junk", "Sent"]);
    push.close();
  });
});
