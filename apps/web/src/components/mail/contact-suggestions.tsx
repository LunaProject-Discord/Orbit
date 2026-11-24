"use client";

import { cn } from "cn";
import {
  type ComponentProps,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { profileInitial } from "@/components/mail/profile-card";
import { Input } from "@/components/ui/input";
import type { Contact } from "@/lib/api";
import { useContactSuggestions } from "@/lib/contacts";

type Options = {
  /** 入力中の文字列。 */
  query: string;
  /** 候補から除くアドレス (選び済みの宛先など)。 */
  exclude?: readonly string[];
  /** 候補を選んだとき。 */
  onPick: (contact: Contact) => void;
  /** 出す件数。 */
  limit?: number;
};

/**
 * 入力欄に、送受信したメールの相手の候補を出すための状態とキー操作。
 * 入力欄には inputProps を渡し、onKeyDown の最初で handleKeyDown を呼ぶ (true なら処理済み)。
 * 一覧は ContactSuggestionList に list を渡して、入力欄を囲む relative な要素の中に置く。
 */
export function useContactCombobox({ query, exclude, onPick, limit }: Options) {
  const listId = useId();
  const suggestions = useContactSuggestions(query, { exclude, limit });
  const [active, setActive] = useState(0);
  // Esc で閉じたあとは、入力が変わるまで出さない。
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const open =
    focused && suggestions.length > 0 && dismissedFor !== query.trim();
  const activeIndex = Math.min(active, suggestions.length - 1);

  // 入力が変わったら先頭の候補を選んだ状態に戻す。
  const [lastQuery, setLastQuery] = useState(query);
  if (lastQuery !== query) {
    setLastQuery(query);
    setActive(0);
  }

  const pick = (contact: Contact) => {
    setActive(0);
    onPick(contact);
  };

  /** 候補を操作するキーなら処理して true を返す。 */
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): boolean {
    if (!open || event.nativeEvent.isComposing) return false;
    const move = (delta: number) => {
      event.preventDefault();
      setActive(
        (activeIndex + delta + suggestions.length) % suggestions.length,
      );
      return true;
    };
    switch (event.key) {
      case "ArrowDown":
        return move(1);
      case "ArrowUp":
        return move(-1);
      case "Enter":
      case "Tab": {
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
          return false;
        }
        const contact = suggestions[activeIndex];
        if (!contact) return false;
        event.preventDefault();
        pick(contact);
        return true;
      }
      case "Escape":
        event.preventDefault();
        // 作成画面などを閉じる Esc として扱われないようにする。
        event.stopPropagation();
        setDismissedFor(query.trim());
        return true;
      default:
        return false;
    }
  }

  const activeId =
    open && suggestions[activeIndex] ? `${listId}-${activeIndex}` : undefined;

  return {
    open,
    handleKeyDown,
    inputProps: {
      role: "combobox",
      "aria-autocomplete": "list",
      "aria-expanded": open,
      "aria-controls": open ? listId : undefined,
      "aria-activedescendant": activeId,
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
    } as const,
    list: {
      id: listId,
      open,
      query,
      suggestions,
      activeIndex,
      onActiveChange: setActive,
      onPick: pick,
    },
  };
}

type ListProps = ReturnType<typeof useContactCombobox>["list"] & {
  className?: string;
};

/**
 * 候補の一覧。入力欄を囲む relative な要素の中に置くと、その真下 (下に場所が無ければ真上) に出る。
 * 押しても入力欄からフォーカスが外れないので、続けて入力できる。
 */
