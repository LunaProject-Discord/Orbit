"use client";

import { cn } from "cn";
import { ClockIcon, SearchIcon, XIcon } from "lucide-react";
import {
  type KeyboardEvent,
  memo,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { layoutPickerRows, type PickerRow } from "@/lib/picker";

/** 1 個分のマスの大きさ (rem)。Tailwind の size-9 に合わせる。 */
const CELL_REM = 2.25;
/** 見出しの行の高さ (rem)。Tailwind の h-7 に合わせる。 */
const HEADING_REM = 1.75;
/** 見えている範囲の上下に、余分に描いておく行数。 */
const OVERSCAN = 4;
const RECENT_SECTION = "recent";
const SEARCH_SECTION = "search";

/** 一覧に出すもの。アイコンや絵文字など、選ぶものの種類ごとに用意する。 */
export type PickerSource = {
  /** 分類のタブ。id は sections の id と揃える。 */
  tabs: readonly { id: string; label: string; icon: ReactNode }[];
  /** 分類ごとの中身 (id の並び)。 */
  sections: readonly { id: string; label: string; items: readonly string[] }[];
  has: (id: string) => boolean;
  /** 探す言葉に合うものの id を、合い方の良い順に返す。 */
  search: (query: string) => string[];
  /** マスの中に描くもの。 */
  render: (id: string) => ReactNode;
  /** 名前 (下部の表示と読み上げ用)。 */
  label: (id: string) => string;
};

/**
 * 絵文字を選ぶ画面のような一覧。検索欄、分類のタブ、最近使ったもの、
 * 分類ごとの見出し付きの一覧、下部のプレビューを持つ。
 * 行の高さが決まっているので、見えている行だけを描く。
 *
 * スクロール・カーソルの移動・矢印キーは続けて何度も起きるので、そのたびに全体を
 * 描き直さないようにしている: 行とタブは中身が変わったものだけを描き直し、
 * カーソルを置いたものの名前は下部の表示だけに伝え、スクロールは見えている行が
 * 変わったときだけ反映する。
 * 検索欄にフォーカスを置いたまま、矢印キーと Enter で選べる。
 */
export function PickerGrid({
  source,
  failed,
  onRetry,
  value,
  recent,
  inputRef,
  searchLabel,
  placeholder,
  listLabel,
  emptyHint,
  emptyLabel,
  emptyPreview,
  currentClass,
  actions,
  onChoose,
}: {
  /** 選ぶものの一覧。読み込み中は null。 */
  source: PickerSource | null;
  /** 読み込みに失敗した。 */
  failed: boolean;
  onRetry: () => void;
  /** いま選んでいるものの id。無ければ null。 */
  value: string | null;
  /** 最近使ったものの id (新しい順)。 */
  recent: readonly string[];
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** 検索欄の名前 (読み上げ用)。 */
  searchLabel: string;
  placeholder: string;
  /** 一覧の名前 (読み上げ用)。 */
  listLabel: string;
  /** 探しても見つからなかったときに添える一言。 */
  emptyHint?: string;
  /** 何も選んでいないときに、下部に出す言葉と絵。 */
  emptyLabel?: string;
  emptyPreview?: ReactNode;
  /** いま選んでいるものに付けるクラス。 */
  currentClass?: string;
  /** 下部の右側に置くボタンなど。 */
  actions?: ReactNode;
  onChoose: (id: string) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  /** キーボードで選んでいるアイコンの位置。-1 なら、まだ選んでいない。 */
  const [active, setActive] = useState(-1);
  /** カーソルを置いているものの id。下部の表示だけが使う。 */
  const hover = useMemo(createHoverStore, []);
  const [scrollTop, setScrollTop] = useState(0);
  /** scrollTop を反映したときの、いちばん上に見えていた行。 */
  const topRow = useRef(0);
  // 入力は止めずに、一覧の作り直し (検索) は手が空いたときに行う。
  const deferredQuery = useDeferredValue(query);
  const [box, setBox] = useState({ width: 0, height: 0, rem: 16 });
  /** 検索をやめた後に、位置を合わせる分類。 */
  const [pendingSection, setPendingSection] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  // マスの大きさは文字の大きさの設定で変わるので、実際の幅から列数を決める。
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => {
      const rem = Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      setBox((previous) => {
        const next = {
          width: element.clientWidth,
          height: element.clientHeight,
          rem: Number.isFinite(rem) && rem > 0 ? rem : 16,
        };
        return previous.width === next.width &&
          previous.height === next.height &&
          previous.rem === next.rem
          ? previous
          : next;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const cell = CELL_REM * box.rem;
  const heading = HEADING_REM * box.rem;
  // 左右の余白 (px-2) を除いた幅に、入るだけ並べる。
  const columns = Math.max(1, Math.floor((box.width - box.rem) / cell));
  const searching = deferredQuery.trim() !== "";

  const layout = useMemo(() => {
    if (!source) return null;
    const sections = searching
      ? [
          {
            id: SEARCH_SECTION,
            label: "検索結果",
            items: source.search(deferredQuery),
          },
        ]
      : [
          {
            id: RECENT_SECTION,
            label: "最近使ったもの",
            items: recent.filter((item) => source.has(item)),
          },
          ...source.sections,
        ];
    const { rows, count } = layoutPickerRows(sections, columns);
    // 行の上端の位置と、アイコンの位置 → 行の対応。
    const tops: number[] = [];
    const rowOf: number[] = [];
    const names: string[] = [];
    const headingRow = new Map<string, number>();
    let top = 0;
    rows.forEach((row, index) => {
      tops.push(top);
      if (row.kind === "heading") {
        headingRow.set(row.section, index);
        top += heading;
      } else {
        for (const name of row.names) {
          rowOf.push(index);
          names.push(name);
        }
        top += cell;
      }
    });
    return { rows, count, tops, rowOf, names, headingRow, height: top };
  }, [source, searching, deferredQuery, recent, columns, cell, heading]);

  // 見えている範囲の行だけを描く。
  let first = 0;
  let last = -1;
  if (layout && layout.rows.length > 0) {
    const { tops, rows } = layout;
    const low = rowAt(tops, scrollTop);
    topRow.current = low;
    first = Math.max(0, low - OVERSCAN);
    last = low;
    while (last < rows.length - 1 && tops[last + 1] < scrollTop + box.height) {
      last += 1;
    }
    last = Math.min(rows.length - 1, last + OVERSCAN);
  }
  // いちばん上に見えている行が属する分類。
  const currentSection = (() => {
    if (!layout || searching) return null;
    const { tops, rows } = layout;
    for (let index = first; index <= last; index += 1) {
      const size = rows[index].kind === "heading" ? heading : cell;
      if (tops[index] + size > scrollTop + 1) return rows[index].section;
    }
    return null;
  })();

  // 選んでいる分類のタブが隠れていたら、見える位置まで横に送る。
  useEffect(() => {
    const tabs = tabsRef.current;
    if (!tabs || !currentSection) return;
    const tab = tabs.querySelector<HTMLElement>(
      `[data-section="${CSS.escape(currentSection)}"]`,
    );
    if (!tab) return;
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < tabs.scrollLeft) tabs.scrollLeft = left;
    else if (right > tabs.scrollLeft + tabs.clientWidth) {
      tabs.scrollLeft = right - tabs.clientWidth;
    }
  }, [currentSection]);

  // タブの列は横にしか動かないので、縦のホイールでも横に送れるようにする。
  useEffect(() => {
    const tabs = tabsRef.current;
    if (!tabs) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0 || event.ctrlKey) return;
      event.preventDefault();
      tabs.scrollLeft += event.deltaY;
    };
    tabs.addEventListener("wheel", onWheel, { passive: false });
    return () => tabs.removeEventListener("wheel", onWheel);
  }, []);

  // スクロールのたびではなく、いちばん上に見えている行が変わったときだけ描き直す
  // (上下に余分な行を描いてあるので、その間は描いてある行だけで足りる)。
  const onScroll = () => {
    const element = scrollRef.current;
    if (!element || !layout) return;
    if (rowAt(layout.tops, element.scrollTop) !== topRow.current) {
      setScrollTop(element.scrollTop);
    }
  };

  const scrollTo = (top: number) => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = top;
    setScrollTop(element.scrollTop);
  };

  const changeQuery = (next: string) => {
    setQuery(next);
    setActive(-1);
    scrollTo(0);
  };

  const jumpTo = (section: string) => {
    if (searching || query.trim() !== "") {
      // 検索をやめて分類の一覧に戻す。並びが変わるので、位置は描き直した後に合わせる。
      setQuery("");
      setActive(-1);
      setPendingSection(section);
      return;
    }
    const row = layout?.headingRow.get(section);
    if (row !== undefined && layout) scrollTo(layout.tops[row]);
  };
  useLayoutEffect(() => {
    if (pendingSection === null || !layout || searching) return;
    const row = layout.headingRow.get(pendingSection);
    setPendingSection(null);
    if (row === undefined) return;
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = layout.tops[row];
    setScrollTop(element.scrollTop);
  }, [pendingSection, layout, searching]);

  const moveTo = (index: number) => {
    if (!layout) return;
    setActive(index);
    if (index < 0) return;
    // 選んだアイコンの行が見える位置まで送る。
    const row = layout.rowOf[index];
    const top = layout.tops[row];
    const element = scrollRef.current;
    if (!element) return;
    // 最初の行に移ったときは、その見出しも見えるようにする。
    const above = layout.rows[row - 1]?.kind === "heading" ? heading : 0;
    if (top - above < element.scrollTop) scrollTo(top - above);
    else if (top + cell > element.scrollTop + element.clientHeight) {
      scrollTo(top + cell - element.clientHeight);
    }
  };

  /** 上下の行の、同じ列 (無ければその行の端) のアイコンの位置。無ければ -1。 */
  const verticalNeighbor = (index: number, step: 1 | -1) => {
    if (!layout) return -1;
    const { rows, rowOf } = layout;
    const row = rows[rowOf[index]];
    if (row.kind !== "items") return -1;
    const column = index - row.offset;
    for (
      let next = rowOf[index] + step;
      next >= 0 && next < rows.length;
      next += step
    ) {
      const candidate = rows[next];
      if (candidate.kind === "items") {
        return candidate.offset + Math.min(column, candidate.names.length - 1);
      }
    }
    return -1;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || !layout || layout.count === 0) return;
    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        if (active < 0) moveTo(0);
        else {
          const next = verticalNeighbor(active, 1);
          if (next >= 0) moveTo(next);
        }
        break;
      }
      case "ArrowUp": {
        if (active < 0) return;
        event.preventDefault();
        // いちばん上の行からは、検索欄に戻る。
        moveTo(verticalNeighbor(active, -1));
        break;
      }
      case "ArrowRight": {
        if (active < 0) return;
        event.preventDefault();
        moveTo(Math.min(layout.count - 1, active + 1));
        break;
      }
      case "ArrowLeft": {
        if (active < 0) return;
        event.preventDefault();
        moveTo(Math.max(0, active - 1));
        break;
      }
      case "Enter": {
        // 探している途中なら、選んでいなくても先頭の結果を選ぶ。
        const chosen =
          active >= 0
            ? layout.names[active]
            : query.trim() !== ""
              ? // 一覧の作り直しが入力に追い付いていなくても、いまの言葉で探した先頭を選ぶ。
                query === deferredQuery
                ? layout.names[0]
                : source?.search(query)[0]
              : undefined;
        if (chosen === undefined) return;
        event.preventDefault();
        onChoose(chosen);
        break;
      }
    }
  };

  const hasRecent = source ? recent.some((item) => source.has(item)) : false;
  const tabs = useMemo<PickerSource["tabs"]>(
    () =>
      source
        ? [
            ...(hasRecent
              ? [
                  {
                    id: RECENT_SECTION,
                    label: "最近使ったもの",
                    icon: <ClockIcon aria-hidden="true" />,
                  },
                ]
              : []),
            ...source.tabs,
          ]
        : [],
    [source, hasRecent],
  );

  // 行とタブに渡す関数は、描き直しても同じものにする (中身は毎回いまのものを呼ぶ)。
  const latest = useRef({ jumpTo, onChoose });
  latest.current = { jumpTo, onChoose };
  const jump = useCallback(
    (section: string) => latest.current.jumpTo(section),
    [],
  );
  const choose = useCallback(
    (item: string) => latest.current.onChoose(item),
    [],
  );
  // カーソルを置いたものは、マスごとではなく一覧全体で 1 か所で受ける。
  const onPointerOver = (event: PointerEvent<HTMLDivElement>) => {
    const item = (event.target as Element).closest?.("[data-item]");
    if (item) hover.set(item.getAttribute("data-item"));
  };
  const activeItem = active >= 0 ? (layout?.names[active] ?? null) : null;

  return (
    <>
      <div className="flex flex-col gap-1.5 border-b p-2">
        <div className="relative">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label={searchLabel}
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={
              active >= 0 ? `${id}-icon-${active}` : undefined
            }
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
            onKeyDown={onKeyDown}
            className="h-8 w-full min-w-0 rounded-md border border-input bg-transparent pr-8 pl-8 text-base outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
          />
          {query !== "" && (
            <Hint label="検索をやめる">
              <button
                type="button"
                aria-label="検索をやめる"
                onClick={() => {
                  changeQuery("");
                  inputRef.current?.focus();
                }}
                className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <XIcon className="size-3.5" aria-hidden="true" />
              </button>
            </Hint>
          )}
        </div>
        <div
          ref={tabsRef}
          role="toolbar"
          aria-label="分類"
          className="relative flex gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <PickerTabs tabs={tabs} current={currentSection} onJump={jump} />
          {!source && <div className="h-7" />}
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        onPointerOver={onPointerOver}
        onPointerLeave={() => hover.set(null)}
        className="relative min-h-24 flex-1 basis-72 overflow-y-auto overscroll-contain"
      >
        {!layout ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-muted-foreground text-xs">
            {failed ? (
              <>
                <p role="alert">読み込めませんでした。</p>
                <Button variant="outline" size="xs" onClick={onRetry}>
                  もう一度試す
                </Button>
              </>
            ) : (
              <output>読み込み中…</output>
            )}
          </div>
        ) : layout.count === 0 ? (
          <output className="flex h-full items-center justify-center p-4 text-center text-muted-foreground text-xs">
            「{query.trim()}」に合うものは見つかりませんでした。
            {emptyHint && (
              <>
                <br />
                {emptyHint}
              </>
            )}
          </output>
        ) : (
          <div
            id={`${id}-list`}
            role="listbox"
            aria-label={listLabel}
            className="relative"
            style={{ height: layout.height }}
          >
            {layout.rows.slice(first, last + 1).map((row, offset) => {
              const index = first + offset;
              return (
                <PickerRowView
                  key={
                    row.kind === "heading"
                      ? `heading-${row.section}`
                      : `items-${row.offset}`
                  }
                  id={id}
                  row={row}
                  top={layout.tops[index]}
                  count={
                    row.kind === "heading" && row.section === SEARCH_SECTION
                      ? layout.count
                      : null
                  }
                  source={source}
                  // 行の中に無ければ変わらない値にして、関係のない行を描き直さない。
                  value={
                    row.kind === "items" &&
                    value !== null &&
                    row.names.includes(value)
                      ? value
                      : null
                  }
                  active={
                    row.kind === "items" &&
                    active >= row.offset &&
                    active < row.offset + row.names.length
                      ? active
                      : -1
                  }
                  currentClass={currentClass}
                  onChoose={choose}
                />
              );
            })}
          </div>
        )}
      </div>

      <div className="flex h-11 shrink-0 items-center gap-2 border-t px-2">
        <PickerPreview
          hover={hover}
          fallback={activeItem ?? value}
          value={value}
          source={source}
          currentClass={currentClass}
          emptyLabel={emptyLabel}
          emptyPreview={emptyPreview}
        />
        {actions}
      </div>
    </>
  );
}

