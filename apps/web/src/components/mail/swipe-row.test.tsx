// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwipeRow } from "@/components/mail/swipe-row";
import type { SwipeOutcome } from "@/lib/swipe";

const ROW_WIDTH = 360;

const trash = {
  kind: "trash",
  label: "ごみ箱へ",
  removes: true,
  input: { action: "trash" },
} as unknown as SwipeOutcome;

const markRead = {
  kind: "read",
  label: "既読にする",
  removes: false,
  input: { action: "set_flags" },
} as unknown as SwipeOutcome;

/** 一覧と同じく、行をメールの ID で並べ、消える操作をしたら行を取り除く。 */
function List({
  initial,
  onCommit,
}: {
  initial: string[];
  onCommit: (id: string, outcome: SwipeOutcome) => void;
}) {
  const [ids, setIds] = useState(initial);
  return (
    <ul>
      {ids.map((id) => (
        <li key={id} data-id={id}>
          <SwipeRow
            left={trash}
            right={markRead}
            onCommit={(outcome) => {
              onCommit(id, outcome);
              if (outcome.removes) {
                setIds((current) => current.filter((other) => other !== id));
              }
            }}
          >
            <span>{id}</span>
          </SwipeRow>
        </li>
      ))}
    </ul>
  );
}

let container: HTMLDivElement;
let root: Root;
let now = 0;

function rowOf(id: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(
    `li[data-id="${id}"] [data-swipe-row]`,
  );
  if (!row) throw new Error(`row ${id} is not shown`);
  return row;
}

/** 指の動き (touch のポインター) を 1 つ送る。 */
function pointer(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  pointerId: number,
  x: number,
) {
  now += 16;
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: 40,
  });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: "touch" },
    isPrimary: { value: true },
    timeStamp: { value: now },
  });
  act(() => {
    target.dispatchEvent(event);
  });
}

/**
 * 行の上で指を左へ動かして離す。ブラウザーと同じく、押した行が途中で一覧から
 * 外れたら、そのあとの動きはいま指の下にある行 (next) に届く。
 */
function swipeLeft(pointerId: number, down: () => Element) {
  const start = 300;
  pointer(down(), "pointerdown", pointerId, start);
  let x = start;
  for (let step = 0; step < 10; step++) {
    x -= 20;
    pointer(down(), "pointermove", pointerId, x);
  }
  // 指を止めてから離す (払った速さではなく、ずらした量で決める)。
  now += 200;
  pointer(down(), "pointerup", pointerId, x);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(
    ROW_WIDTH,
  );
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** いま、ある縦の位置に出ている行 (一覧の先頭の行) を返す。 */
function topRow(): Element {
  const first = container.querySelector("li [data-swipe-row]");
  if (!first) throw new Error("no rows");
  return first;
}

describe("SwipeRow", () => {
  it("左へ十分にずらして離すと、行を送り出してから操作する", () => {
    const committed: string[] = [];
    act(() =>
      root.render(
        <List initial={["a", "b"]} onCommit={(id) => committed.push(id)} />,
      ),
    );
    swipeLeft(1, () => rowOf("a"));
    expect(committed).toEqual([]);
    act(() => vi.advanceTimersByTime(200));
    expect(committed).toEqual(["a"]);
    expect(container.querySelector('li[data-id="a"]')).toBeNull();
  });

  it("前の行が送り出されている間に、同じ位置で続けてスワイプしても受け付ける", () => {
    const committed: string[] = [];
    act(() =>
      root.render(
        <List
          initial={["a", "b", "c"]}
          onCommit={(id) => committed.push(id)}
        />,
      ),
    );
    swipeLeft(1, topRow);
    // 送り出しが終わる前 (行がまだ残っている間) に、同じ位置を次の指で払う。
    act(() => vi.advanceTimersByTime(50));
    swipeLeft(2, topRow);
    act(() => vi.advanceTimersByTime(200));
    expect(committed).toEqual(["a", "b"]);
    expect(
      [...container.querySelectorAll("li")].map((li) => li.dataset.id),
    ).toEqual(["c"]);
  });

  it("押した行が途中で一覧から外れたら、指の下に来た行で続ける", () => {
    const committed: string[] = [];
    let remove: (() => void) | null = null;
    function Outer() {
      const [ids, setIds] = useState(["a", "b"]);
      remove = () => setIds((current) => current.slice(1));
      return (
        <ul>
          {ids.map((id) => (
            <li key={id} data-id={id}>
              <SwipeRow
                left={trash}
                right={markRead}
                onCommit={() => committed.push(id)}
              >
                <span>{id}</span>
              </SwipeRow>
            </li>
          ))}
        </ul>
      );
    }
    act(() => root.render(<Outer />));
    const a = rowOf("a");
    pointer(a, "pointerdown", 7, 300);
    pointer(a, "pointermove", 7, 280);
    // ほかの端末での削除などで、押している行が一覧から外れる。
    act(() => remove?.());
    const b = rowOf("b");
    let x = 280;
    for (let step = 0; step < 8; step++) {
      x -= 20;
      pointer(b, "pointermove", 7, x);
    }
    now += 200;
    pointer(b, "pointerup", 7, x);
    act(() => vi.advanceTimersByTime(200));
    expect(committed).toEqual(["b"]);
  });

  it("元の位置へ戻っている途中の行も、続けてスワイプできる", () => {
    const committed: string[] = [];
    act(() =>
      root.render(
        <List
          initial={["a"]}
          onCommit={(id, outcome) => committed.push(`${id}:${outcome.kind}`)}
        />,
      ),
    );
    const a = rowOf("a");
    const swipeRight = (pointerId: number) => {
      pointer(a, "pointerdown", pointerId, 60);
      let x = 60;
      for (let step = 0; step < 8; step++) {
        x += 20;
        pointer(a, "pointermove", pointerId, x);
      }
      now += 200;
      pointer(a, "pointerup", pointerId, x);
    };
    swipeRight(1);
    act(() => vi.advanceTimersByTime(50));
    swipeRight(2);
    expect(committed).toEqual(["a:read", "a:read"]);
  });

  it("ほかの指の動きを、押していない行が拾わない", () => {
    const committed: string[] = [];
    act(() =>
      root.render(
        <List initial={["a", "b"]} onCommit={(id) => committed.push(id)} />,
      ),
    );
    const b = rowOf("b");
    let x = 300;
    for (let step = 0; step < 10; step++) {
      x -= 20;
      pointer(b, "pointermove", 3, x);
    }
    now += 200;
    pointer(b, "pointerup", 3, x);
    act(() => vi.advanceTimersByTime(200));
    expect(committed).toEqual([]);
  });
});
