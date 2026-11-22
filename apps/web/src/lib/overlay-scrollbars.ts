import { SCROLLBAR_HIDE_DELAY } from "@/lib/scrollbar-hover";

/**
 * 内容の上に重ねて表示するスクロールバー。
 *
 * ブラウザーのスクロールバーは幅を取り、内容をその分だけ狭めてしまう (重ねる指定は無くなった)。
 * そこで、ブラウザーのバーは CSS で隠し、代わりのバーを画面に固定した要素として描く。
 * スクロールする要素には手を加えず (包んだり子を足したりしない)、位置と大きさを読むだけなので、
 * 一覧の仮想化や入力欄などとぶつからない。
 *
 * ダイアログやメニューの中は対象にしない (外側を押したと判定されて閉じてしまうため)。
 * そこではブラウザーのバーを、これまでどおり細く表示する (globals.css)。
 */

/** この中のスクロール領域は、ブラウザーのバーのままにする。globals.css の指定と揃える。 */
const NATIVE_SCOPE =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/** html に付ける目印。付いている間だけ、globals.css がブラウザーのバーを隠す。 */
const ENABLED_ATTRIBUTE = "data-overlay-scrollbars";

const BAR_CLASS = "overlay-scrollbar";

/** バーの両端に空ける余白と、つまみの最小の長さ (px)。 */
const TRACK_INSET = 2;
const MIN_THUMB = 36;

/** 中身の大きさが変わったことに気づくための、見直しの間隔 (ミリ秒)。 */
const REFRESH_INTERVAL = 300;

export type ThumbMetrics = {
  /** つまみの長さ (px)。 */
  size: number;
  /** バーの端からつまみまでの距離 (px)。 */
  start: number;
  /** つまみを 1px 動かしたときに、中身が動く量 (px)。 */
  ratio: number;
};

/**
 * つまみの長さと位置。スクロールする必要が無ければ null。
 * viewport は見えている範囲、content は中身全体、offset はスクロール位置、track はバーの長さ。
 */
export function thumbMetrics(
  viewport: number,
  content: number,
  offset: number,
  track: number,
  minSize = MIN_THUMB,
): ThumbMetrics | null {
  const max = content - viewport;
  if (max <= 1 || viewport <= 0) return null;
  const size = Math.max(Math.min(minSize, track), (track * viewport) / content);
  const travel = track - size;
  if (travel <= 0) return null;
  const position = Math.min(1, Math.max(0, offset / max));
  return { size, start: travel * position, ratio: max / travel };
}

type Axis = "x" | "y";

type Bar = {
  element: HTMLDivElement;
  thumb: HTMLDivElement;
  container: HTMLElement;
  axis: Axis;
  metrics: ThumbMetrics | null;
};

const owners = new WeakMap<Element, HTMLElement>();

/** 重ねて表示しているバー (またはそのつまみ) が、どの要素のものか。バーでなければ null。 */
export function overlayScrollbarOwner(
  target: EventTarget | null,
): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const bar = target.closest(`.${BAR_CLASS}`);
  return (bar && owners.get(bar)) ?? null;
}

/** いまカーソルが乗っているバーの持ち主。乗っていなければ null。 */
export function hoveredOverlayScrollbarOwner(): HTMLElement | null {
  return overlayScrollbarOwner(document.querySelector(`.${BAR_CLASS}:hover`));
}

function scrollsOn(style: CSSStyleDeclaration, axis: Axis): boolean {
  const value = axis === "y" ? style.overflowY : style.overflowX;
  return value === "auto" || value === "scroll";
}

/** 重ねるバーの対象になる要素か。ページ全体と、ダイアログやメニューの中は対象外。 */
function isScroller(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element === document.documentElement || element === document.body) {
    return false;
  }
  const style = getComputedStyle(element);
  if (!scrollsOn(style, "x") && !scrollsOn(style, "y")) return false;
  return element.closest(NATIVE_SCOPE) === null;
}

/**
 * 重ねて表示するスクロールバーを有効にする。戻り値を呼ぶと元に戻る。
 * マウスなどで細かく指せる端末だけが対象 (タッチ操作の端末は OS のバーのまま)。
 */
