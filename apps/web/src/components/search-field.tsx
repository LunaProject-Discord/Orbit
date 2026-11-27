"use client";

import { cn } from "cn";
import { ArrowLeftIcon, SearchIcon, XIcon } from "lucide-react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";

/**
 * 検索欄の枠 (Mail と Calendar で共通の見た目)。Mail の検索欄 (components/mail/search-bar.tsx) も
 * ここの指定を使う。
 *
 * - "popup": ツールバーの右端に置く欄。高さ 32px、幅 176px (フォーカスで左へ広がる)。
 *   置き場所の枠 (@container/pane) が 48rem より狭いときは虫めがねだけを出し、押すと広がる。
 * - "screen": スマホの検索画面のアプリバー。左端に「←」、枠なし・高さ 40px の欄。
 */
export type SearchFieldVariant = "popup" | "screen";

/** いちばん外側 (<search>)。 */
export function searchRootClass(screen: boolean, className?: string): string {
  return cn(
    "min-w-0",
    // 狭い枠では虫めがねだけを出し、押したら左へ広げてツールバーに重ねる (Discord と同じ動き)。
    !screen && "relative h-8 w-8 shrink-0 @3xl/pane:w-44",
    className,
  );
}

/** 「←」と欄を並べる枠。popup では、フォーカスで左へ広がる部分。 */
export function searchWrapperClass(screen: boolean): string {
  return cn(
    "group/search flex min-w-0 items-center",
    screen
      ? "h-full gap-1"
      : "absolute inset-y-0 right-0 z-10 w-full rounded-md bg-background transition-[width] duration-200 focus-within:w-[min(24rem,calc(100cqw-2rem))]",
  );
}

/** 欄の枠 (虫めがね・入力・クリアのボタンを並べる)。 */
export function searchFrameClass(screen: boolean): string {
  return cn(
    "flex min-w-0 flex-1 cursor-text items-center",
    screen
      ? "h-10 gap-1.5"
      : "h-8 gap-1.5 overflow-hidden rounded-md border border-input bg-muted/40 pr-1 pl-2 transition-colors focus-within:border-ring focus-within:bg-background focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
  );
}

/** 虫めがねだけの狭い表示で、広げている間だけ出す部品に付ける指定。 */
export const SEARCH_EXPANDED_ONLY =
  "hidden group-focus-within/search:inline-flex @3xl/pane:inline-flex";

/** スマホの検索画面の左端の「←」。 */
export function SearchBackButton({ onClick }: { onClick?: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="検索を閉じる"
      onClick={onClick}
      className="-ml-2 shrink-0 pointer-coarse:-ml-2.5"
    >
      <ArrowLeftIcon />
    </Button>
  );
}

/** popup の欄の左の虫めがね。 */
export function SearchFieldIcon() {
  return (
    <SearchIcon
      className="pointer-events-none size-4 shrink-0 text-muted-foreground"
      aria-hidden="true"
    />
  );
}

/** 入力欄の文字。スマホは iOS が 16px 未満の欄で画面を拡大してしまうので、text-base。 */
export function searchInputClass(screen: boolean): string {
  return cn(
    "h-full w-full flex-1 bg-transparent outline-none placeholder:text-muted-foreground",
    screen ? "min-w-24 text-base" : "min-w-20 text-sm",
  );
}

/**
 * 語を入れて Enter で探す、簡単な検索欄 (候補や条件のチップは無い)。見た目と動きは
 * Mail の検索欄と同じ: Esc で入力を消し、空なら欄を抜ける (screen では閉じる)。
 */
export function SearchField({
  variant,
  value,
  onChange,
  onSubmit,
  onClose,
  placeholder,
  label,
  inputId,
  autoFocus,
  className,
}: {
  variant: SearchFieldVariant;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  /** screen の「←」と、空の欄での Esc。 */
  onClose?: () => void;
  placeholder: string;
  /** 読み上げ用の名前。 */
  label: string;
  /** 入力欄の id (ショートカットキーで移るときに使う)。 */
  inputId?: string;
  autoFocus?: boolean;
  className?: string;
}) {
  const screen = variant === "screen";
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <search className={searchRootClass(screen, className)}>
      <form
        className={searchWrapperClass(screen)}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(value);
        }}
      >
        {screen && <SearchBackButton onClick={onClose} />}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: 欄の余白を押しても入力できるようにするだけ */}
        <div
          onMouseDown={(event) => {
            if ((event.target as HTMLElement).closest("button, input")) return;
            event.preventDefault();
            inputRef.current?.focus();
          }}
          className={searchFrameClass(screen)}
        >
          {!screen && <SearchFieldIcon />}
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            // biome-ignore lint/a11y/noAutofocus: スマホの検索画面を開いたら、すぐ入力できるようにする (Mail と同じ)
            autoFocus={autoFocus}
            aria-label={label}
            placeholder={placeholder}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              if (value) onChange("");
              else if (screen) onClose?.();
              else event.currentTarget.blur();
            }}
            className={searchInputClass(screen)}
          />
          {value && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="入力をクリア"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange("");
                inputRef.current?.focus();
              }}
              className={cn(
                "ml-auto shrink-0",
                !screen && SEARCH_EXPANDED_ONLY,
              )}
            >
              <XIcon />
            </Button>
          )}
        </div>
      </form>
    </search>
  );
}
