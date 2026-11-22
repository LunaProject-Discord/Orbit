"use client";

import { cn } from "cn";
import {
  CarIcon,
  FlagIcon,
  LeafIcon,
  LightbulbIcon,
  type LucideIcon,
  ShapesIcon,
  SmileIcon,
  SmilePlusIcon,
  TrophyIcon,
  UserIcon,
  UtensilsIcon,
} from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Hint } from "@/components/hint";
import { PickerGrid, type PickerSource } from "@/components/picker-grid";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  EMOJI_FONT_FAMILY,
  type EmojiCatalog,
  loadEmojiCatalog,
  RECENT_EMOJIS_KEY,
  readSkinTone,
  SKIN_TONES,
  type SkinTone,
  saveSkinTone,
  searchEmojis,
  withSkinTone,
} from "@/lib/emoji/emoji";
import { addRecent, readRecent } from "@/lib/picker";

/** 分類のタブに出すアイコン。data.json の分類の key に対応する。 */
const GROUP_ICONS: Readonly<Record<string, LucideIcon>> = {
  "smileys-emotion": SmileIcon,
  "people-body": UserIcon,
  "animals-nature": LeafIcon,
  "food-drink": UtensilsIcon,
  "travel-places": CarIcon,
  activities: TrophyIcon,
  objects: LightbulbIcon,
  symbols: ShapesIcon,
  flags: FlagIcon,
};

/** 肌の色の見本に使う絵文字。 */
const TONE_SAMPLE = "✋";
const EMOJI_STYLE = { fontFamily: EMOJI_FONT_FAMILY };

/** ポップオーバーの中身の大きさ。アイコンを選ぶ画面と揃える。 */
export const PICKER_POPOVER_CLASS =
  "max-h-[min(28rem,var(--available-height))] w-[min(22rem,calc(100vw-1rem))] gap-0 p-0";

/**
 * 絵文字を選ぶ画面の中身 (ポップオーバーなどの中に置く)。
 * 全絵文字を、検索欄・分類・最近使ったもの・肌の色付きで選べる。
 */
export function EmojiPickerPanel({
  value = null,
  inputRef,
  actions,
  onChoose,
}: {
  /** いま選んでいる絵文字。無ければ null。 */
  value?: string | null;
  inputRef: RefObject<HTMLInputElement | null>;
  /** 下部の右側に、肌の色のボタンと並べて置くもの。 */
  actions?: ReactNode;
  onChoose: (emoji: string) => void;
}) {
  const [catalog, setCatalog] = useState<EmojiCatalog | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [recent] = useState(() => readRecent(RECENT_EMOJIS_KEY));
  const [tone, setTone] = useState<SkinTone>(readSkinTone);
  const [toneOpen, setToneOpen] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt は「もう一度試す」で読み込み直すための合図
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    loadEmojiCatalog()
      .then((loaded) => {
        if (!cancelled) setCatalog(loaded);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const source = useMemo<PickerSource | null>(() => {
    if (!catalog) return null;
    return {
      tabs: catalog.groups.map((group) => {
        const Icon = GROUP_ICONS[group.key] ?? SmileIcon;
        return {
          id: group.key,
          label: group.label,
          icon: <Icon aria-hidden="true" />,
        };
      }),
      sections: catalog.groups.map((group) => ({
        id: group.key,
        label: group.label,
        items: group.emojis,
      })),
      has: (emoji) => catalog.entries.has(emoji),
      search: (query) => searchEmojis(catalog, query),
      render: (emoji) => (
        <span style={EMOJI_STYLE}>{withSkinTone(catalog, emoji, tone)}</span>
      ),
      label: (emoji) => catalog.entries.get(emoji)?.label ?? emoji,
    };
  }, [catalog, tone]);

  const chooseTone = (next: SkinTone) => {
    setTone(next);
    saveSkinTone(next);
    setToneOpen(false);
    inputRef.current?.focus();
  };

  return (
    <PickerGrid
      source={source}
      failed={failed}
      onRetry={() => setAttempt((count) => count + 1)}
      // 肌の色を変えた絵文字を選んでいても、一覧では元の絵文字に印を付ける。
      value={value === null ? null : (catalog?.bases.get(value) ?? value)}
      recent={recent}
      inputRef={inputRef}
      searchLabel="絵文字を探す"
      placeholder="絵文字を探す (例: 笑顔、ねこ、rocket)"
      listLabel="絵文字"
      emptyLabel="絵文字を選んでください"
      onChoose={(emoji) => {
        addRecent(RECENT_EMOJIS_KEY, emoji);
        onChoose(catalog ? withSkinTone(catalog, emoji, tone) : emoji);
      }}
      actions={
        <>
          {toneOpen ? (
            <div
              role="radiogroup"
              aria-label="肌の色"
              className="flex shrink-0 items-center"
            >
              {SKIN_TONES.map((item) => (
                <Hint key={item.tone} label={item.label}>
                  {/* biome-ignore lint/a11y/useSemanticElements: 絵文字の見本をそのまま選択肢にするため、radio の役割を持つボタンにしている */}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={item.tone === tone}
                    aria-label={item.label}
                    onClick={() => chooseTone(item.tone)}
                    style={EMOJI_STYLE}
                    className={cn(
                      "flex size-7 items-center justify-center rounded-md text-base leading-none outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                      item.tone === tone && "bg-muted",
                    )}
                  >
                    {catalog
                      ? withSkinTone(catalog, TONE_SAMPLE, item.tone)
                      : TONE_SAMPLE}
                  </button>
                </Hint>
              ))}
            </div>
          ) : (
            <Hint label="肌の色を変える">
              <button
                type="button"
                aria-label="肌の色を変える"
                disabled={!catalog}
                onClick={() => setToneOpen(true)}
                style={EMOJI_STYLE}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-base leading-none outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {catalog
                  ? withSkinTone(catalog, TONE_SAMPLE, tone)
                  : TONE_SAMPLE}
              </button>
            </Hint>
          )}
          {!toneOpen && actions}
        </>
      }
    />
  );
}

/**
 * 絵文字を選ぶボタン。押すと絵文字を選ぶ画面が開き、選ぶと onSelect に渡して閉じる。
 * 文章の入力欄に絵文字を入れるために使う。
 */
export function EmojiPickerButton({
  onSelect,
  onOpen,
  disabled,
  label = "絵文字",
  size = "icon",
  className,
}: {
  onSelect: (emoji: string) => void;
  /** 開く直前に呼ぶ。入力欄のカーソルの位置を覚えておくために使う。 */
  onOpen?: () => void;
  disabled?: boolean;
  label?: string;
  size?: "icon" | "icon-sm" | "icon-xs";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) onOpen?.();
        setOpen(next);
      }}
    >
      <Hint label={label} side="top">
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size={size}
              aria-label={label}
              disabled={disabled}
              className={className}
            />
          }
        >
          <SmilePlusIcon />
        </PopoverTrigger>
      </Hint>
      <PopoverContent
        align="start"
        initialFocus={inputRef}
        // 閉じた後は、絵文字を入れた入力欄にフォーカスを置く (呼び出し側が移す)。
        finalFocus={false}
        className={PICKER_POPOVER_CLASS}
      >
        <PopoverTitle className="sr-only">絵文字を選ぶ</PopoverTitle>
        <EmojiPickerPanel
          inputRef={inputRef}
          onChoose={(emoji) => {
            setOpen(false);
            onSelect(emoji);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
