"use client";

import {
  ClipboardPasteIcon,
  CopyIcon,
  ExternalLinkIcon,
  LinkIcon,
  Redo2Icon,
  ScissorsIcon,
  SmilePlusIcon,
  TextSelectIcon,
  Undo2Icon,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  EmojiPickerPanel,
  PICKER_POPOVER_CLASS,
} from "@/components/emoji-picker";
import { showNotice } from "@/components/mail/toasts";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverTitle } from "@/components/ui/popover";
import { desktopPlatform, isDesktopApp } from "@/lib/desktop/app";
import {
  attachTextMenu,
  needsSelection,
  setTextMenuOpener,
  type TextMenuItem,
  type TextMenuTarget,
  textMenuItems,
} from "@/lib/desktop/text-menu";
import { externalLinkOf, openExternally } from "@/lib/external-links";

const LABELS: Record<TextMenuItem, string> = {
  undo: "元に戻す",
  redo: "やり直す",
  cut: "切り取り",
  copy: "コピー",
  paste: "貼り付け",
  selectAll: "すべて選択",
  emoji: "絵文字を入力…",
  openLink: "リンクを開く",
  copyLink: "リンクのアドレスをコピー",
};

const ICONS: Record<TextMenuItem, typeof CopyIcon> = {
  undo: Undo2Icon,
  redo: Redo2Icon,
  cut: ScissorsIcon,
  copy: CopyIcon,
  paste: ClipboardPasteIcon,
  selectAll: TextSelectIcon,
  emoji: SmilePlusIcon,
  openLink: ExternalLinkIcon,
  copyLink: LinkIcon,
};

const KEYS: Partial<Record<TextMenuItem, string>> = {
  undo: "Z",
  cut: "X",
  copy: "C",
  paste: "V",
  selectAll: "A",
};

function shortcutLabel(item: TextMenuItem): string | null {
  const mac = desktopPlatform() === "macos";
  if (item === "redo") return mac ? "⇧⌘Z" : "Ctrl+Y";
  const key = KEYS[item];
  if (!key) return null;
  return mac ? `⌘${key}` : `Ctrl+${key}`;
}

/** 入力欄に戻り、右クリックしたときの選択範囲を選び直す。 */
function refocus(target: TextMenuTarget): void {
  const editable = target.editable;
  if (!editable) return;
  editable.element.focus({ preventScroll: true });
  const range = editable.range;
  if (range && "setSelectionRange" in editable.element) {
    try {
      (editable.element as HTMLInputElement).setSelectionRange(
        range.start,
        range.end,
      );
    } catch {
      // 選択範囲を持たない種類の input。
    }
  }
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    showNotice("コピーできませんでした。");
  }
}

/** 右クリックした入力欄に文字を入れる。入力欄の「元に戻す」の履歴に残り、入力したときと同じく変更が伝わる。 */
function insertText(target: TextMenuTarget, text: string): void {
  refocus(target);
  target.doc.execCommand("insertText", false, text);
}

async function run(item: TextMenuItem, target: TextMenuTarget): Promise<void> {
  const { doc } = target;
  switch (item) {
    case "emoji":
      // 絵文字を選ぶ画面は、メニューを出している部品が開く。
      return;
    case "copy":
      await copyText(target.selectedText);
      return;
    case "copyLink":
      if (target.linkUrl) await copyText(target.linkUrl);
      return;
    case "openLink":
      if (target.linkUrl) openExternally(target.linkUrl);
      return;
    case "selectAll":
      if (target.editable) {
        refocus(target);
        doc.execCommand("selectAll");
      } else {
        doc.getSelection()?.selectAllChildren(doc.body);
      }
      return;
    case "paste": {
      let text: string;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        const key = desktopPlatform() === "macos" ? "⌘V" : "Ctrl+V";
        showNotice(
          `クリップボードを読み取れませんでした。${key} で貼り付けてください。`,
        );
        return;
      }
      insertText(target, text);
      return;
    }
    case "cut":
      await copyText(target.selectedText);
      refocus(target);
      doc.execCommand("delete");
      return;
    case "undo":
    case "redo":
      refocus(target);
      doc.execCommand(item);
      return;
  }
}

