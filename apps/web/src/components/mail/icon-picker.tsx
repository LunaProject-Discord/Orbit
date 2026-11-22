"use client";

import { cn } from "cn";
import { ChevronDownIcon, ClockIcon, SearchIcon, XIcon } from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  addRecentIcon,
  type IconCatalog,
  type IconRow,
  layoutIconRows,
  loadIconCatalog,
  readRecentIcons,
  searchIcons,
} from "@/lib/lucide/catalog";
import {
  type IconNode,
  LucideSvg,
  loadIconNodes,
  useIconNode,
} from "@/lib/lucide/icons";

/** アイコン 1 個分のマスの大きさ (rem)。Tailwind の size-9 に合わせる。 */
const CELL_REM = 2.25;
/** 見出しの行の高さ (rem)。Tailwind の h-7 に合わせる。 */
const HEADING_REM = 1.75;
/** 見えている範囲の上下に、余分に描いておく行数。 */
const OVERSCAN = 4;
const RECENT_SECTION = "recent";
const SEARCH_SECTION = "search";

type IconData = {
  catalog: IconCatalog;
  nodes: Readonly<Record<string, IconNode>>;
};

/**
 * アイコンを選ぶボタン。押すと、絵文字を選ぶ画面のように、
 * 検索欄・分類・最近使ったもの付きで Lucide の全アイコンから選べる。
 */
