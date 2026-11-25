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
  wheel = false,
}: {
  count: number;
  onShow: (index: number) => void;
  wheel?: boolean;
}) {
  const [index, setIndex] = useState(0);
  onShow(index);
  return (
    <MessageSwipe
      wheel={wheel}
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

/** 動きが作られた時刻 (event.timeStamp)。届いて処理される時刻 (タイマー) とは別に進める。 */
let eventClock = 1000;

function wheelEvent(deltaX: number, timeStamp: number): Event {
  const event = new Event("wheel", { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    deltaX: { value: deltaX },
    deltaY: { value: 0 },
    deltaMode: { value: 0 },
    ctrlKey: { value: false },
    timeStamp: { value: timeStamp },
  });
  return event;
}

/** トラックパッドの横の動きを 1 つ送る。次の動きは 1 コマ (16 ms) あとに作られる。 */
function wheel(deltaX: number) {
  const event = wheelEvent(deltaX, eventClock);
  eventClock += 16;
  act(() => {
    surface().dispatchEvent(event);
  });
  act(() => vi.advanceTimersByTime(16));
}

/** 指を離して、次に払い始めるまで待つ。 */
function pause(ms: number) {
  eventClock += ms;
  act(() => vi.advanceTimersByTime(ms));
}

/** 慣性の動き。弱まりながら続く。 */
function inertia(frames: number, from = 22): number[] {
  const deltas: number[] = [];
  let delta = from;
  for (let frame = 0; frame < frames; frame++) {
    deltas.push(Math.max(1, Math.round(delta)));
    delta *= 0.9;
  }
  return deltas;
}

/** 2 本指で左へ払う。指を離したあとも、弱まりながら慣性の動きが続く。 */
function trackpadSwipeLeft(frames: number) {
  for (const delta of [2, 6, 14, 24, 30, 30, 26]) wheel(delta);
  for (const delta of inertia(frames)) wheel(delta);
}

/**
 * 2 本指で左へ払う。払い終わりに指をほぼ止めて (そこで操作が決まる)、そのあとも
 * 慣性の動きが続く。別のメールへ移ると、描き直している間 (300 ms) 画面が固まり、
 * その間に作られた動きは、固まりが解けたあとに 1 つに合わさって届く (ブラウザーの動作)。
 */
function trackpadSwipeLeftWithFreeze(moved: () => boolean) {
  for (const delta of [2, 6, 14, 24, 30, 30, 26, 2]) wheel(delta);
  const tail = inertia(50, 20);
  let frozen = false;
  for (let index = 0; index < tail.length; index++) {
    if (!frozen && moved()) {
      frozen = true;
      const held = tail.slice(index, index + 18);
      act(() => vi.advanceTimersByTime(300));
      // 作られた時刻は、固まる前の動きから途切れずに続いている。
      const merged = wheelEvent(
        held.reduce((sum, delta) => sum + delta, 0),
        eventClock + 16 * (held.length - 1),
      );
      eventClock += 16 * held.length;
      act(() => {
        surface().dispatchEvent(merged);
      });
      index += held.length - 1;
      continue;
    }
    wheel(tail[index] ?? 1);
  }
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

  it("トラックパッドで払ったあとの慣性では、続けて移らない", () => {
    let shown = -1;
    act(() =>
      root.render(
        <Viewer count={5} wheel onShow={(index) => (shown = index)} />,
      ),
    );
    trackpadSwipeLeft(80);
    act(() => vi.advanceTimersByTime(1000));
    expect(shown).toBe(1);
  });

  it("トラックパッドで、慣性の途中や直後に続けて払っても受け付ける", () => {
    let shown = -1;
    act(() =>
      root.render(
        <Viewer count={5} wheel onShow={(index) => (shown = index)} />,
      ),
    );
    // 慣性の途中で次を払う (指を置くと慣性は止まり、少し間が空いてから次の動きが届く)。
    trackpadSwipeLeft(8);
    pause(120);
    trackpadSwipeLeft(8);
    // 慣性が終わった直後に次を払う。
    pause(120);
    trackpadSwipeLeft(40);
    pause(120);
    trackpadSwipeLeft(40);
    act(() => vi.advanceTimersByTime(1000));
    expect(shown).toBe(4);
  });

  it("同じ向きに 2 回払うと、画面が固まっても 2 回だけ移る", () => {
    let shown = -1;
    act(() =>
      root.render(
        <Viewer count={5} wheel onShow={(index) => (shown = index)} />,
      ),
    );
    const first = shown;
    trackpadSwipeLeftWithFreeze(() => shown !== first);
    pause(200);
    const second = shown;
    trackpadSwipeLeftWithFreeze(() => shown !== second);
    act(() => vi.advanceTimersByTime(1000));
    expect(shown).toBe(2);
  });
});
