"use client";

import { cn } from "cn";
import {
  ALargeSmallIcon,
  BaselineIcon,
  BoldIcon,
  ChevronDownIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListIndentDecreaseIcon,
  ListIndentIncreaseIcon,
  ListOrderedIcon,
  RemoveFormattingIcon,
  StrikethroughIcon,
  TextAlignCenterIcon,
  TextAlignEndIcon,
  TextAlignStartIcon,
  TextQuoteIcon,
  TypeIcon,
  UnderlineIcon,
} from "lucide-react";
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { EmojiPickerButton } from "@/components/emoji-picker";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { sanitizeHtml } from "@/lib/compose";
import {
  consumeLineMarker,
  editorRange,
  exitQuoteFromEmptyLine,
  indentLines,
  inListItem,
  quoteAt,
  stripSentinel,
  toggleQuote,
} from "@/lib/editor-format";
import { insertIntoField } from "@/lib/emoji/insert";

/** 書式のボタンで実行する操作。 */
export type FormatCommand =
  | "bold"
  | "italic"
  | "underline"
  | "strikeThrough"
  | "insertOrderedList"
  | "insertUnorderedList"
  | "quote"
  | "indent"
  | "outdent"
  | "justifyLeft"
  | "justifyCenter"
  | "justifyRight"
  | "removeFormat";

function isMac(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  );
}

/** ショートカットの表記 (Mac では ⌘ と ⇧ と ⌥)。 */
function keys(...parts: ("mod" | "shift" | "alt" | string)[]): string {
  const mac = isMac();
  return parts
    .map((part) =>
      part === "mod"
        ? mac
          ? "⌘"
          : "Ctrl"
        : part === "shift"
          ? mac
            ? "⇧"
            : "Shift"
          : part === "alt"
            ? mac
              ? "⌥"
              : "Alt"
            : part,
    )
    .join(mac ? "" : "+");
}

type ButtonFormat = {
  command: FormatCommand;
  label: string;
  icon: ReactNode;
  shortcut?: () => string;
};

const inlineFormats: ButtonFormat[] = [
  {
    command: "bold",
    label: "太字",
    icon: <BoldIcon />,
    shortcut: () => keys("mod", "B"),
  },
  {
    command: "italic",
    label: "斜体",
    icon: <ItalicIcon />,
    shortcut: () => keys("mod", "I"),
  },
  {
    command: "underline",
    label: "下線",
    icon: <UnderlineIcon />,
    shortcut: () => keys("mod", "U"),
  },
  {
    command: "strikeThrough",
    label: "取り消し線",
    icon: <StrikethroughIcon />,
    shortcut: () => keys("alt", "shift", "5"),
  },
];

const blockFormats: ButtonFormat[] = [
  {
    command: "insertOrderedList",
    label: "番号付きリスト",
    icon: <ListOrderedIcon />,
    shortcut: () => keys("mod", "shift", "7"),
  },
  {
    command: "insertUnorderedList",
    label: "箇条書き",
    icon: <ListIcon />,
    shortcut: () => keys("mod", "shift", "8"),
  },
  {
    command: "outdent",
    label: "インデントを減らす",
    icon: <ListIndentDecreaseIcon />,
    shortcut: () => keys("mod", "["),
  },
  {
    command: "indent",
    label: "インデントを増やす",
    icon: <ListIndentIncreaseIcon />,
    shortcut: () => keys("mod", "]"),
  },
  {
    command: "quote",
    label: "引用",
    icon: <TextQuoteIcon />,
    shortcut: () => keys("mod", "shift", "9"),
  },
];

const aligns: { command: FormatCommand; label: string; icon: ReactNode }[] = [
  { command: "justifyLeft", label: "左揃え", icon: <TextAlignStartIcon /> },
  {
    command: "justifyCenter",
    label: "中央揃え",
    icon: <TextAlignCenterIcon />,
  },
  { command: "justifyRight", label: "右揃え", icon: <TextAlignEndIcon /> },
];

