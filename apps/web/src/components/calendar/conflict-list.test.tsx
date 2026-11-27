// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConflictList,
  ConflictsButton,
} from "@/components/calendar/conflict-list";
import { PendingBadge } from "@/components/calendar/pending-badge";
import type { Calendar } from "@/lib/calendar/api";
import type { ConflictItem } from "@/lib/calendar/offline";

const google = {
  id: "cal",
  source: "google",
  name: "個人",
} as Calendar;

function item(overrides: Partial<ConflictItem>): ConflictItem {
  return {
    id: "c1",
    source: "server",
    kind: "field_lost",
    calendarId: "cal",
    eventId: "e1",
    recurrenceId: null,
    title: "定例会議",
    fields: ["location"],
    lost: { location: "会議室 A" },
    kept: { location: "会議室 B" },
    snapshot: null,
    reason: null,
    createdAt: "2026-11-27T00:00:00.000Z",
    actions: ["restore", "dismiss"],
    opId: null,
    ...overrides,
  };
}

describe("反映されなかった変更の一覧", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const buttons = () => [
    ...document.body.querySelectorAll<HTMLButtonElement>("button"),
  ];
  const byText = (text: string) =>
    buttons().find((button) => button.textContent?.trim() === text);

  function renderList(
    items: ConflictItem[],
    onAction = vi.fn(),
    busy: { id: string; action: "restore" } | null = null,
  ) {
    act(() =>
      root.render(
        <ConflictList
          open
          items={items}
          calendarOf={(id) => (id === "cal" ? google : undefined)}
          colorOf={() => "#4f46e5"}
          eventOf={() => undefined}
          timeZone="Asia/Tokyo"
          busy={busy}
          onAction={onAction}
          onClose={() => {}}
        />,
      ),
    );
    return onAction;
  }

  it("説明、自分の値 → 採用された値、kind に合ったボタンを出す", () => {
    const onAction = renderList([
      item({}),
      item({
        id: "c2",
        source: "local",
        kind: "deleted_elsewhere",
        fields: [],
        lost: null,
        kept: null,
        actions: ["restore", "dismiss"],
        opId: "op1",
      }),
    ]);
    const text = document.body.textContent ?? "";
    expect(text).toContain(
      "「定例会議」の場所は、Google カレンダーで後から変更された内容になりました。",
    );
    expect(text).toContain("会議室 A");
    expect(text).toContain("会議室 B");
    expect(text).toContain("ほかの端末で削除されていた");
    expect(byText("自分の変更に戻す")).toBeTruthy();
    expect(byText("復元")).toBeTruthy();
    // 送信待ちから来たものは「破棄」(操作も捨てる)。
    expect(byText("破棄")).toBeTruthy();

    act(() => byText("自分の変更に戻す")?.click());
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c1" }),
      "restore",
    );
  });

  it("押している途中は、ほかのボタンを押せない", () => {
    renderList([item({})], vi.fn(), { id: "c1", action: "restore" });
    expect(byText("閉じる")?.disabled).toBe(true);
  });

  it("0 件のときは、ヘッダーのボタンを出さない", () => {
    act(() =>
      root.render(
        <ConflictsButton count={0} compact={false} onClick={() => {}} />,
      ),
    );
    expect(container.textContent).toBe("");
    act(() =>
      root.render(<ConflictsButton count={2} compact onClick={() => {}} />),
    );
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe(
      "反映されなかった変更 2 件",
    );
  });
});

describe("未送信の印", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("オフライン中は「接続すると送信します」と添える", () => {
    act(() =>
      root.render(
        <PendingBadge
          state={{ tone: "pending", label: "未送信", detail: null }}
          offline
        />,
      ),
    );
    expect(container.textContent).toBe("未送信 · 接続すると送信します");
  });

  it("送信できなかったものは、理由と「確認する」を出す", () => {
    const onShow = vi.fn();
    act(() =>
      root.render(
        <PendingBadge
          state={{
            tone: "error",
            label: "送信できませんでした",
            detail: "このカレンダーは読み取り専用です",
          }}
          offline={false}
          onShowDetails={onShow}
        />,
      ),
    );
    expect(container.textContent).toContain("このカレンダーは読み取り専用です");
    act(() => container.querySelector("button")?.click());
    expect(onShow).toHaveBeenCalled();
  });

  it("送信待ちが無ければ何も出さない", () => {
    act(() => root.render(<PendingBadge state={null} offline={false} />));
    expect(container.innerHTML).toBe("");
  });
});
