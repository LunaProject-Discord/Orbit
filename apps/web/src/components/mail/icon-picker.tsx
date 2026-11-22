"use client";

import { cn } from "cn";
import { ChevronDownIcon } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  EmojiPickerPanel,
  PICKER_POPOVER_CLASS,
} from "@/components/emoji-picker";
import { PickerGrid, type PickerSource } from "@/components/picker-grid";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { EMOJI_FONT_FAMILY, isEmojiIcon } from "@/lib/emoji/emoji";
import {
  type IconCatalog,
  loadIconCatalog,
  RECENT_ICONS_KEY,
  searchIcons,
} from "@/lib/lucide/catalog";
import {
  type IconNode,
  LucideSvg,
  loadIconNodes,
  useIconNode,
} from "@/lib/lucide/icons";
import { addRecent, readRecent } from "@/lib/picker";

type Mode = "icon" | "emoji";
const MODES: readonly { mode: Mode; label: string }[] = [
  { mode: "icon", label: "アイコン" },
  { mode: "emoji", label: "絵文字" },
];

/**
 * アカウントのアイコンを選ぶボタン。押すと、絵文字を選ぶ画面のように、
 * 検索欄・分類・最近使ったもの付きで、Lucide の全アイコンか全絵文字から選べる。
 */
export function IconPicker({
  value,
  onChange,
  labelledBy,
  colorClass,
  dotClass,
  colorStyle,
}: {
  /** 選んでいるアイコンの名前か絵文字。null なら、アイコンなし (色の点)。 */
  value: string | null;
  onChange: (next: string | null) => void;
  /** このボタンの名前になる要素の id。 */
  labelledBy: string;
  /** 選んでいるアイコンに付ける文字色のクラス。 */
  colorClass?: string;
  /** アイコンなしのときに出す点の色のクラス。 */
  dotClass?: string;
  /** 上の 2 つのクラスが CSS 変数を使うときの、変数の値。 */
  colorStyle?: CSSProperties;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const emoji = value !== null && isEmojiIcon(value) ? value : null;
  const [mode, setMode] = useState<Mode>(emoji ? "emoji" : "icon");
  const inputRef = useRef<HTMLInputElement>(null);
  const node = useIconNode(emoji ? null : value);

  const choose = (next: string | null) => {
    setOpen(false);
    if (next !== value) onChange(next);
  };
  const remove = (
    <Button
      variant="ghost"
      size="xs"
      disabled={value === null}
      onClick={() => choose(null)}
    >
      アイコンを外す
    </Button>
  );
  const dot = (
    <span
      className={cn(
        "size-2.5 rounded-full",
        dotClass ?? "bg-muted-foreground/60",
      )}
    />
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // 開くたびに、いま選んでいるものの側を出す。
        if (next) setMode(emoji ? "emoji" : "icon");
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
            style={colorStyle}
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
          {emoji ? (
            <span
              className="text-sm leading-none"
              style={{ fontFamily: EMOJI_FONT_FAMILY }}
            >
              {emoji}
            </span>
          ) : node ? (
            <LucideSvg node={node} className="size-4" />
          ) : (
            <span className={cn("size-2 rounded-full", dotClass)} />
          )}
        </span>
        <span className="truncate">
          {emoji ? "絵文字" : (value ?? "なし (色の点)")}
        </span>
        <ChevronDownIcon className="text-muted-foreground" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        initialFocus={inputRef}
        style={colorStyle}
        className={PICKER_POPOVER_CLASS}
      >
        <PopoverTitle className="sr-only">アイコンを選ぶ</PopoverTitle>
        <div
          role="tablist"
          aria-label="選ぶものの種類"
          className="flex shrink-0 gap-1 px-2 pt-2"
        >
          {MODES.map((item) => (
            <button
              key={item.mode}
              type="button"
              role="tab"
              aria-selected={mode === item.mode}
              onClick={() => {
                setMode(item.mode);
                // 中身が入れ替わった後に、検索欄へフォーカスを戻す。
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
              className={cn(
                "h-7 flex-1 rounded-md font-medium text-muted-foreground text-xs outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                mode === item.mode && "bg-muted text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        {mode === "icon" ? (
          <LucidePickerPanel
            value={emoji ? null : value}
            inputRef={inputRef}
            colorClass={colorClass}
            emptyPreview={dot}
            actions={remove}
            onChoose={choose}
          />
        ) : (
          <EmojiPickerPanel
            value={emoji}
            inputRef={inputRef}
            actions={remove}
            onChoose={choose}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Lucide の全アイコンから選ぶ画面の中身。 */
function LucidePickerPanel({
  value,
  inputRef,
  colorClass,
  emptyPreview,
  actions,
  onChoose,
}: {
  value: string | null;
  inputRef: RefObject<HTMLInputElement | null>;
  colorClass?: string;
  emptyPreview: ReactNode;
  actions: ReactNode;
  onChoose: (name: string) => void;
}) {
  const [data, setData] = useState<{
    catalog: IconCatalog;
    nodes: Readonly<Record<string, IconNode>>;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [recent] = useState(() => readRecent(RECENT_ICONS_KEY));

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt は「もう一度試す」で読み込み直すための合図
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

  const source = useMemo<PickerSource | null>(() => {
    if (!data) return null;
    const { catalog, nodes } = data;
    const render = (name: string) => {
      const node = nodes[name];
      return node ? <LucideSvg node={node} /> : null;
    };
    return {
      tabs: catalog.categories.map((category) => ({
        id: category.name,
        label: category.label,
        icon: render(category.icon),
      })),
      sections: catalog.categories.map((category) => ({
        id: category.name,
        label: category.label,
        items: category.icons,
      })),
      has: (name) => catalog.names.has(name),
      search: (query) => searchIcons(catalog, query),
      render,
      label: (name) => name,
    };
  }, [data]);

  return (
    <PickerGrid
      source={source}
      failed={failed}
      onRetry={() => setAttempt((count) => count + 1)}
      value={value}
      recent={recent}
      inputRef={inputRef}
      searchLabel="アイコンを探す"
      placeholder="アイコンを探す (例: mail、家、動物)"
      listLabel="アイコン"
      emptyHint="英語の名前でもお試しください。"
      emptyLabel="アイコンなし (色の点)"
      emptyPreview={emptyPreview}
      currentClass={colorClass}
      actions={actions}
      onChoose={(name) => {
        addRecent(RECENT_ICONS_KEY, name);
        onChoose(name);
      }}
    />
  );
}
