import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, NetworkError, type SendMailInput } from "@/lib/api";
import { SendOutbox } from "@/lib/offline/outbox";
import { syncStatusLabel } from "@/lib/offline/status";
import { MemoryStore } from "@/lib/offline/store";

function input(id: string): SendMailInput {
  return {
    idempotencyKey: id,
    accountId: "account",
    to: [{ address: "sato@example.com" }],
    cc: [],
    bcc: [],
    subject: id,
    text: "",
    mode: "new",
  };
}

describe("SendOutbox", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("届かない間は預かり、届くようになったら古い順に送る", async () => {
    const store = new MemoryStore();
    let online = false;
    const sent: string[] = [];
    const outbox = new SendOutbox(store, {
      send: async (mail) => {
        if (!online) throw new NetworkError();
        sent.push(mail.idempotencyKey);
      },
      retryMs: 1_000,
    });
    await outbox.enqueue(input("a"), []);
    await outbox.enqueue(input("b"), []);
    await outbox.flush();
    expect(sent).toEqual([]);
    expect(outbox.items().map((item) => item.id)).toEqual(["a", "b"]);

    online = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual(["a", "b"]);
    expect(outbox.items()).toEqual([]);
    expect(await store.list("outbox")).toEqual([]);
  });

  it("預かったメールは、開き直しても残っている", async () => {
    const store = new MemoryStore();
    const first = new SendOutbox(store, {
      send: async () => {
        throw new NetworkError();
      },
    });
    await first.enqueue(input("a"), []);
    first.stop();

    const sent: string[] = [];
    const second = new SendOutbox(store, {
      send: async (mail) => {
        sent.push(mail.idempotencyKey);
      },
    });
    await second.load();
    await second.flush();
    expect(sent).toEqual(["a"]);
  });

  it("サーバーに断られたメールは理由を添えて残し、後ろのメールは送る", async () => {
    const sent: string[] = [];
    const delivered: string[] = [];
    const outbox = new SendOutbox(new MemoryStore(), {
      send: async (mail) => {
        if (mail.idempotencyKey === "a") {
          throw new ApiError(400, "attachment_not_found", null);
        }
        sent.push(mail.idempotencyKey);
      },
    });
    outbox.onSent((item) => delivered.push(item.id));
    await outbox.enqueue(input("a"), []);
    await outbox.enqueue(input("b"), []);
    await outbox.flush();
    expect(sent).toEqual(["b"]);
    expect(delivered).toEqual(["b"]);
    expect(outbox.items()).toMatchObject([
      { id: "a", error: "attachment_not_found" },
    ]);
    // 断られたメールは、自動では送り直さない。
    await outbox.flush();
    expect(sent).toEqual(["b"]);
  });

  it("送っている最中のメールは取り除けない", async () => {
    let finish: () => void = () => {};
    const outbox = new SendOutbox(new MemoryStore(), {
      send: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    await outbox.enqueue(input("a"), []);
    await outbox.enqueue(input("b"), []);
    const flushing = outbox.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(await outbox.remove("a")).toBe(false);
    expect(await outbox.remove("b")).toBe(true);
    finish();
    await flushing;
    expect(outbox.items()).toEqual([]);
  });
});

describe("syncStatusLabel", () => {
  it("オフラインでは、接続後に行うことを示す", () => {
    expect(
      syncStatusLabel({ online: false, queuedSends: 1, pendingActions: 3 }),
    ).toBe("オフライン · 接続後に 1 件を送信");
    expect(
      syncStatusLabel({ online: false, queuedSends: 0, pendingActions: 3 }),
    ).toBe("オフライン · 未反映の操作 3 件");
    expect(
      syncStatusLabel({ online: false, queuedSends: 0, pendingActions: 0 }),
    ).toBe("オフライン · 保存済みのメールを表示中");
  });

  it("オンラインで何も残っていなければ、同期済みと示す", () => {
    expect(
      syncStatusLabel({ online: true, queuedSends: 0, pendingActions: 0 }),
    ).toBe("同期済み");
  });
});