/** 文字の大きさ。value は execCommand("fontSize") の 1〜7。 */
const sizes = [
  { value: "1", label: "小", className: "text-xs" },
  { value: null, label: "標準", className: "text-sm" },
  { value: "4", label: "大", className: "text-base" },
  { value: "6", label: "特大", className: "text-xl" },
] as const;

/**
 * 文字の色とマーカーの色。暗い画面でも明るい画面でも読める中間の濃さにする。
 * 相手のメールソフトでもそのまま表示される。
 */
export const TEXT_COLORS = [
  { value: "#dc2626", label: "赤" },
  { value: "#ea580c", label: "オレンジ" },
  { value: "#ca8a04", label: "黄" },
  { value: "#16a34a", label: "緑" },
  { value: "#0891b2", label: "水色" },
  { value: "#2563eb", label: "青" },
  { value: "#7c3aed", label: "紫" },
  { value: "#db2777", label: "ピンク" },
  { value: "#6b7280", label: "グレー" },
] as const;

export const HIGHLIGHT_COLORS = [
  { value: "#fef08a", label: "黄" },
  { value: "#bbf7d0", label: "緑" },
  { value: "#bae6fd", label: "水色" },
  { value: "#fbcfe8", label: "ピンク" },
  { value: "#fed7aa", label: "オレンジ" },
  { value: "#e5e7eb", label: "グレー" },
] as const;

/** 「標準に戻す」ときにいったん付ける、目印の値。 */
const SENTINEL_TEXT = "#010203";
const SENTINEL_HIGHLIGHT = "#010204";
const SENTINEL_SIZE = "7";
const SENTINEL_SIZE_CSS = "xxx-large";

const FORMAT_BAR_KEY = "mail.compose-format-bar.v1";

function loadFormatBar(): boolean {
  try {
    return window.localStorage.getItem(FORMAT_BAR_KEY) !== "off";
  } catch {
    return true;
  }
}

function storeFormatBar(open: boolean): void {
  try {
    if (open) window.localStorage.removeItem(FORMAT_BAR_KEY);
    else window.localStorage.setItem(FORMAT_BAR_KEY, "off");
  } catch {
    // 保存できない環境では、次に開いたときに表示に戻るだけ。
  }
}

/** 状態 (押されているか) を調べる操作。 */
const STATEFUL: FormatCommand[] = [
  "bold",
  "italic",
  "underline",
  "strikeThrough",
  "insertOrderedList",
  "insertUnorderedList",
  "justifyCenter",
  "justifyRight",
];

/**
 * 本文の入力欄 (書式付き) と、書式のボタン。
 * 内容はブラウザーの編集機能 (contentEditable) に任せ、変わるたびに HTML を親へ伝える。
 * children は入力欄とツールバーの間に置くもの (添付ファイルの一覧など)。
 * 書式のボタンは、入力欄とツールバーの間の 1 行 (書式バー) に並べ、ツールバーの「書式」で出し入れする。
 */