/** tops (行の上端の位置) の中で、位置 top にある行の番号。 */
function rowAt(tops: readonly number[], top: number): number {
  let low = 0;
  let high = tops.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (tops[middle] <= top) low = middle;
    else high = middle - 1;
  }
  return low;
}

type HoverStore = {
  get: () => string | null;
  set: (item: string | null) => void;
  subscribe: (listener: () => void) => () => void;
};

/** カーソルを置いているものを、下部の表示だけに伝えるための入れ物。 */
function createHoverStore(): HoverStore {
  let current: string | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (item) => {
      if (item === current) return;
      current = item;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** 下部の表示。カーソルを置いたもの (無ければ fallback) の絵と名前を出す。 */
function PickerPreview({
  hover,
  fallback,
  value,
  source,
  currentClass,
  emptyLabel,
  emptyPreview,
}: {
  hover: HoverStore;
  fallback: string | null;
  value: string | null;
  source: PickerSource | null;
  currentClass?: string;
  emptyLabel?: string;
  emptyPreview?: ReactNode;
}) {
  const hovered = useSyncExternalStore(hover.subscribe, hover.get, () => null);
  const shown = hovered ?? fallback;
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "flex size-6 shrink-0 items-center justify-center text-xl leading-none [&_svg]:size-6",
          shown !== null && shown === value && currentClass,
        )}
      >
        {shown !== null && source ? source.render(shown) : emptyPreview}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs" aria-live="polite">
        {shown !== null && source ? source.label(shown) : emptyLabel}
      </span>
    </>
  );
}

