"use client";

import { SendIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { type Account, ApiError, NetworkError, sendMail } from "@/lib/api";
import { type ComposeDraft, parseAddressList } from "@/lib/compose";

function messageOf(error: unknown): string {
  if (error instanceof NetworkError) {
    return "サーバーに接続できませんでした。内容はそのまま残っています。ネットワークの状態を確認して、もう一度送信してください。";
  }
  if (error instanceof ApiError) {
    switch (error.code) {
      case "no_recipients":
        return "宛先を入力してください。";
      case "too_many_recipients":
        return "宛先が多すぎます。合計 100 件までにしてください。";
      case "account_not_found":
        return "差出人のアカウントが見つかりません。別のアカウントを選んでください。";
    }
    if (error.status === 400) {
      return "入力内容に誤りがあります。宛先と件名を確認してください。";
    }
  }
  return "送信を受け付けられませんでした。時間をおいてもう一度お試しください。";
}

const titles = {
  new: "新しいメール",
  reply: "返信",
  forward: "転送",
} as const;

type Props = {
  /** 作成中のメール。null なら何も表示しない。 */
  draft: ComposeDraft | null;
  open: boolean;
  accounts: Account[];
  /** 画面の上部に出す案内 (書きかけのメールを開き直したときなど)。 */
  notice: string | null;
  /** 閉じても下書きは残る (もう一度開くと続きから書ける)。 */
  onOpenChange: (open: boolean) => void;
  onChange: (draft: ComposeDraft) => void;
  /** 送信を受け付けてもらえた。 */
  onSent: () => void;
  onDiscard: () => void;
};

/** メールの作成画面 (新規、返信、転送)。 */
export function ComposeDialog({
  draft,
  open,
  accounts,
  notice,
  onOpenChange,
  onChange,
  onSent,
  onDiscard,
}: Props) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  /** Cc / Bcc の欄を開いた下書き (送信ごとの ID で覚える)。 */
  const [extraShownFor, setExtraShownFor] = useState<string | null>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  if (!draft) return null;
  const showExtra =
    extraShownFor === draft.idempotencyKey ||
    draft.cc.trim() !== "" ||
    draft.bcc.trim() !== "";
  const set = <K extends keyof ComposeDraft>(key: K, value: ComposeDraft[K]) =>
    onChange({ ...draft, [key]: value });

  function handleOpenChange(next: boolean) {
    if (sending) return;
    if (!next) setError(null);
    onOpenChange(next);
  }

  async function handleSubmit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!draft || sending) return;
    const to = parseAddressList(draft.to);
    const cc = parseAddressList(draft.cc);
    const bcc = parseAddressList(draft.bcc);
    const invalid = [...to.invalid, ...cc.invalid, ...bcc.invalid];
    if (invalid.length > 0) {
      setError(`メールアドレスとして読み取れません: ${invalid.join("、")}`);
      return;
    }
    if (
      to.addresses.length + cc.addresses.length + bcc.addresses.length ===
      0
    ) {
      setError("宛先を入力してください。");
      toRef.current?.focus();
      return;
    }
    setError(null);
    setSending(true);
    try {
      await sendMail({
        idempotencyKey: draft.idempotencyKey,
        accountId: draft.accountId,
        to: to.addresses,
        cc: cc.addresses,
        bcc: bcc.addresses,
        subject: draft.subject,
        text: draft.text,
        mode: draft.mode,
        ...(draft.sourceMessageId
          ? { sourceMessageId: draft.sourceMessageId }
          : {}),
      });
      onSent();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      // 書きかけのまま、枠の外を押しただけで閉じてしまわないようにする。
      disablePointerDismissal
    >
      <DialogContent
        // 返信では本文の先頭、新規と転送では宛先から書き始める。
        initialFocus={draft.mode === "reply" ? bodyRef : toRef}
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 sm:max-w-2xl"
      >
        <form
          onSubmit={handleSubmit}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.ctrlKey || event.metaKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void handleSubmit();
            }
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex shrink-0 flex-col gap-1 border-b px-4 py-4 pr-14">
            <DialogTitle>{titles[draft.mode]}</DialogTitle>
            <DialogDescription className="sr-only">
              宛先、件名、本文を入力して送信します。
            </DialogDescription>
          </div>

          {notice && (
            <p className="shrink-0 border-b bg-muted/50 px-4 py-2 text-muted-foreground text-xs">
              {notice}
            </p>
          )}

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
            <div className="grid grid-cols-[4rem_1fr] items-center gap-x-2 gap-y-2">
              <Label htmlFor={`${id}-from`}>差出人</Label>
              <NativeSelect
                id={`${id}-from`}
                value={draft.accountId}
                onChange={(event) => set("accountId", event.target.value)}
                disabled={sending}
                className="w-full min-w-0"
              >
                {accounts.map((account) => (
                  <NativeSelectOption key={account.id} value={account.id}>
                    {account.displayName
                      ? `${account.displayName} <${account.email}>`
                      : account.email}
                  </NativeSelectOption>
                ))}
              </NativeSelect>

              <Label htmlFor={`${id}-to`}>宛先</Label>
              <div className="flex min-w-0 items-center gap-1">
                <Input
                  id={`${id}-to`}
                  ref={toRef}
                  type="text"
                  inputMode="email"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="複数の宛先はカンマで区切ります"
                  value={draft.to}
                  onChange={(event) => set("to", event.target.value)}
                  disabled={sending}
                />
                {!showExtra && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setExtraShownFor(draft.idempotencyKey)}
                  >
                    Cc / Bcc
                  </Button>
                )}
              </div>

              {showExtra && (
                <>
                  <Label htmlFor={`${id}-cc`}>Cc</Label>
                  <Input
                    id={`${id}-cc`}
                    type="text"
                    inputMode="email"
                    autoComplete="off"
                    spellCheck={false}
                    value={draft.cc}
                    onChange={(event) => set("cc", event.target.value)}
                    disabled={sending}
                  />
                  <Label htmlFor={`${id}-bcc`}>Bcc</Label>
                  <Input
                    id={`${id}-bcc`}
                    type="text"
                    inputMode="email"
                    autoComplete="off"
                    spellCheck={false}
                    value={draft.bcc}
                    onChange={(event) => set("bcc", event.target.value)}
                    disabled={sending}
                  />
                </>
              )}

              <Label htmlFor={`${id}-subject`}>件名</Label>
              <Input
                id={`${id}-subject`}
                type="text"
                maxLength={998}
                value={draft.subject}
                onChange={(event) => set("subject", event.target.value)}
                disabled={sending}
              />
            </div>

            <Textarea
              ref={bodyRef}
              aria-label="本文"
              value={draft.text}
              onChange={(event) => set("text", event.target.value)}
              disabled={sending}
              className="min-h-56 flex-1 resize-none leading-relaxed"
            />
          </div>

          {error && (
            <p
              role="alert"
              className="shrink-0 border-t bg-destructive/10 px-4 py-2 text-destructive text-sm"
            >
              {error}
            </p>
          )}

          <div className="flex shrink-0 items-center gap-2 border-t px-4 py-3">
            <Button
              type="button"
              variant="ghost"
              onClick={onDiscard}
              disabled={sending}
            >
              <Trash2Icon />
              破棄
            </Button>
            <span className="ml-auto hidden text-muted-foreground text-xs sm:inline">
              Ctrl+Enter で送信
            </span>
            <Button
              type="submit"
              disabled={sending}
              className="ml-auto sm:ml-0"
            >
              <SendIcon />
              {sending ? "送信中…" : "送信"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
