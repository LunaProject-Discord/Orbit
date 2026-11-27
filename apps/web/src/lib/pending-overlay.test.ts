import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageAction, MessageSummary } from "@/lib/api";
import { markRowsRead, PendingOverlay } from "@/lib/pending-overlay";
import type {
  PendingShare,
  SharedAction,
  SharedSent,
  SharedState,
} from "@/lib/pending-share";

function row(id: string): MessageSummary {
  return {
    id,
    accountId: "a",
    mailboxId: "inbox-a",
    threadKey: `t-${id}`,
    subject: id,
    from: [],
    to: [],
    receivedAt: "2026-11-20",
    snippet: "",
    hasAttachments: false,
    seen: false,
    flagged: false,
    answered: false,
    threadCount: 1,
    threadMessageIds: [id],
  };
}

const read = (key: string, ids: string[]): MessageAction => ({
  idempotencyKey: key,
  messageIds: ids,
  action: "set_flags",
  seen: true,
});

/** ほかのウィンドウの代わり。 */
function fakeShare(remote: SharedAction[] = []) {
  const published: { state: SharedState; sent: SharedSent | undefined }[] = [];
  const share: PendingShare = {
    publish: (state, sent) => published.push({ state, sent }),
    requestReload: () => {},
    actions: () => remote,
    markRead: () => [],
    subscribe: () => () => {},
    close: () => {},
  };
  return { share, published };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("画面に重ねる操作をまとめる", () => {
  it("ほかのウィンドウの操作も重ね、同じ操作は 1 回だけにする", () => {
    const remote = { action: read("r", ["y"]), rows: [row("y")], origin: "u" };
    const { share } = fakeShare([
      remote,
      { action: read("k", ["x"]), rows: [], origin: null },
    ]);
    const overlay = new PendingOverlay(share);
    const local = read("k", ["x"]);
    overlay.record("k", [row("x")], null);
    const sources = overlay.sources([local], "unified");
    expect(sources.actions.map((action) => action.idempotencyKey)).toEqual([
      "r",
      "k",
    ]);
    expect(sources.snapshots.get("k")?.[0]?.id).toBe("x");
    expect(sources.origins.get("r")).toBe("u");
  });

  it("サーバーが受け付けた操作は、その後に始めた取得が終わるまで重ね続ける", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { share, published } = fakeShare();
    const overlay = new PendingOverlay(share);
    const action = read("k", ["x"]);
    overlay.record("k", [row("x")], null);
    vi.setSystemTime(2_000);
    overlay.sent(action);
    // 送信待ちから外れても、未読数には重ねたまま。
    expect(overlay.sources([], "mailboxes").actions).toHaveLength(1);
    // 受け付ける前に始めた取得では、まだ外さない。
    overlay.fresh("mailboxes", 1_500);
    expect(overlay.sources([], "mailboxes").actions).toHaveLength(1);
    overlay.fresh("mailboxes", 2_500);
    expect(overlay.sources([], "mailboxes").actions).toHaveLength(0);
    expect(overlay.sources([], "unified").actions).toHaveLength(1);
    overlay.fresh("unified", 2_500);
    expect(overlay.sources([], "list").actions).toHaveLength(0);
    // 受け付けたことは、ほかのウィンドウにも知らせる。
    overlay.publish([]);
    expect(published.at(-1)?.sent?.actions[0]?.action.idempotencyKey).toBe("k");
  });

  it("すべて既読にしたフォルダは、応答を待つ間と取り直すまで重ねる", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const overlay = new PendingOverlay(null);
    overlay.startMarkRead({ mailboxId: "inbox-a", unread: 3 });
    expect(overlay.sources([], "unified").markRead).toHaveLength(1);
    vi.setSystemTime(2_000);
    overlay.finishMarkRead("inbox-a", true);
    expect(overlay.sources([], "unified").markRead).toHaveLength(1);
    overlay.fresh("unified", 2_500);
    expect(overlay.sources([], "unified").markRead).toHaveLength(0);
    // 失敗したら、すぐに重ねるのをやめる。
    overlay.startMarkRead({ mailboxId: "inbox-a", unread: 3 });
    overlay.finishMarkRead("inbox-a", false);
    expect(overlay.sources([], "unified").markRead).toHaveLength(0);
  });

  it("すべて既読にしているフォルダの行を既読にする", () => {
    const rows = [row("x"), { ...row("y"), mailboxId: "work" }];
    const result = markRowsRead(rows, [{ mailboxId: "inbox-a", unread: 1 }]);
    expect(result.map((item) => item.seen)).toEqual([true, false]);
  });
});