/** 分類のタブ。選んでいる分類が変わったときだけ描き直す。 */
const PickerTabs = memo(function PickerTabs({
  tabs,
  current,
  onJump,
}: {
  tabs: PickerSource["tabs"];
  current: string | null;
  onJump: (section: string) => void;
}) {
  return tabs.map((tab) => {
    const selected = tab.id === current;
    return (
      <Hint key={tab.id} label={tab.label}>
        <button
          type="button"
          data-section={tab.id}
          aria-label={tab.label}
          aria-pressed={selected}
          tabIndex={-1}
          // 押しても検索欄からフォーカスを移さない (キーボードで続けて選べるように)。
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onJump(tab.id)}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-4",
            selected && "bg-muted text-foreground",
          )}
        >
          {tab.icon}
        </button>
      </Hint>
    );
  });
});

/**
 * 一覧の 1 行。スクロールや矢印キーで関係のない行まで描き直さないよう、memo にしている。
 * マスの名前は下部の表示に出すので、マスごとのツールチップは付けない
 * (見えているマスの数だけツールチップを作ると、描き直しが重くなる)。
 */
const PickerRowView = memo(function PickerRowView({
  id,
  row,
  top,
  count,
  source,
  value,
  active,
  currentClass,
  onChoose,
}: {
  id: string;
  row: PickerRow;
  top: number;
  /** 見出しに添える件数。出さないなら null。 */
  count: number | null;
  source: PickerSource | null;
  /** いま選んでいるもの。この行に無ければ null。 */
  value: string | null;
  /** キーボードで選んでいる位置。この行に無ければ -1。 */
  active: number;
  currentClass?: string;
  onChoose: (name: string) => void;
}) {
  if (row.kind === "heading") {
    return (
      <div
        role="presentation"
        className="absolute inset-x-0 flex h-7 items-end px-3 pb-1 font-medium text-muted-foreground text-xs"
        style={{ top }}
      >
        {row.label}
        {count !== null && ` (${count.toLocaleString("ja-JP")} 件)`}
      </div>
    );
  }
  return (
    <div
      role="presentation"
      className="absolute inset-x-0 flex h-9 px-2"
      style={{ top }}
    >
      {row.names.map((name, column) => {
        const index = row.offset + column;
        const label = source?.label(name) ?? name;
        const current = name === value;
        return (
          <button
            key={name}
            type="button"
            role="option"
            id={`${id}-icon-${index}`}
            data-item={name}
            aria-selected={index === active}
            aria-label={label}
            tabIndex={-1}
            onClick={() => onChoose(name)}
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-md text-foreground/80 text-xl leading-none outline-none hover:bg-muted hover:text-foreground [&_svg]:size-5",
              current && cn("bg-muted", currentClass),
              index === active && "bg-muted ring-2 ring-ring ring-inset",
            )}
          >
            {source?.render(name)}
          </button>
        );
      })}
    </div>
  );
});