export function Editor({
  editorRef,
  initialHtml,
  disabled,
  label = "本文",
  onChange,
  onFiles,
  toolbar,
  children,
}: {
  editorRef: React.RefObject<HTMLDivElement | null>;
  initialHtml: string;
  disabled: boolean;
  /** 入力欄の名前 (読み上げ用)。 */
  label?: string;
  onChange: (html: string) => void;
  /** 貼り付けられたファイルの受け取り先。無ければファイルの貼り付けは無視する。 */
  onFiles?: (files: File[]) => void;
  /** format は「書式」の切り替え、リンク、絵文字のボタン。 */
  toolbar: (format: ReactNode) => ReactNode;
  children?: ReactNode;
}) {
  const [active, setActive] = useState<Partial<Record<string, boolean>>>({});
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [formatBar, setFormatBar] = useState(loadFormatBar);
  const [colorOpen, setColorOpen] = useState(false);
  /** リンクや絵文字、色を入れる範囲。ほかの入力欄やメニューへ移る前の選択を覚えておく。 */
  const savedRange = useRef<Range | null>(null);
  const linkRef = useRef<HTMLInputElement>(null);

  // 最初の内容を入れる。保存してあった下書きも通るので、許可したタグだけに整えてから入れる。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 入れるのは最初の 1 回だけ (以後は入力欄が内容を持つ)
  useLayoutEffect(() => {
    if (editorRef.current) {
      editorRef.current.innerHTML = sanitizeHtml(initialHtml, { rich: true });
    }
  }, []);

  const refreshActive = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const range = editorRange(editor);
    if (!range) return;
    const next: Record<string, boolean> = {};
    for (const command of STATEFUL) {
      try {
        next[command] = document.queryCommandState(command);
      } catch {
        next[command] = false;
      }
    }
    next.quote = quoteAt(editor, range) !== null;
    setActive(next);
  }, [editorRef]);

  useEffect(() => {
    document.addEventListener("selectionchange", refreshActive);
    return () => document.removeEventListener("selectionchange", refreshActive);
  }, [refreshActive]);

  const emit = () => onChange(editorRef.current?.innerHTML ?? "");

  /** 本文の中の選択範囲を覚える (ほかの入力欄やメニューへフォーカスが移る前に呼ぶ)。 */
  function saveRange() {
    const editor = editorRef.current;
    savedRange.current = editor
      ? (editorRange(editor)?.cloneRange() ?? null)
      : null;
  }

  /** 入力欄にフォーカスを戻し、覚えておいた選択範囲 (無ければ今の選択) を選び直す。 */
  function focusEditor() {
    const editor = editorRef.current;
    if (!editor) return null;
    const hadFocus = editor.contains(document.activeElement);
    editor.focus();
    const range = savedRange.current;
    if (!hadFocus && range && editor.contains(range.commonAncestorContainer)) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    savedRange.current = null;
    return editor;
  }

  /** 色や大きさは、タグ (font) ではなく style で付ける。 */
  function withCss(action: () => void) {
    try {
      document.execCommand("styleWithCSS", false, "true");
      action();
    } finally {
      document.execCommand("styleWithCSS", false, "false");
    }
  }

  function run(command: FormatCommand) {
    const editor = focusEditor();
    if (!editor) return;
    switch (command) {
      case "quote":
        toggleQuote(editor);
        break;
      case "indent":
      case "outdent":
        // 箇条書きの中は、リストの入れ子にする。
        if (inListItem(editor, editorRange(editor))) {
          document.execCommand(command);
        } else {
          indentLines(editor, command === "indent" ? 1 : -1);
        }
        break;
      case "justifyLeft":
      case "justifyCenter":
      case "justifyRight":
        withCss(() => document.execCommand(command));
        break;
      default:
        document.execCommand(command);
    }
    emit();
    refreshActive();
  }

  function applySize(value: string | null) {
    const editor = focusEditor();
    if (!editor) return;
    withCss(() =>
      document.execCommand("fontSize", false, value ?? SENTINEL_SIZE),
    );
    if (value === null) {
      stripSentinel(editor, "font-size", SENTINEL_SIZE_CSS, {
        name: "size",
        value: SENTINEL_SIZE,
      });
    }
    emit();
  }

  function applyColor(kind: "text" | "highlight", value: string | null) {
    setColorOpen(false);
    const editor = focusEditor();
    if (!editor) return;
    const sentinel = kind === "text" ? SENTINEL_TEXT : SENTINEL_HIGHLIGHT;
    withCss(() =>
      document.execCommand(
        kind === "text" ? "foreColor" : "hiliteColor",
        false,
        value ?? sentinel,
      ),
    );
    if (value === null) {
      stripSentinel(
        editor,
        kind === "text" ? "color" : "background-color",
        sentinel,
        kind === "text" ? { name: "color", value: sentinel } : undefined,
      );
    }
    emit();
  }

  function openLink() {
    saveRange();
    setLinkUrl("");
    setLinkOpen(true);
    requestAnimationFrame(() => linkRef.current?.focus());
  }

  function applyLink() {
    const raw = linkUrl.trim();
    setLinkOpen(false);
    const editor = editorRef.current;
    if (!raw || !editor) return;
    const url = /^(https?:|mailto:)/i.test(raw) ? raw : `https://${raw}`;
    editor.focus();
    const selection = window.getSelection();
    if (savedRange.current && selection) {
      selection.removeAllRanges();
      selection.addRange(savedRange.current);
    }
    if (selection?.isCollapsed ?? true) {
      // 何も選んでいなければ、URL そのものをリンクとして入れる。
      const link = document.createElement("a");
      link.href = url;
      link.textContent = raw;
      document.execCommand("insertHTML", false, link.outerHTML);
    } else {
      document.execCommand("createLink", false, url);
    }
    emit();
  }

  /** 覚えておいた位置 (無ければ本文の末尾) に、文字を入れる。 */
  function insertText(text: string) {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const selection = window.getSelection();
    if (selection) {
      let range = savedRange.current;
      if (!range) {
        range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
      }
      selection.removeAllRanges();
      selection.addRange(range);
    }
    document.execCommand("insertText", false, text);
    emit();
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    const files = [...event.clipboardData.files];
    if (files.length > 0) {
      event.preventDefault();
      onFiles?.(files);
      return;
    }
    // ほかの画面の書式を持ち込まないよう、文字だけを貼り付ける。
    event.preventDefault();
    document.execCommand(
      "insertText",
      false,
      event.clipboardData.getData("text/plain"),
    );
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || disabled) return;
    const mod = isMac() ? event.metaKey : event.ctrlKey;
    // 引用の最後の空行で Enter を押したら、引用を抜ける。
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !mod &&
      !event.altKey &&
      editorRef.current &&
      exitQuoteFromEmptyLine(editorRef.current)
    ) {
      event.preventDefault();
      emit();
      refreshActive();
      return;
    }
    let command: FormatCommand | null = null;
    if (mod && event.shiftKey && !event.altKey) {
      // Shift を押すと記号になる配列があるので、キーの位置 (code) で見る。
      if (event.code === "Digit7") command = "insertOrderedList";
      else if (event.code === "Digit8") command = "insertUnorderedList";
      else if (event.code === "Digit9") command = "quote";
    } else if (event.altKey && event.shiftKey && !mod) {
      if (event.code === "Digit5") command = "strikeThrough";
    } else if (mod && !event.shiftKey && !event.altKey) {
      if (event.key === "]") command = "indent";
      else if (event.key === "[") command = "outdent";
      else if (event.key === "\\" || event.key === "¥")
        command = "removeFormat";
      else if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        openLink();
        return;
      }
    }
    if (!command) return;
    event.preventDefault();
    run(command);
  }

  function handleInput(event: FormEvent<HTMLDivElement>) {
    const native = event.nativeEvent as InputEvent;
    const editor = editorRef.current;
    // 行頭に「> 」「1. 」「- 」と打つと、引用・番号付きリスト・箇条書きにする。
    if (
      editor &&
      native.inputType === "insertText" &&
      (native.data === " " || native.data === "　")
    ) {
      const marker = consumeLineMarker(editor);
      if (marker === "orderedList") document.execCommand("insertOrderedList");
      else if (marker === "unorderedList") {
        document.execCommand("insertUnorderedList");
      }
      if (marker) refreshActive();
    }
    emit();
  }

  function toggleFormatBar() {
    setFormatBar((current) => {
      storeFormatBar(!current);
      return !current;
    });
  }

  const formatButton = (format: ButtonFormat) => (
    <Hint
      key={format.command}
      label={format.label}
      shortcut={format.shortcut?.()}
      side="top"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={format.label}
        aria-pressed={active[format.command] ?? false}
        disabled={disabled}
        // 押しても本文の選択が外れないようにする。
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => run(format.command)}
        className="aria-pressed:bg-muted"
      >
        {format.icon}
      </Button>
    </Hint>
  );

  const separator = (
    <span className="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
  );
  const alignIcon = active.justifyCenter
    ? aligns[1]?.icon
    : active.justifyRight
      ? aligns[2]?.icon
      : aligns[0]?.icon;

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: 書式付きの入力欄は textarea では作れない */}
      <div
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        tabIndex={0}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        // 本文の中のリンクを押しても、ページを移動しない。
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("a"))
            event.preventDefault();
        }}
        className="min-h-40 flex-1 overflow-y-auto break-words px-4 py-3 text-base leading-relaxed outline-none md:text-sm [&_a]:text-primary [&_a]:underline [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_h1]:font-semibold [&_h1]:text-lg [&_h2]:font-semibold [&_h2]:text-base [&_h3]:font-semibold [&_hr]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_pre]:whitespace-pre-wrap [&_td]:pr-3 [&_td]:align-top [&_th]:pr-3 [&_th]:text-left [&_ul]:list-disc [&_ul]:pl-6 dark:[&_[style*=background-color]]:text-neutral-900"
      />
      {children}
      {linkOpen && (
        <div className="flex shrink-0 items-center gap-2 border-t px-3 py-2">
          <Input
            ref={linkRef}
            type="url"
            aria-label="リンク先の URL"
            placeholder="https://example.com"
            value={linkUrl}
            onChange={(event) => setLinkUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                applyLink();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setLinkOpen(false);
                editorRef.current?.focus();
              }
            }}
            className="h-8"
          />
          <Button type="button" size="sm" onClick={applyLink}>
            リンクを付ける
          </Button>
        </div>
      )}
      {formatBar && (
        <div
          role="toolbar"
          aria-label="書式"
          className="flex [scrollbar-width:none] shrink-0 items-center gap-0.5 overflow-x-auto border-t px-2 py-1"
        >
          <DropdownMenu>
            <Hint label="文字の大きさ" side="top">
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="文字の大きさ"
                    disabled={disabled}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      saveRange();
                    }}
                    className="shrink-0 gap-0.5 px-1.5"
                  />
                }
              >
                <ALargeSmallIcon />
                <ChevronDownIcon className="size-3 text-muted-foreground" />
              </DropdownMenuTrigger>
            </Hint>
            <DropdownMenuContent
              align="start"
              side="top"
              finalFocus={false}
              className="w-auto min-w-28"
            >
              {sizes.map((size) => (
                <DropdownMenuItem
                  key={size.label}
                  onClick={() => applySize(size.value)}
                  className={size.className}
                >
                  {size.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {separator}
          {inlineFormats.map(formatButton)}
          <Popover open={colorOpen} onOpenChange={setColorOpen}>
            <Hint label="文字の色とマーカー" side="top">
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="文字の色とマーカー"
                    disabled={disabled}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      saveRange();
                    }}
                    className="shrink-0 gap-0.5 px-1.5"
                  />
                }
              >
                <BaselineIcon />
                <ChevronDownIcon className="size-3 text-muted-foreground" />
              </PopoverTrigger>
            </Hint>
            <PopoverContent
              align="start"
              side="top"
              finalFocus={false}
              initialFocus={false}
              className="w-auto gap-3"
            >
              <PopoverTitle className="sr-only">
                文字の色とマーカー
              </PopoverTitle>
              <ColorChoices
                title="文字の色"
                colors={TEXT_COLORS}
                kind="text"
                onSelect={(value) => applyColor("text", value)}
              />
              <ColorChoices
                title="マーカー"
                colors={HIGHLIGHT_COLORS}
                kind="highlight"
                onSelect={(value) => applyColor("highlight", value)}
              />
            </PopoverContent>
          </Popover>
          {separator}
          <DropdownMenu>
            <Hint label="配置" side="top">
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="配置"
                    disabled={disabled}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      saveRange();
                    }}
                    className="shrink-0 gap-0.5 px-1.5"
                  />
                }
              >
                {alignIcon}
                <ChevronDownIcon className="size-3 text-muted-foreground" />
              </DropdownMenuTrigger>
            </Hint>
            <DropdownMenuContent
              align="start"
              side="top"
              finalFocus={false}
              className="w-auto min-w-32"
            >
              {aligns.map((align) => (
                <DropdownMenuItem
                  key={align.command}
                  onClick={() => run(align.command)}
                >
                  {align.icon}
                  {align.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {blockFormats.map(formatButton)}
          {separator}
          {formatButton({
            command: "removeFormat",
            label: "書式をクリア",
            icon: <RemoveFormattingIcon />,
            shortcut: () => keys("mod", "\\"),
          })}
        </div>
      )}
      {toolbar(
        <>
          <Hint label={formatBar ? "書式を隠す" : "書式"} side="top">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="書式"
              aria-pressed={formatBar}
              disabled={disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={toggleFormatBar}
              className="aria-pressed:bg-muted"
            >
              <TypeIcon />
            </Button>
          </Hint>
          <Hint label="リンク" shortcut={keys("mod", "K")} side="top">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="リンク"
              aria-expanded={linkOpen}
              disabled={disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => (linkOpen ? setLinkOpen(false) : openLink())}
            >
              <LinkIcon />
            </Button>
          </Hint>
          <EmojiPickerButton
            disabled={disabled}
            onOpen={saveRange}
            onSelect={insertText}
          />
        </>,
      )}
    </>
  );
}

function ColorChoices({
  title,
  colors,
  kind,
  onSelect,
}: {
  title: string;
  colors: readonly { value: string; label: string }[];
  kind: "text" | "highlight";
  onSelect: (value: string | null) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-muted-foreground text-xs">{title}</legend>
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(null)}
          className="flex h-7 items-center rounded-md border px-2 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {kind === "text" ? "標準" : "なし"}
        </button>
        {colors.map((color) => (
          <button
            key={color.value}
            type="button"
            aria-label={`${title}: ${color.label}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(color.value)}
            className={cn(
              "flex size-7 items-center justify-center rounded-md border font-semibold text-sm outline-none hover:ring-2 hover:ring-ring/30 focus-visible:ring-2 focus-visible:ring-ring/50",
              kind === "highlight" && "text-neutral-900",
            )}
            style={
              kind === "text"
                ? { color: color.value }
                : { backgroundColor: color.value }
            }
          >
            A
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * テキストだけで書くときの本文の入力欄。書式のボタンは無く、ツールバーには絵文字だけを渡す。
 * children は入力欄とツールバーの間に置くもの (添付ファイルの一覧など)。
 */
export function TextEditor({
  textRef,
  value,
  disabled,
  label = "本文",
  onChange,
  onFiles,
  toolbar,
  children,
}: {
  textRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  disabled: boolean;
  label?: string;
  onChange: (text: string) => void;
  onFiles?: (files: File[]) => void;
  /** format は絵文字のボタン。 */
  toolbar: (format: ReactNode) => ReactNode;
  children?: ReactNode;
}) {
  return (
    <>
      <textarea
        ref={textRef}
        aria-label={label}
        value={value}
        readOnly={disabled}
        onChange={(event) => onChange(event.target.value)}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (files.length === 0) return;
          event.preventDefault();
          onFiles?.(files);
        }}
        className="min-h-40 flex-1 resize-none bg-transparent px-4 py-3 text-base leading-relaxed outline-none md:text-sm"
      />
      {children}
      {toolbar(
        <EmojiPickerButton
          disabled={disabled}
          onSelect={(emoji) =>
            insertIntoField(textRef.current, value, emoji, onChange)
          }
        />,
      )}
    </>
  );
}
