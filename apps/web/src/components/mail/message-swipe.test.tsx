// @vitest-environment happy-dom
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageSwipe } from "@/components/mail/message-swipe";

const WIDTH = 400;

/** 開いているメールの画面と同じく、左へ払うと次のメール、右へ払うと前のメールへ移る。 */
function Viewer({
  count,
  onShow,
}: {
  count: number;
  onShow: (index: number) => void;
}) {
  const [index, setIndex] = useState(0);
  onShow(index);
  return (
    <MessageSwipe
      resetKey={`message-${index}`}
      left={
        index < count - 1
          ? {
              label: "次のメール",
              icon: ChevronRightIcon,
              color: "",
              exits: true,
              run: () => setIndex((current) => current + 1),
            }
          : null
      }
      right={
        index > 0
          ? {
              label: "前のメール",
              icon: ChevronLeftIcon,
              color: "",
              exits: true,
              run: () => setIndex((current) => current - 1),
            }
          : null
      }
    >
      {/* メールが替わると中身も作り直される (読み込み中の表示に替わるなど)。 */}
      <p key={index}>message {index}</p>
    </MessageSwipe>
  );
}

let container: HTMLDivElement;
let root: Root;
let now = 0;

function surface(): Element {
  const element = container.querySelector("[data-message-swipe]");
  if (!element) throw new Error("no swipe surface");
  return element;
}

/** 指 1 本の touch イベントを送る。 */
function touch(
  type: "touchstart" | "touchmove" | "touchend",
  id: number,
  x: number,
  target: () => Element = surface,
) {
  now += 16;
  const point = {
    identifier: id,
    screenX: x,
    screenY: 300,
    clientX: x,
    clientY: 300,
  };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: type === "touchend" ? [] : [point] },
    changedTouches: { value: [point] },
    timeStamp: { value: now },
  });
  act(() => {
    target().dispatchEvent(event);
  });
}

/** 左へ払って離す。 */
function swipeLeft(id: number) {
  let x = 320;
  // 動きは、押し始めた要素へ届き続ける (ブラウザーの touch イベントと同じ)。
  const pressed =
    container.querySelector("[data-message-swipe] p") ?? surface();
  const at = () => pressed;
  touch("touchstart", id, x, at);
  for (let step = 0; step < 10; step++) {
    x -= 20;
    touch("touchmove", id, x, at);
  }
  now += 200;
  touch("touchend", id, x, at);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(WIDTH);
  vi.stubGlobal("innerWidth", WIDTH);
  vi.stubGlobal("screenX", 0);
  // 動きを抑える設定にして、入ってくる動き (Web Animations) を使わない。
  document.documentElement.dataset.motion = "off";
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
  delete document.documentElement.dataset.motion;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MessageSwipe", () => {
  it("左へ払うと、画面の外へ送り出してから次のメールへ移る", () => {
    let shown = -1;
    act(() =>
      root.render(<Viewer count={5} onShow={(index) => (shown = index)} />),
    );
    swipeLeft(1);
    expect(shown).toBe(0);
    act(() => vi.advanceTimersByTime(200));
    expect(shown).toBe(1);
  });

  it("送り出している間に続けて払っても受け付ける", () => {
    let shown = -1;
    act(() =>
      root.render(<Viewer count={5} onShow={(index) => (shown = index)} />),
    );
    swipeLeft(1);
    act(() => vi.advanceTimersByTime(50));
    swipeLeft(2);
    act(() => vi.advanceTimersByTime(50));
    swipeLeft(3);
    act(() => vi.advanceTimersByTime(1000));
    expect(shown).toBe(3);
  });

  it("移ったあと、すぐに払っても受け付ける", () => {
    let shown = -1;
    act(() =>
      root.render(<Viewer count={5} onShow={(index) => (shown = index)} />),
    );
    swipeLeft(1);
    act(() => vi.advanceTimersByTime(200));
    expect(shown).toBe(1);
    swipeLeft(2);
    act(() => vi.advanceTimersByTime(200));
    expect(shown).toBe(2);
  });
});