export function installOverlayScrollbars(): () => void {
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    return () => {};
  }
  const root = document.documentElement;
  root.setAttribute(ENABLED_ATTRIBUTE, "");

  const bars = new Map<HTMLElement, Partial<Record<Axis, Bar>>>();
  /** カーソルの下にあるスクロール領域 (入れ子ならすべて)。 */
  let hovered = new Set<HTMLElement>();
  /** スクロール中の領域と、隠し始めるまでのタイマー。 */
  const scrolling = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  let drag: { bar: Bar; pointer: number; from: number; origin: number } | null =
    null;

  const createBar = (container: HTMLElement, axis: Axis): Bar => {
    const element = document.createElement("div");
    element.className = BAR_CLASS;
    element.dataset.axis = axis;
    element.setAttribute("aria-hidden", "true");
    const thumb = document.createElement("div");
    element.append(thumb);
    owners.set(element, container);
    const bar: Bar = { element, thumb, container, axis, metrics: null };
    element.addEventListener("pointerdown", (event) => onBarDown(event, bar));
    element.addEventListener("pointermove", (event) => onBarMove(event));
    element.addEventListener("pointerup", (event) => onBarUp(event));
    element.addEventListener("pointercancel", (event) => onBarUp(event));
    // バーの上でホイールを回したときも、下の領域をスクロールする。
    element.addEventListener(
      "wheel",
      (event) => {
        const unit =
          event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? 16
            : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
              ? container.clientHeight
              : 1;
        container.scrollBy(event.deltaX * unit, event.deltaY * unit);
      },
      { passive: true },
    );
    document.body.append(element);
    return bar;
  };

  const scrollPosition = (bar: Bar) =>
    bar.axis === "y" ? bar.container.scrollTop : bar.container.scrollLeft;
  const scrollTo = (bar: Bar, value: number) => {
    if (bar.axis === "y") bar.container.scrollTop = value;
    else bar.container.scrollLeft = value;
  };
  const along = (event: PointerEvent, axis: Axis) =>
    axis === "y" ? event.clientY : event.clientX;

  function onBarDown(event: PointerEvent, bar: Bar) {
    if (event.button !== 0 || !bar.metrics) return;
    // 文字の選択や、入力欄からのフォーカスの移動を起こさない。
    event.preventDefault();
    if (event.target !== bar.thumb) {
      // つまみの外 (溝) を押したら、その方向へ 1 画面分だけ進める。
      const rect = bar.thumb.getBoundingClientRect();
      const before =
        along(event, bar.axis) < (bar.axis === "y" ? rect.top : rect.left);
      const page =
        (bar.axis === "y"
          ? bar.container.clientHeight
          : bar.container.clientWidth) * 0.9;
      scrollTo(bar, scrollPosition(bar) + (before ? -page : page));
      return;
    }
    bar.element.setPointerCapture(event.pointerId);
    bar.element.dataset.dragging = "";
    drag = {
      bar,
      pointer: event.pointerId,
      from: along(event, bar.axis),
      origin: scrollPosition(bar),
    };
  }
  function onBarMove(event: PointerEvent) {
    if (!drag || drag.pointer !== event.pointerId || !drag.bar.metrics) return;
    const moved = along(event, drag.bar.axis) - drag.from;
    scrollTo(drag.bar, drag.origin + moved * drag.bar.metrics.ratio);
  }
  function onBarUp(event: PointerEvent) {
    if (!drag || drag.pointer !== event.pointerId) return;
    delete drag.bar.element.dataset.dragging;
    drag = null;
    update();
  }

  /** バーの場所が、ほかの要素 (重なったサイドバーやダイアログ) に隠れていないか。 */
  const exposed = (bar: Bar, x: number, y: number) => {
    const below = document
      .elementsFromPoint(x, y)
      .find((element) => element.closest(`.${BAR_CLASS}`) === null);
    return below !== undefined && bar.container.contains(below);
  };

  const place = (container: HTMLElement, axis: Axis, wanted: boolean) => {
    const entry = bars.get(container) ?? {};
    let bar = entry[axis];
    const vertical = axis === "y";
    const viewport = vertical ? container.clientHeight : container.clientWidth;
    const metrics =
      wanted && scrollsOn(getComputedStyle(container), axis)
        ? thumbMetrics(
            viewport,
            vertical ? container.scrollHeight : container.scrollWidth,
            vertical ? container.scrollTop : container.scrollLeft,
            viewport - TRACK_INSET * 2,
          )
        : null;
    if (!metrics) {
      if (bar && drag?.bar !== bar) delete bar.element.dataset.visible;
      return;
    }
    if (!bar) {
      bar = createBar(container, axis);
      entry[axis] = bar;
      bars.set(container, entry);
    }
    bar.metrics = metrics;
    const rect = container.getBoundingClientRect();
    const left = rect.left + container.clientLeft;
    const top = rect.top + container.clientTop;
    const style = bar.element.style;
    const thumb = bar.thumb.style;
    if (vertical) {
      style.left = `${left + container.clientWidth}px`;
      style.top = `${top}px`;
      style.height = `${viewport}px`;
      thumb.height = `${metrics.size}px`;
      thumb.transform = `translateY(${TRACK_INSET + metrics.start}px)`;
    } else {
      style.left = `${left}px`;
      style.top = `${top + container.clientHeight}px`;
      style.width = `${viewport}px`;
      thumb.width = `${metrics.size}px`;
      thumb.transform = `translateX(${TRACK_INSET + metrics.start}px)`;
    }
    // カーソルの下にある領域は手前にあると分かっている。スクロールだけで出すときは、
    // 上にほかの要素が重なっていないかを確かめる。
    const visible =
      hovered.has(container) ||
      drag?.bar === bar ||
      (vertical
        ? exposed(
            bar,
            left + container.clientWidth - 6,
            top + TRACK_INSET + metrics.start + metrics.size / 2,
          )
        : exposed(
            bar,
            left + TRACK_INSET + metrics.start + metrics.size / 2,
            top + container.clientHeight - 6,
          ));
    if (visible) bar.element.dataset.visible = "";
    else delete bar.element.dataset.visible;
  };

  function update() {
    const active = new Set<HTMLElement>([...hovered, ...scrolling.keys()]);
    if (drag) active.add(drag.bar.container);
    for (const container of new Set([...active, ...bars.keys()])) {
      if (!container.isConnected) {
        const entry = bars.get(container);
        entry?.x?.element.remove();
        entry?.y?.element.remove();
        bars.delete(container);
        hovered.delete(container);
        continue;
      }
      const wanted = active.has(container);
      place(container, "y", wanted);
      place(container, "x", wanted);
    }
  }

  const onPointerOver = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    // バーの上にいる間は、そのバーの持ち主の中にいるものとして扱う。
    let node: Element | null =
      overlayScrollbarOwner(event.target) ??
      (event.target instanceof Element ? event.target : null);
    const next = new Set<HTMLElement>();
    for (; node; node = node.parentElement) {
      if (isScroller(node)) next.add(node);
    }
    hovered = next;
    update();
  };
  const onPointerLeave = () => {
    hovered = new Set();
    update();
  };
  const onScroll = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (!bars.has(target) && !isScroller(target)) return;
    const timer = scrolling.get(target);
    if (timer) clearTimeout(timer);
    scrolling.set(
      target,
      setTimeout(() => {
        scrolling.delete(target);
        update();
      }, SCROLLBAR_HIDE_DELAY),
    );
    update();
  };

  // scroll は親へ伝わらないので、伝わる前 (capture) に受け取る。
  document.addEventListener("scroll", onScroll, {
    capture: true,
    passive: true,
  });
  document.addEventListener("pointerover", onPointerOver, { passive: true });
  root.addEventListener("pointerleave", onPointerLeave);
  window.addEventListener("resize", update);
  const interval = setInterval(() => {
    if (hovered.size > 0 || scrolling.size > 0 || bars.size > 0) update();
  }, REFRESH_INTERVAL);

  return () => {
    clearInterval(interval);
    document.removeEventListener("scroll", onScroll, { capture: true });
    document.removeEventListener("pointerover", onPointerOver);
    root.removeEventListener("pointerleave", onPointerLeave);
    window.removeEventListener("resize", update);
    for (const timer of scrolling.values()) clearTimeout(timer);
    for (const entry of bars.values()) {
      entry.x?.element.remove();
      entry.y?.element.remove();
    }
    bars.clear();
    root.removeAttribute(ENABLED_ATTRIBUTE);
  };
}
