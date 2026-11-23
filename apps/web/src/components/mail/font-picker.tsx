"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "cn";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNarrowScreen } from "@/components/ui/menu-sheet";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  type LocalFont,
  loadLocalFonts,
  searchFonts,
  useFontListSupport,
  useLocalFonts,
} from "@/lib/local-fonts";
import { cleanFontName } from "@/lib/preferences";

const ROW_HEIGHT = 34;
/** スマホ幅のシートでは、指で押しやすい高さにする。 */
const NARROW_ROW_HEIGHT = 44;

type Row =
  | { kind: "empty" }
  | { kind: "typed"; family: string }
  | { kind: "font"; font: LocalFont };

/**
 * この端末に入っているフォントから 1 つ選ぶボタン。押すと、検索欄付きの一覧が開く。
 * 一覧は開いたときに取る (ブラウザーでは、このとき許可を尋ねることがある)。
 * 許可されなかったときは、検索欄に入力した名前をそのまま使える。
 */
export function FontPicker({
  value,
  onChange,
  labelledBy,
  emptyLabel,
  monospaceFirst = false,
}: {
  /** 選んでいるフォントの名前。空なら未指定。 */
  value: string;
  onChange: (next: string) => void;
  /** このボタンの名前になる要素の id。 */
  labelledBy: string;
  /** 未指定を表す選択肢の名前。 */
  emptyLabel: string;
  /** 等幅のフォントを先に並べる (等幅かどうかが分かる環境だけ)。 */
  monospaceFirst?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const { status, fonts } = useLocalFonts();
  // Android アプリでは、フォントはファイルを読み込んで使うので、一覧に無い名前は指定できない。
  const canType = useFontListSupport() !== "native";
  // 一覧の枠は開いてから描かれるので、描かれたときに並べ直せるよう state で持つ。
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
    null,
  );

  const rows = useMemo<Row[]>(() => {
    const found = searchFonts(fonts, query);
    const ordered = monospaceFirst
      ? [
          ...found.filter((font) => font.monospace === true),
          ...found.filter((font) => font.monospace !== true),
        ]
      : found;
    const result: Row[] = [];
    if (!query.trim()) result.push({ kind: "empty" });
    // 一覧に無い名前でも、入力した名前をそのまま使える
    // (一覧を取れなかったときや、あとから入れるフォントのため)。
    const typed = cleanFontName(query);
    if (
      canType &&
      typed &&
      !fonts.some((font) => font.family.toLowerCase() === typed.toLowerCase())
    ) {
      result.push({ kind: "typed", family: typed });
    }
    for (const font of ordered) result.push({ kind: "font", font });
    return result;
  }, [fonts, query, monospaceFirst, canType]);

  const rowHeight = useNarrowScreen() ? NARROW_ROW_HEIGHT : ROW_HEIGHT;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => rowHeight,
    overscan: 8,
  });

  // 開いたときは、いま選んでいるフォントの位置から見せる。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 開いたときと一覧が届いたときだけ合わせる
  useEffect(() => {
    if (!open) return;
    const index = rows.findIndex(
      (row) => row.kind === "font" && row.font.family === value,
    );
    const next = Math.max(index, 0);
    setActive(next);
    // 一覧の枠が描かれてから動かす。
    const frame = requestAnimationFrame(() =>
      virtualizer.scrollToIndex(next, { align: "center" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [open, status, scrollElement]);

  const choose = (next: string) => {
    setOpen(false);
    if (next !== value) onChange(next);
  };
  const chooseRow = (row: Row | undefined) => {
    if (!row) return;
    choose(
      row.kind === "empty"
        ? ""
        : row.kind === "typed"
          ? row.family
          : row.font.family,
    );
  };
  const move = (next: number) => {
    const index = Math.max(0, Math.min(next, rows.length - 1));
    setActive(index);
    virtualizer.scrollToIndex(index);
  };

  const selected = fonts.find((font) => font.family === value);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setQuery("");
          // ボタンを押した操作の中で呼ぶ (ブラウザーが許可を尋ねられるのは、このときだけ)。
          void loadLocalFonts();
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            id={`${id}-trigger`}
            aria-labelledby={`${labelledBy} ${id}-trigger`}
            className="w-56 max-w-full justify-between gap-2 font-normal"
          />
        }
      >
        <span
          className={cn("truncate", !value && "text-muted-foreground")}
          style={value ? { fontFamily: `"${value}"` } : undefined}
        >
          {value ? (selected?.label ?? value) : emptyLabel}
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        initialFocus={inputRef}
        className="w-80 max-w-[calc(100vw-1rem)]"
      >
        <PopoverTitle className="sm:sr-only">フォントを選ぶ</PopoverTitle>
        <Input
          ref={inputRef}
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={
            rows.length > 0 ? `${id}-row-${active}` : undefined
          }
          aria-label="フォントを検索"
          autoComplete="off"
          spellCheck={false}
          maxLength={100}
          placeholder="フォントの名前で検索"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            virtualizer.scrollToOffset(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              move(active + 1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              move(active - 1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              chooseRow(rows[active]);
            }
          }}
          className="h-8"
        />
        {status === "loading" && (
          <p className="text-muted-foreground text-xs">
            フォントの一覧を読み込んでいます…
          </p>
        )}
        {status === "denied" && (
          <p className="text-muted-foreground text-xs leading-relaxed">
            フォントの一覧を見る許可がありません。ブラウザーのサイトの設定で「フォント」を許可すると、一覧から選べます。名前を入力して指定することもできます。
          </p>
        )}
        {status === "error" && (
          <p className="text-muted-foreground text-xs leading-relaxed">
            フォントの一覧を取得できませんでした。
            {canType && "名前を入力して指定できます。"}
          </p>
        )}
        <div
          ref={setScrollElement}
          id={`${id}-list`}
          role="listbox"
          aria-label="フォント"
          className="-mx-1 max-h-72 overflow-y-auto px-1"
        >
          <div
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              const family =
                row.kind === "empty"
                  ? ""
                  : row.kind === "typed"
                    ? row.family
                    : row.font.family;
              const isSelected = family === value;
              return (
                <button
                  key={item.key}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  id={`${id}-row-${item.index}`}
                  aria-selected={isSelected}
                  onClick={() => chooseRow(row)}
                  onPointerMove={() => setActive(item.index)}
                  className={cn(
                    "absolute left-0 flex w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none max-sm:text-base",
                    item.index === active && "bg-accent text-accent-foreground",
                  )}
                  style={{
                    top: item.start,
                    height: rowHeight,
                  }}
                >
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      row.kind === "empty" && "text-muted-foreground",
                    )}
                    style={family ? { fontFamily: `"${family}"` } : undefined}
                  >
                    {row.kind === "empty"
                      ? emptyLabel
                      : row.kind === "typed"
                        ? `「${row.family}」を使う`
                        : row.font.label}
                  </span>
                  {isSelected && (
                    <CheckIcon aria-hidden="true" className="size-4 shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