/**
 * デスクトップ版の右クリックメニュー。WebView の標準のメニューの代わりに出す。
 * 出す場所と項目の決め方は lib/desktop/text-menu.ts。
 */
export function DesktopTextContextMenu() {
  const triggerRef = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<TextMenuTarget | null>(null);
  // 書き出した HTML はブラウザーと共通なので、アプリの中かどうかは描画の後に確かめる。
  const [enabled, setEnabled] = useState(false);
  /** 絵文字を選ぶ画面を開いている間の、入れる先と開く位置。 */
  const [emoji, setEmoji] = useState<{
    target: TextMenuTarget;
    x: number;
    y: number;
  } | null>(null);
  const point = useRef({ x: 0, y: 0 });
  const emojiInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isDesktopApp()) return;
    setEnabled(true);
    setTextMenuOpener((next, x, y) => {
      setTarget(next);
      point.current = { x, y };
      // 見えない受け口に右クリックを送り、押した位置にメニューを出す。
      triggerRef.current?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          button: 2,
        }),
      );
    });
    const detach = attachTextMenu(document, (node) =>
      externalLinkOf(node, window.location.origin),
    );
    return () => {
      detach();
      setTextMenuOpener(null);
    };
  }, []);

  if (!enabled) return null;
  const items = target ? textMenuItems(target) : [];
  const closeEmoji = (chosen: string | null) => {
    const current = emoji;
    setEmoji(null);
    if (!current) return;
    if (chosen) insertText(current.target, chosen);
    else refocus(current.target);
  };
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger
          ref={triggerRef}
          aria-hidden="true"
          className="pointer-events-none fixed top-0 left-0 size-0"
        />
        <ContextMenuContent finalFocus={false} className="min-w-48">
          {target &&
            items.map((item, index) =>
              item === null ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: 区切り線は位置で区別するしかない。
                <ContextMenuSeparator key={`separator-${index}`} />
              ) : (
                <Fragment key={item}>
                  <MenuEntry
                    item={item}
                    target={target}
                    onEmoji={() => setEmoji({ target, ...point.current })}
                  />
                </Fragment>
              ),
            )}
        </ContextMenuContent>
      </ContextMenu>
      <Popover
        open={emoji !== null}
        onOpenChange={(next) => {
          if (!next) closeEmoji(null);
        }}
      >
        <PopoverContent
          anchor={
            emoji
              ? {
                  getBoundingClientRect: () =>
                    DOMRect.fromRect({
                      x: emoji.x,
                      y: emoji.y,
                      width: 0,
                      height: 0,
                    }),
                }
              : undefined
          }
          align="start"
          initialFocus={emojiInputRef}
          finalFocus={false}
          className={PICKER_POPOVER_CLASS}
        >
          <PopoverTitle className="sm:sr-only">絵文字を選ぶ</PopoverTitle>
          <EmojiPickerPanel inputRef={emojiInputRef} onChoose={closeEmoji} />
        </PopoverContent>
      </Popover>
    </>
  );
}

function MenuEntry({
  item,
  target,
  onEmoji,
}: {
  item: TextMenuItem;
  target: TextMenuTarget;
  onEmoji: () => void;
}) {
  const Icon = ICONS[item];
  const shortcut = shortcutLabel(item);
  return (
    <ContextMenuItem
      disabled={needsSelection(item) && target.selectedText.length === 0}
      onClick={() => (item === "emoji" ? onEmoji() : void run(item, target))}
    >
      <Icon />
      {LABELS[item]}
      {shortcut && <ContextMenuShortcut>{shortcut}</ContextMenuShortcut>}
    </ContextMenuItem>
  );
}