export function IconPicker({
  value,
  onChange,
  labelledBy,
  colorClass,
  dotClass,
}: {
  /** 選んでいるアイコンの名前。null なら、アイコンなし (色の点)。 */
  value: string | null;
  onChange: (next: string | null) => void;
  /** このボタンの名前になる要素の id。 */
  labelledBy: string;
  /** 選んでいるアイコンに付ける文字色のクラス。 */
  colorClass?: string;
  /** アイコンなしのときに出す点の色のクラス。 */
  dotClass?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const node = useIconNode(value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            id={`${id}-trigger`}
            aria-labelledby={`${labelledBy} ${id}-trigger`}
            className="max-w-full justify-start gap-2 font-normal"
          />
        }
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex size-4 shrink-0 items-center justify-center",
            colorClass,
          )}
        >
          {node ? (
            <LucideSvg node={node} className="size-4" />
          ) : (
            <span className={cn("size-2 rounded-full", dotClass)} />
          )}
        </span>
        <span className="truncate">{value ?? "なし (色の点)"}</span>
        <ChevronDownIcon className="text-muted-foreground" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        initialFocus={inputRef}
        className="max-h-[min(28rem,var(--available-height))] w-[min(22rem,calc(100vw-1rem))] gap-0 p-0"
      >
        <PopoverTitle className="sr-only">アイコンを選ぶ</PopoverTitle>
        <IconPickerBody
          value={value}
          inputRef={inputRef}
          colorClass={colorClass}
          dotClass={dotClass}
          onChoose={(next) => {
            setOpen(false);
            if (next !== value) onChange(next);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function IconPickerBody({
  value,
  inputRef,
  colorClass,
  dotClass,
  onChoose,
}: {
  value: string | null;
  inputRef: React.RefObject<HTMLInputElement | null>;
  colorClass?: string;
  dotClass?: string;
  onChoose: (next: string | null) => void;
}) {
  const id = useId();
  const [data, setData] = useState<IconData | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [recent] = useState(readRecentIcons);
  /** キーボードで選んでいるアイコンの位置。-1 なら、まだ選んでいない。 */
  const [active, setActive] = useState(-1);
  /** カーソルを置いているアイコンの名前。 */
  const [hovered, setHovered] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [box, setBox] = useState({ width: 0, height: 0, rem: 16 });
  /** 検索をやめた後に、位置を合わせる分類。 */
  const [pendingSection, setPendingSection] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt は「再試行」で読み込み直すための合図
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    Promise.all([loadIconCatalog(), loadIconNodes()])
      .then(([catalog, nodes]) => {
        if (!cancelled) setData({ catalog, nodes });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

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
  const searching = query.trim() !== "";

  const layout = useMemo(() => {
    if (!data) return null;
    const { catalog } = data;
    const sections = searching
      ? [
          {
            id: SEARCH_SECTION,
            label: "検索結果",
            icons: searchIcons(catalog, query),
          },
        ]
      : [
          {
            id: RECENT_SECTION,
            label: "最近使ったもの",
            icons: recent.filter((name) => catalog.names.has(name)),
          },
          ...catalog.categories.map((category) => ({
            id: category.name,
            label: category.label,
            icons: category.icons,
          })),
        ];
    const { rows, count } = layoutIconRows(sections, columns);
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
  }, [data, searching, query, recent, columns, cell, heading]);

  // 見えている範囲の行だけを描く。
  let first = 0;
  let last = -1;
  if (layout && layout.rows.length > 0) {
    const { tops, rows } = layout;
    let low = 0;
    let high = rows.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (tops[middle] <= scrollTop) low = middle;
      else high = middle - 1;
    }
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
    if (searching) {
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
    if (row.kind !== "icons") return -1;
    const column = index - row.offset;
    for (
      let next = rowOf[index] + step;
      next >= 0 && next < rows.length;
      next += step
    ) {
      const candidate = rows[next];
      if (candidate.kind === "icons") {
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
        const index = active >= 0 ? active : searching ? 0 : -1;
        if (index < 0) return;
        event.preventDefault();
        choose(layout.names[index]);
        break;
      }
    }
  };

  const choose = (name: string | null) => {
    if (name !== null) addRecentIcon(name);
    onChoose(name);
  };

  const shown =
    hovered ?? (active >= 0 ? (layout?.names[active] ?? null) : value);
  const shownNode = shown ? data?.nodes[shown] : null;
  const tabs = data
    ? [
        ...(recent.some((name) => data.catalog.names.has(name))
          ? [{ id: RECENT_SECTION, label: "最近使ったもの", icon: null }]
          : []),
        ...data.catalog.categories.map((category) => ({
          id: category.name,
          label: category.label,
          icon: category.icon as string | null,
        })),
      ]
    : [];

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
            aria-label="アイコンを探す"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={
              active >= 0 ? `${id}-icon-${active}` : undefined
            }
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            placeholder="アイコンを探す (例: mail、家、動物)"
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
            onKeyDown={onKeyDown}
            className="h-8 w-full min-w-0 rounded-md border border-input bg-transparent pr-8 pl-8 text-base outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
          />
          {query !== "" && (
            <button
              type="button"
              aria-label="検索をやめる"
              title="検索をやめる"
              onClick={() => {
                changeQuery("");
                inputRef.current?.focus();
              }}
              className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <XIcon className="size-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
        <div
          ref={tabsRef}
          role="toolbar"
          aria-label="分類"
          className="relative flex gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tabs.map((tab) => {
            const node = tab.icon ? data?.nodes[tab.icon] : null;
            const selected = tab.id === currentSection;
            return (
              <button
                key={tab.id}
                type="button"
                data-section={tab.id}
                aria-label={tab.label}
                aria-pressed={selected}
                title={tab.label}
                tabIndex={-1}
                // 押しても検索欄からフォーカスを移さない (キーボードで続けて選べるように)。
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => jumpTo(tab.id)}
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-4",
                  selected && "bg-muted text-foreground",
                )}
              >
                {node ? (
                  <LucideSvg node={node} />
                ) : (
                  <ClockIcon aria-hidden="true" />
                )}
              </button>
            );
          })}
          {!data && <div className="h-7" />}
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onPointerLeave={() => setHovered(null)}
        className="relative min-h-24 flex-1 basis-72 overflow-y-auto overscroll-contain"
      >
        {!layout ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-muted-foreground text-xs">
            {failed ? (
              <>
                <p role="alert">アイコンを読み込めませんでした。</p>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => setAttempt((count) => count + 1)}
                >
                  もう一度試す
                </Button>
              </>
            ) : (
              <output>読み込み中…</output>
            )}
          </div>
        ) : layout.count === 0 ? (
          <output className="flex h-full items-center justify-center p-4 text-center text-muted-foreground text-xs">
            「{query.trim()}」に合うアイコンは見つかりませんでした。
            <br />
            英語の名前でもお試しください。
          </output>
        ) : (
          <div
            id={`${id}-list`}
            role="listbox"
            aria-label="アイコン"
            className="relative"
            style={{ height: layout.height }}
          >
            {layout.rows.slice(first, last + 1).map((row, offset) => {
              const index = first + offset;
              return (
                <IconRowView
                  key={
                    row.kind === "heading"
                      ? `heading-${row.section}`
                      : `icons-${row.offset}`
                  }
                  id={id}
                  row={row}
                  top={layout.tops[index]}
                  count={
                    row.kind === "heading" && row.section === SEARCH_SECTION
                      ? layout.count
                      : null
                  }
                  nodes={data?.nodes ?? {}}
                  value={value}
                  active={active}
                  colorClass={colorClass}
                  onChoose={choose}
                  onHover={setHovered}
                />
              );
            })}
          </div>
        )}
      </div>

      <div className="flex h-11 shrink-0 items-center gap-2 border-t px-2">
        <span
          aria-hidden="true"
          className={cn(
            "flex size-6 shrink-0 items-center justify-center",
            shown === value && colorClass,
          )}
        >
          {shownNode ? (
            <LucideSvg node={shownNode} className="size-6" />
          ) : (
            <span
              className={cn(
                "size-2.5 rounded-full",
                dotClass ?? "bg-muted-foreground/60",
              )}
            />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs" aria-live="polite">
          {shown ?? "アイコンなし (色の点)"}
        </span>
        <Button
          variant="ghost"
          size="xs"
          disabled={value === null}
          onClick={() => choose(null)}
        >
          アイコンを外す
        </Button>
      </div>
    </>
  );
}

function IconRowView({
  id,
  row,
  top,
  count,
  nodes,
  value,
  active,
  colorClass,
  onChoose,
  onHover,
}: {
  id: string;
  row: IconRow;
  top: number;
  /** 見出しに添える件数。出さないなら null。 */
  count: number | null;
  nodes: Readonly<Record<string, IconNode>>;
  value: string | null;
  active: number;
  colorClass?: string;
  onChoose: (name: string) => void;
  onHover: (name: string | null) => void;
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
        const node = nodes[name];
        const current = name === value;
        return (
          <button
            key={name}
            type="button"
            role="option"
            id={`${id}-icon-${index}`}
            aria-selected={index === active}
            aria-label={name}
            title={name}
            tabIndex={-1}
            onClick={() => onChoose(name)}
            onPointerEnter={() => onHover(name)}
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-md text-foreground/80 outline-none hover:bg-muted hover:text-foreground [&_svg]:size-5",
              current && cn("bg-muted", colorClass),
              index === active && "bg-muted ring-2 ring-ring ring-inset",
            )}
          >
            {node && <LucideSvg node={node} />}
          </button>
        );
      })}
    </div>
  );
}
