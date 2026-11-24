"use client";

import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import {
  clearFind,
  type FindMatch,
  MAX_FIND_MATCHES,
  runFind,
  showMatch,
} from "@/lib/message-find";

/**
 * 開いているメールの中を探す欄 (ツールバーの下に出す)。
 * 本文の iframe が読み込み直されたり、会話のメールを広げたりしたら、探し直す。
 */
export function MessageFindBar({
  rootRef,
  initialText,
  request,
  onClose,
}: {
  /** 探す範囲 (メールの表示全体)。 */
  rootRef: RefObject<HTMLElement | null>;
  initialText: string;
  /** 値が変わると、欄へフォーカスを移して全体を選ぶ (もう一度開かれたとき)。 */
  request: number;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(initialText);
  const [shownInitial, setShownInitial] = useState(initialText);
  if (shownInitial !== initialText) {
    setShownInitial(initialText);
    setText(initialText);
  }
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);
  const matchesRef = useRef<FindMatch[]>([]);
  const indexRef = useRef(0);
  indexRef.current = index;

  // biome-ignore lint/correctness/useExhaustiveDependencies: request は開き直したきっかけとして使う
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [request]);

  // 語が変わったら探し直す。表示が変わったとき (本文の読み込みなど) も探し直す。
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = (keepIndex: boolean) => {
      const matches = runFind(root, text);
      matchesRef.current = matches;
      setCount(matches.length);
      const next = keepIndex
        ? Math.min(indexRef.current, Math.max(0, matches.length - 1))
        : 0;
      setIndex(next);
      if (matches.length > 0) showMatch(matches, next);
    };
    run(false);
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => run(true), 200);
    };
    // iframe の load は泡立たないが、取り込み (capture) では受け取れる。
    root.addEventListener("load", schedule, true);
    const observer = new MutationObserver((records) => {
      // 自分で付けた印 (iframe の中) はここには現れない。表示の差し替えだけを拾う。
      if (records.some((record) => record.type === "childList")) schedule();
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      if (timer) clearTimeout(timer);
      root.removeEventListener("load", schedule, true);
      observer.disconnect();
      clearFind(root);
    };
  }, [rootRef, text]);

  const step = (delta: 1 | -1) => {
    const matches = matchesRef.current;
    if (matches.length === 0) return;
    const next = (index + delta + matches.length) % matches.length;
    setIndex(next);
    showMatch(matches, next);
  };

  return (
    <search
      aria-label="このメールの中を検索"
      className="flex h-11 shrink-0 items-center gap-1 border-b px-2 sm:px-4"
    >
      <input
        ref={inputRef}
        type="text"
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        aria-label="このメールの中を検索"
        placeholder="このメールの中を検索"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none focus:border-ring focus:ring-3 focus:ring-ring/50 dark:bg-input/30"
      />
      <output
        aria-live="polite"
        className="shrink-0 px-1.5 text-muted-foreground text-xs tabular-nums"
      >
        {text.trim() === ""
          ? ""
          : count === 0
            ? "見つかりません"
            : `${index + 1} / ${count}${count >= MAX_FIND_MATCHES ? "+" : ""}`}
      </output>
      <Hint label="前へ" shortcut="Shift+Enter">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="前へ"
          disabled={count === 0}
          onClick={() => step(-1)}
        >
          <ChevronUpIcon />
        </Button>
      </Hint>
      <Hint label="次へ" shortcut="Enter">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="次へ"
          disabled={count === 0}
          onClick={() => step(1)}
        >
          <ChevronDownIcon />
        </Button>
      </Hint>
      <Hint label="閉じる" shortcut="Esc">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="検索を閉じる"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </Hint>
    </search>
  );
}