export function ContactSuggestionList({
  id,
  open,
  query,
  suggestions,
  activeIndex,
  onActiveChange,
  onPick,
  className,
}: ListProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [above, setAbove] = useState(false);

  // 下に入りきらず、上のほうが広いときは上に出す。
  useLayoutEffect(() => {
    if (!open) return;
    const element = ref.current;
    const parent = element?.parentElement;
    if (!element || !parent) return;
    const rect = parent.getBoundingClientRect();
    const height = element.offsetHeight;
    const viewport = window.visualViewport?.height ?? window.innerHeight;
    const below = viewport - rect.bottom;
    setAbove(below < height + 8 && rect.top > below);
  }, [open]);

  // 選んでいる候補が見えるようにする。
  useEffect(() => {
    if (!open) return;
    ref.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      id={id}
      role="listbox"
      aria-label="宛先の候補"
      // 押しても入力欄のフォーカスを保つ (欄から離れたときの確定を起こさない)。
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      className={cn(
        "absolute right-0 left-0 z-50 max-h-80 min-w-64 overflow-y-auto overscroll-contain rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 animate-in fade-in-0 zoom-in-95",
        above ? "bottom-full mb-1" : "top-full mt-1",
        className,
      )}
    >
      {suggestions.map((contact, index) => (
        // biome-ignore lint/a11y/useKeyWithClickEvents: キー操作は入力欄 (combobox) で受ける。
        <div
          key={contact.address}
          id={`${id}-${index}`}
          role="option"
          tabIndex={-1}
          aria-selected={index === activeIndex}
          data-index={index}
          onPointerMove={() => {
            if (index !== activeIndex) onActiveChange(index);
          }}
          onClick={() => onPick(contact)}
          className="flex min-h-11 cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 outline-none aria-selected:bg-accent aria-selected:text-accent-foreground pointer-coarse:min-h-12"
        >
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-sm"
          >
            {profileInitial({
              name: contact.name ?? undefined,
              address: contact.address,
            })}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            {contact.name ? (
              <>
                <span className="truncate text-sm">
                  <Highlight text={contact.name} query={query} />
                </span>
                <span className="truncate text-muted-foreground text-xs">
                  <Highlight text={contact.address} query={query} />
                </span>
              </>
            ) : (
              <span className="truncate text-sm">
                <Highlight text={contact.address} query={query} />
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 入力した語に合う部分を太字にする。 */
function Highlight({ text, query }: { text: string; query: string }) {
  const tokens = query
    .normalize("NFKC")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return <>{text}</>;
  // 照らし合わせは 1 文字ずつ。NFKC で長さが変わる文字があっても位置がずれないようにする。
  const chars = Array.from(text);
  const lower = chars.map((char) => char.normalize("NFKC").toLowerCase());
  const marked = new Array<boolean>(chars.length).fill(false);
  for (const token of tokens) {
    const tokenChars = Array.from(token);
    const matchesAt = (start: number) =>
      start + tokenChars.length <= chars.length &&
      tokenChars.every((char, offset) => lower[start + offset] === char);
    const starts = chars.map((_, start) => start).filter(matchesAt);
    // 語の先頭で合う位置を優先する (kenta.tanaka で ta と入れたら tanaka の ta)。
    const start =
      starts.find(
        (position) =>
          position === 0 || /[\s@._+\-"'()<>,]/.test(chars[position - 1] ?? ""),
      ) ?? starts[0];
    if (start === undefined) continue;
    for (let offset = 0; offset < tokenChars.length; offset++) {
      marked[start + offset] = true;
    }
  }
  // 太字にするかどうかが同じ文字を、ひとまとまりにする。
  const segments: { start: number; text: string; bold: boolean }[] = [];
  chars.forEach((char, position) => {
    const bold = marked[position] ?? false;
    const last = segments.at(-1);
    if (last && last.bold === bold) last.text += char;
    else segments.push({ start: position, text: char, bold });
  });
  return (
    <>
      {segments.map((segment) =>
        segment.bold ? (
          <strong key={segment.start} className="font-semibold">
            {segment.text}
          </strong>
        ) : (
          <span key={segment.start}>{segment.text}</span>
        ),
      )}
    </>
  );
}

type ContactInputProps = Omit<
  ComponentProps<typeof Input>,
  "value" | "onChange" | "type"
> & {
  value: string;
  onValueChange: (value: string) => void;
};

/**
 * 名前かアドレスを 1 つ入れる欄 (統合フォルダの差出人・宛先の条件など)。
 * 入力に合う相手を候補に出し、選ぶとそのアドレスを入れる。
 */
export function ContactInput({
  value,
  onValueChange,
  onKeyDown,
  onFocus,
  onBlur,
  className,
  ...props
}: ContactInputProps) {
  const combobox = useContactCombobox({
    query: value,
    onPick: (contact) => onValueChange(contact.address),
  });
  return (
    <div className="relative min-w-0">
      <Input
        {...props}
        {...combobox.inputProps}
        type="text"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (combobox.handleKeyDown(event)) return;
          onKeyDown?.(event);
        }}
        onFocus={(event) => {
          combobox.inputProps.onFocus();
          onFocus?.(event);
        }}
        onBlur={(event) => {
          combobox.inputProps.onBlur();
          onBlur?.(event);
        }}
        className={className}
      />
      <ContactSuggestionList {...combobox.list} />
    </div>
  );
}
