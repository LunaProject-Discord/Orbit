"use client";

import { Maximize2Icon, ReplyIcon, SendIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { EmojiPickerButton } from "@/components/emoji-picker";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { insertIntoField } from "@/lib/emoji/insert";

type Props = {
  /** 返信の宛先になる相手の名前。 */
  recipient: string;
  /**
   * 受け取ったアカウントとは別のアカウントから送るときの差出人 (受け取ったアカウントが
   * 受信専用のとき)。入力欄の上に出して、どこから送るかが分かるようにする。
   */
  from?: string;
  /** 書いた文章を送る。送れたら true、送れなければ false (文章は残す)。 */
  onSend: (text: string) => Promise<boolean>;
  /** 続きを作成画面で書く (宛先や書式を変えたい、ファイルを付けたいとき)。 */
  onExpand: (text: string) => void;
};

/**
 * 本文の下の返信欄。押すと入力欄が開き、短い返信をその場で送れる。
 * 宛先は「返信」と同じ (差出人だけ)。署名と元のメールの引用は、送るときに付く。
 */
export function QuickReply({ recipient, from, onSend, onExpand }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-lg border px-3 py-2.5 text-left text-muted-foreground text-sm outline-none transition-colors hover:bg-muted/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ReplyIcon className="size-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{recipient} に返信…</span>
      </button>
    );
  }

  const empty = text.trim() === "";
  const send = async () => {
    if (empty || sending) return;
    setSending(true);
    const sent = await onSend(text);
    setSending(false);
    if (sent) {
      setText("");
      setOpen(false);
    }
  };

  return (
    <form
      aria-label={`${recipient} に返信`}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      className="flex flex-col gap-2 rounded-lg border p-2 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
    >
      {from && (
        <p className="truncate px-1.5 pt-1 text-muted-foreground text-xs">
          差出人: {from} (受け取ったアカウントは受信専用のため)
        </p>
      )}
      <Textarea
        ref={inputRef}
        value={text}
        disabled={sending}
        aria-label="返信の本文"
        placeholder={`${recipient} に返信…`}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void send();
          } else if (event.key === "Escape" && empty) {
            event.preventDefault();
            setOpen(false);
          }
        }}
        className="max-h-64 min-h-20 resize-none border-0 px-1.5 py-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      <div className="flex items-center gap-1">
        <Hint label="送信" shortcut="Ctrl+Enter">
          <Button type="submit" size="sm" disabled={empty || sending}>
            <SendIcon />
            {sending ? "送信中…" : "送信"}
          </Button>
        </Hint>
        <EmojiPickerButton
          size="icon-sm"
          disabled={sending}
          onSelect={(emoji) =>
            insertIntoField(inputRef.current, text, emoji, setText)
          }
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={sending}
          onClick={() => {
            onExpand(text);
            setText("");
            setOpen(false);
          }}
        >
          <Maximize2Icon />
          作成画面で開く
        </Button>
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={sending}
          onClick={() => {
            setText("");
            setOpen(false);
          }}
        >
          キャンセル
        </Button>
      </div>
    </form>
  );
}
