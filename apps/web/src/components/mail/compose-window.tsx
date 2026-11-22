"use client";

import { cn } from "cn";
import {
  BoldIcon,
  FileIcon,
  FileTextIcon,
  ImageIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  Loader2Icon,
  Maximize2Icon,
  Minimize2Icon,
  MinusIcon,
  PaperclipIcon,
  SendIcon,
  Trash2Icon,
  UnderlineIcon,
  WifiOffIcon,
  XIcon,
} from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { EmojiPickerButton } from "@/components/emoji-picker";
import { Hint } from "@/components/hint";
import { RecipientInput } from "@/components/mail/recipient-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { accountColor } from "@/lib/account-colors";
import {
  type Account,
  ApiError,
  deleteAttachment,
  forwardAttachments,
  NetworkError,
  type UploadedAttachment,
  uploadAttachment,
} from "@/lib/api";
import { attachmentErrorMessage } from "@/lib/attachments";
import {
  attachmentLimit,
  type ComposeDraft,
  htmlToText,
  MAX_ATTACHMENT_COUNT,
  replaceSignature,
  resolveRecipients,
  sanitizeHtml,
} from "@/lib/compose";
import { insertIntoField } from "@/lib/emoji/insert";
import { formatSize } from "@/lib/format";
import { sendMailOrQueue, useOnline } from "@/lib/offline";

function sendErrorOf(error: unknown, limit: number): string {
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
      case "attachment_not_found":
        return "添付ファイルがサーバーに残っていません。外してから、もう一度添付してください。";
      case "attachments_too_large":
        return `添付ファイルが大きすぎます。このアカウントでは合計 ${formatSize(limit)} までです。`;
    }
    if (error.status === 400) {
      return "入力内容に誤りがあります。宛先と件名を確認してください。";
    }
  }
  return "送信を受け付けられませんでした。時間をおいてもう一度お試しください。";
}

const titles = {
  new: "新しいメッセージ",
  reply: "返信",
  forward: "転送",
} as const;

const timeFormat = new Intl.DateTimeFormat("ja-JP", {
  hour: "2-digit",
  minute: "2-digit",
});

/** サーバーへ送っている途中の添付ファイル。 */
type Upload = {
  key: string;
  filename: string;
  contentType: string;
  size: number;
  /** 0〜1。 */
  progress: number;
  abort: () => void;
};

type Props = {
  /** 作成中のメール。null なら何も表示しない。 */
  draft: ComposeDraft | null;
  open: boolean;
  accounts: Account[];
  /** 画面の上部に出す案内 (書きかけのメールを開き直したときなど)。 */
  notice: string | null;
  /** 下書きをサーバーに保存した時刻。 */
  savedAt: Date | null;
  /**
   * 下書きをサーバーに保存できていない理由。offline は通信できず自動でやり直している、
   * rejected は内容に問題があって受け付けられなかった。
   */
  saveProblem: "offline" | "rejected" | null;
  /** 増えると、本文の入力欄を下書きの内容で作り直す (他の端末での変更を反映するとき)。 */
  contentVersion: number;
  /** 閉じても下書きは残る (下書きの一覧から続きを書ける)。 */
  onOpenChange: (open: boolean) => void;
  onChange: (draft: ComposeDraft) => void;
  /** 送信を始める前に呼ぶ。下書きの保存を止めるのを待ってから送信する。 */
  onBeforeSend: () => Promise<void>;
  /** 送信を受け付けてもらえなかった。下書きの保存を再開する。 */
  onSendFailed: () => void;
  /** 送信を受け付けてもらえた。 */
  onSent: () => void;
  onDiscard: () => void;
};

const MAXIMIZED_KEY = "mail.compose-maximized.v1";

function loadMaximized(): boolean {
  try {
    return window.localStorage.getItem(MAXIMIZED_KEY) === "on";
  } catch {
    return false;
  }
}

function storeMaximized(maximized: boolean): void {
  try {
    if (maximized) window.localStorage.setItem(MAXIMIZED_KEY, "on");
    else window.localStorage.removeItem(MAXIMIZED_KEY);
  } catch {
    // 保存できない環境では、次に開いたときに元の大きさに戻るだけ。
  }
}

/**
 * メールの作成画面 (新規、返信、転送)。
 * 広い画面では右下に浮かぶ窓で、開いたままほかのメールを読める。狭い画面では全画面になる。
 */
export function ComposeWindow({
  draft,
  open,
  accounts,
  notice,
  savedAt,
  saveProblem,
  contentVersion,
  onOpenChange,
  onChange,
  onBeforeSend,
  onSendFailed,
  onSent,
  onDiscard,
}: Props) {
  const id = useId();
  const online = useOnline();
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [minimized, setMinimized] = useState(false);
  /** 画面いっぱいに広げているか。次に開くときのために端末ごとに覚えておく。 */
  const [maximized, setMaximized] = useState(loadMaximized);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  /** Cc / Bcc の欄を開いた下書き (送信ごとの ID で覚える)。 */
  const [extraShownFor, setExtraShownFor] = useState<string | null>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** 送信中の処理から、最新の下書きを読むためのもの。 */
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  /**
   * 下書きを変える。変更は必ず最新の下書きに対して行い、次の描画を待たずに draftRef へ反映する。
   * 添付ファイルの送信が同時にいくつも終わったとき、どれも描画前の同じ下書きに足してしまい、
   * 最後の 1 件しか残らなかったことがあるため。
   */
  const commit = useCallback(
    (update: (latest: ComposeDraft) => ComposeDraft) => {
      const latest = draftRef.current;
      if (!latest) return;
      const next = update(latest);
      draftRef.current = next;
      onChangeRef.current(next);
    },
    [],
  );
  const uploadsRef = useRef(uploads);
  uploadsRef.current = uploads;

  const draftKey = draft?.idempotencyKey ?? null;
  const mode = draft?.mode;

  // 別の下書きに切り替わったら、前の下書きの送信途中のファイルは止める。
  // biome-ignore lint/correctness/useExhaustiveDependencies: draftKey は切り替わりのきっかけとして使う
  useEffect(() => {
    setError(null);
    setMinimized(false);
    return () => {
      for (const upload of uploadsRef.current) upload.abort();
      setUploads([]);
    };
  }, [draftKey]);

  // 開いたときに、返信では本文の先頭、新規と転送では宛先から書き始める。
  useEffect(() => {
    if (!open || minimized || !draftKey) return;
    if (mode === "reply") {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      const range = document.createRange();
      range.setStart(editor, 0);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      editor.scrollTop = 0;
    } else {
      toRef.current?.focus();
    }
  }, [open, minimized, draftKey, mode]);

  // 転送では、元のメールの添付ファイルを送信用に複製してもらう。
  // サーバーがメールサーバーから取得し終えるまで待つので、その間は「取得中」として並べる。
  const forwardPending = (draft?.forwardAttachments?.files.length ?? 0) > 0;
  useEffect(() => {
    const source = draftRef.current?.forwardAttachments;
    if (!forwardPending || !draftKey || !source) return;
    const controller = new AbortController();
    const ids = source.files.map((file) => file.id);
    forwardAttachments(source.messageId, ids, controller.signal)
      .then((copied) => {
        const latest = draftRef.current;
        const wanted =
          !controller.signal.aborted && latest?.idempotencyKey === draftKey
            ? new Set(latest.forwardAttachments?.files.map((file) => file.id))
            : new Set<string>();
        // 待っている間に外されたものは、複製をサーバーから消す。
        const kept = copied.filter((file, index) => {
          if (wanted.has(ids[index] ?? "")) return true;
          void deleteAttachment(file.id).catch(() => {});
          return false;
        });
        if (!latest || latest.idempotencyKey !== draftKey) return;
        if (controller.signal.aborted) return;
        commit((current) => ({
          ...current,
          attachments: [...current.attachments, ...kept],
          forwardAttachments: null,
        }));
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        const latest = draftRef.current;
        if (!latest || latest.idempotencyKey !== draftKey) return;
        setError(
          `元のメールの添付ファイルを付けられませんでした。${attachmentErrorMessage(
            cause instanceof ApiError ? cause.code : null,
          )}`,
        );
        commit((current) => ({ ...current, forwardAttachments: null }));
      });
    return () => controller.abort();
  }, [draftKey, forwardPending, commit]);

  const addFiles = useCallback(
    (files: File[]) => {
      const current = draftRef.current;
      if (!current || files.length === 0) return;
      const account = accounts.find((item) => item.id === current.accountId);
      const limit = attachmentLimit(account ?? { protocol: "imap" });
      let total =
        current.attachments.reduce((sum, file) => sum + file.size, 0) +
        uploadsRef.current.reduce((sum, file) => sum + file.size, 0);
      let count = current.attachments.length + uploadsRef.current.length;
      setError(null);
      for (const file of files) {
        if (count + 1 > MAX_ATTACHMENT_COUNT) {
          setError(`添付できるのは ${MAX_ATTACHMENT_COUNT} 件までです。`);
          break;
        }
        if (total + file.size > limit) {
          setError(
            `「${file.name}」は添付できません。このアカウントでは、添付ファイルは合計 ${formatSize(limit)} までです。`,
          );
          continue;
        }
        total += file.size;
        count++;
        const key = crypto.randomUUID();
        const owner = current.idempotencyKey;
        const { promise, abort } = uploadAttachment(file, (progress) =>
          setUploads((list) =>
            list.map((item) =>
              item.key === key ? { ...item, progress } : item,
            ),
          ),
        );
        setUploads((list) => [
          ...list,
          {
            key,
            filename: file.name,
            contentType: file.type,
            size: file.size,
            progress: 0,
            abort,
          },
        ]);
        promise
          .then((uploaded) => {
            const latest = draftRef.current;
            // 送っている間に下書きが破棄されていたら、サーバーからも消す。
            if (!latest || latest.idempotencyKey !== owner) {
              void deleteAttachment(uploaded.id).catch(() => {});
              return;
            }
            commit((current) => ({
              ...current,
              attachments: [...current.attachments, uploaded],
            }));
          })
          .catch((cause) => {
            if (cause instanceof DOMException && cause.name === "AbortError") {
              return;
            }
            setError(
              cause instanceof ApiError && cause.status === 413
                ? `「${file.name}」は大きすぎるため添付できません。`
                : `「${file.name}」を添付できませんでした。もう一度お試しください。`,
            );
          })
          .finally(() =>
            setUploads((list) => list.filter((item) => item.key !== key)),
          );
      }
    },
    [accounts, commit],
  );

  if (!draft || !open) return null;

  const showExtra =
    extraShownFor === draft.idempotencyKey ||
    draft.cc.list.length > 0 ||
    draft.cc.text.trim() !== "" ||
    draft.bcc.list.length > 0 ||
    draft.bcc.text.trim() !== "";
  const set = <K extends keyof ComposeDraft>(key: K, value: ComposeDraft[K]) =>
    commit((current) => ({ ...current, [key]: value }));
  const account = accounts.find((item) => item.id === draft.accountId);
  const limit = attachmentLimit(account ?? { protocol: "imap" });
  const pendingFiles = draft.forwardAttachments?.files ?? [];
  const uploading = uploads.length > 0 || pendingFiles.length > 0;

  /** 差出人を変える。本文の署名も、選んだアカウントのものに入れ替える。 */
  function changeAccount(accountId: string) {
    if (!draft) return;
    const next = accounts.find((item) => item.id === accountId);
    const editor = editorRef.current;
    const html = replaceSignature(
      editor?.innerHTML ?? draft.html,
      next?.signatureHtml,
    );
    if (editor) editor.innerHTML = html;
    commit((current) => ({ ...current, accountId, html }));
  }

  function removeAttachment(file: UploadedAttachment) {
    if (!draft) return;
    commit((current) => ({
      ...current,
      attachments: current.attachments.filter((item) => item.id !== file.id),
    }));
    void deleteAttachment(file.id).catch(() => {});
  }

  async function handleSubmit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!draft || sending) return;
    if (uploading) {
      setError(
        "添付ファイルを送っている途中です。終わってから送信してください。",
      );
      return;
    }
    const to = resolveRecipients(draft.to);
    const cc = resolveRecipients(draft.cc);
    const bcc = resolveRecipients(draft.bcc);
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
    if (draft.attachments.reduce((sum, file) => sum + file.size, 0) > limit) {
      setError(
        `添付ファイルが大きすぎます。このアカウントでは合計 ${formatSize(limit)} までです。`,
      );
      return;
    }
    const html = sanitizeHtml(editorRef.current?.innerHTML ?? draft.html);
    setError(null);
    setSending(true);
    try {
      // 送信のあとから保存が届くと、送ったはずの下書きが残ってしまう。
      await onBeforeSend();
      // サーバーに届かなければ端末で預かり、接続後に自動で送る。
      await sendMailOrQueue(
        {
          idempotencyKey: draft.idempotencyKey,
          accountId: draft.accountId,
          to: to.addresses,
          cc: cc.addresses,
          bcc: bcc.addresses,
          subject: draft.subject,
          text: htmlToText(html),
          html,
          attachmentIds: draft.attachments.map((file) => file.id),
          mode: draft.mode,
          ...(draft.sourceMessageId
            ? { sourceMessageId: draft.sourceMessageId }
            : {}),
        },
        draft.attachments,
      );
      onSent();
    } catch (cause) {
      setError(sendErrorOf(cause, limit));
      onSendFailed();
    } finally {
      setSending(false);
    }
  }

  function handleDiscard() {
    for (const upload of uploads) upload.abort();
    for (const file of draft?.attachments ?? []) {
      void deleteAttachment(file.id).catch(() => {});
    }
    onDiscard();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void handleSubmit();
    } else if (event.key === "Escape") {
      // 入力中に Esc を押しても内容は消さず、窓を畳むだけにする。
      event.preventDefault();
      event.stopPropagation();
      setMinimized(true);
    }
  }

  function toggleMaximized() {
    setMaximized((current) => {
      storeMaximized(!current);
      return !current;
    });
  }

  function handleDrop(event: DragEvent<HTMLFormElement>) {
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    setDragging(false);
    addFiles([...event.dataTransfer.files]);
  }

  const title = draft.subject.trim() || titles[draft.mode];
  const saved = saveProblem ? (
    <span className="truncate text-destructive text-xs">
      {saveProblem === "offline"
        ? "下書きを保存できていません。接続が戻ると保存します"
        : "下書きを保存できません。宛先と添付ファイルを確認してください"}
    </span>
  ) : (
    savedAt && (
      <span className="truncate text-muted-foreground text-xs">
        下書きを保存しました {timeFormat.format(savedAt)}
      </span>
    )
  );

  if (minimized) {
    return (
      <section
        aria-label="作成中のメール"
        className="fixed right-4 bottom-0 z-40 flex w-80 max-w-[calc(100vw-2rem)] items-center gap-1 rounded-t-xl border border-b-0 bg-popover py-1.5 pr-1.5 pl-4 text-popover-foreground shadow-lg"
      >
        <button
          type="button"
          onClick={() => setMinimized(false)}
          className="min-w-0 flex-1 truncate py-1 text-left font-medium text-sm outline-none focus-visible:underline"
        >
          {title}
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="作成画面を広げる"
          onClick={() => setMinimized(false)}
        >
          <MinusIcon className="rotate-180" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="閉じる (下書きは残ります)"
          onClick={() => onOpenChange(false)}
        >
          <XIcon />
        </Button>
      </section>
    );
  }

  return (
    <section
      aria-label="メールの作成"
      data-maximized={maximized || undefined}
      className={cn(
        "fixed inset-0 z-40 flex flex-col bg-popover text-popover-foreground sm:shadow-2xl",
        maximized
          ? "sm:inset-4 sm:rounded-xl sm:border"
          : "sm:inset-auto sm:right-4 sm:bottom-0 sm:h-[min(44rem,calc(100dvh-5rem))] sm:w-[min(40rem,calc(100vw-2rem))] sm:rounded-t-xl sm:border sm:border-b-0",
      )}
    >
      <form
        onSubmit={handleSubmit}
        onKeyDown={handleKeyDown}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node)) return;
          setDragging(false);
        }}
        onDrop={handleDrop}
        className="relative flex min-h-0 flex-1 flex-col"
      >
        {/* 狭い画面: 閉じる、題名、添付、送信を上に並べる。 */}
        <header className="flex h-14 shrink-0 items-center gap-1 border-b px-2 sm:hidden">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="閉じる (下書きは残ります)"
            onClick={() => onOpenChange(false)}
          >
            <XIcon />
          </Button>
          <h2 className="min-w-0 flex-1 truncate font-semibold text-base">
            {titles[draft.mode]}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="ファイルを添付"
            disabled={sending}
            onClick={() => fileRef.current?.click()}
          >
            <PaperclipIcon />
          </Button>
          <Button type="submit" disabled={sending || uploading}>
            <SendIcon />
            {sending ? "送信中…" : "送信"}
          </Button>
        </header>

        {/* 広い画面: 窓の見出し。 */}
        <header className="hidden h-12 shrink-0 items-center gap-2 border-b pr-2 pl-4 sm:flex">
          <h2 className="shrink-0 font-semibold text-sm">
            {titles[draft.mode]}
          </h2>
          <span className="min-w-0 flex-1 truncate">{saved}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="作成画面を畳む"
            onClick={() => setMinimized(true)}
          >
            <MinusIcon />
          </Button>
          <Hint label={maximized ? "元の大きさに戻す" : "最大化"}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={maximized ? "元の大きさに戻す" : "最大化"}
              aria-pressed={maximized}
              onClick={toggleMaximized}
            >
              {maximized ? <Minimize2Icon /> : <Maximize2Icon />}
            </Button>
          </Hint>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="閉じる (下書きは残ります)"
            onClick={() => onOpenChange(false)}
          >
            <XIcon />
          </Button>
        </header>

        {notice && (
          <p className="shrink-0 border-b bg-muted/50 px-4 py-2 text-muted-foreground text-xs">
            {notice}
          </p>
        )}

        <Row label="差出人" htmlFor={`${id}-from`}>
          <div className="relative min-w-0 max-w-full">
            <span
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute top-1/2 left-3 z-10 size-2 -translate-y-1/2 rounded-full",
                accountColor(accounts, draft.accountId),
              )}
            />
            <Select
              items={accounts.map((item) => ({
                value: item.id,
                label: item.displayName
                  ? `${item.displayName} <${item.email}>`
                  : item.email,
              }))}
              value={draft.accountId}
              onValueChange={(next) => {
                if (next) changeAccount(next);
              }}
              disabled={sending}
            >
              <SelectTrigger
                id={`${id}-from`}
                size="sm"
                className="w-auto max-w-full pl-7 *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:truncate"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                align="start"
                className="w-auto max-w-[calc(100vw-1rem)]"
              >
                {accounts.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          accountColor(accounts, item.id),
                        )}
                      />
                      {item.displayName
                        ? `${item.displayName} <${item.email}>`
                        : item.email}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </Row>

        <Row label="宛先" htmlFor={`${id}-to`}>
          <RecipientInput
            id={`${id}-to`}
            inputRef={toRef}
            value={draft.to}
            onChange={(value) => set("to", value)}
            disabled={sending}
          />
          {!showExtra && (
            <button
              type="button"
              onClick={() => setExtraShownFor(draft.idempotencyKey)}
              className="shrink-0 rounded-sm px-1 text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Cc Bcc
            </button>
          )}
        </Row>
        {showExtra && (
          <>
            <Row label="Cc" htmlFor={`${id}-cc`}>
              <RecipientInput
                id={`${id}-cc`}
                value={draft.cc}
                onChange={(value) => set("cc", value)}
                disabled={sending}
              />
            </Row>
            <Row label="Bcc" htmlFor={`${id}-bcc`}>
              <RecipientInput
                id={`${id}-bcc`}
                value={draft.bcc}
                onChange={(value) => set("bcc", value)}
                disabled={sending}
              />
            </Row>
          </>
        )}
        <Row label="件名" htmlFor={`${id}-subject`}>
          <input
            ref={subjectRef}
            id={`${id}-subject`}
            type="text"
            maxLength={998}
            value={draft.subject}
            onChange={(event) => set("subject", event.target.value)}
            disabled={sending}
            className="h-7 min-w-0 flex-1 bg-transparent font-medium text-base outline-none md:text-sm"
          />
          <EmojiPickerButton
            label="件名に絵文字を入れる"
            size="icon-sm"
            disabled={sending}
            onSelect={(emoji) =>
              insertIntoField(
                subjectRef.current,
                subjectRef.current?.value ?? "",
                emoji,
                (next) => set("subject", next),
              )
            }
            className="-mr-2 text-muted-foreground"
          />
        </Row>

        <Editor
          key={`${draft.idempotencyKey}:${contentVersion}`}
          editorRef={editorRef}
          initialHtml={draft.html}
          disabled={sending}
          onChange={(html) => set("html", html)}
          onFiles={addFiles}
          toolbar={(format) => (
            <div className="flex shrink-0 items-center gap-1 border-t px-3 py-2">
              <Button
                type="submit"
                disabled={sending || uploading}
                className="hidden sm:inline-flex"
              >
                <SendIcon />
                {sending ? "送信中…" : "送信"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="ファイルを添付"
                disabled={sending}
                onClick={() => fileRef.current?.click()}
                className="hidden sm:inline-flex"
              >
                <PaperclipIcon />
              </Button>
              <span
                className="mx-1 hidden h-5 w-px shrink-0 bg-border sm:block"
                aria-hidden="true"
              />
              {format}
              <Hint label="下書きを破棄" side="top">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="下書きを破棄"
                  disabled={sending}
                  onClick={handleDiscard}
                  className="ml-auto"
                >
                  <Trash2Icon />
                </Button>
              </Hint>
            </div>
          )}
        >
          {(draft.attachments.length > 0 || uploading) && (
            <ul
              aria-label="添付ファイル"
              className="flex shrink-0 flex-wrap gap-2 px-4 pb-3"
            >
              {draft.attachments.map((file) => (
                <li
                  key={file.id}
                  className="flex h-9 max-w-full items-center gap-2 rounded-md border pr-1 pl-2.5 text-sm"
                >
                  <FileTypeIcon contentType={file.contentType} />
                  <span className="truncate">{file.filename}</span>
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {formatSize(file.size)}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`${file.filename} を外す`}
                    disabled={sending}
                    onClick={() => removeAttachment(file)}
                  >
                    <XIcon />
                  </Button>
                </li>
              ))}
              {pendingFiles.map((file) => (
                <li
                  key={file.id}
                  className="flex h-9 max-w-full items-center gap-2 rounded-md border pr-1 pl-2.5 text-sm"
                >
                  <FileTypeIcon contentType={file.contentType} />
                  <span className="truncate">{file.filename}</span>
                  <output className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
                    <Loader2Icon
                      className="size-3 animate-spin"
                      aria-hidden="true"
                    />
                    取得中
                  </output>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`${file.filename} を外す`}
                    onClick={() =>
                      draft.forwardAttachments &&
                      set("forwardAttachments", {
                        ...draft.forwardAttachments,
                        files: pendingFiles.filter(
                          (item) => item.id !== file.id,
                        ),
                      })
                    }
                  >
                    <XIcon />
                  </Button>
                </li>
              ))}
              {uploads.map((file) => {
                const percent = Math.round(file.progress * 100);
                return (
                  <li
                    key={file.key}
                    className="flex h-9 max-w-full items-center gap-2 rounded-md border pr-1 pl-2.5 text-sm"
                  >
                    <FileTypeIcon contentType={file.contentType} />
                    <span className="truncate">{file.filename}</span>
                    <Progress
                      aria-label={`${file.filename} を送信中`}
                      value={percent}
                      className="w-20 shrink-0"
                    />
                    <span className="w-9 shrink-0 text-right text-muted-foreground text-xs tabular-nums">
                      {percent}%
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`${file.filename} の添付を中止`}
                      onClick={file.abort}
                    >
                      <XIcon />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="shrink-0 px-4 pb-2 text-muted-foreground text-xs sm:hidden">
            {saved}
          </p>
          {!online && (
            <p className="flex shrink-0 items-center gap-2 border-t bg-muted/50 px-4 py-2 text-muted-foreground text-xs">
              <WifiOffIcon className="size-3.5 shrink-0" aria-hidden="true" />
              オフラインです。送信すると、接続後に自動で送られます。
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="shrink-0 border-t bg-destructive/10 px-4 py-2 text-destructive text-sm"
            >
              {error}
            </p>
          )}
        </Editor>

        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          aria-label="添付するファイル"
          onChange={(event) => {
            addFiles([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-t-xl border-2 border-primary border-dashed bg-background/80 font-medium text-sm">
            ここにファイルを置くと添付します
          </div>
        )}
      </form>
    </section>
  );
}

function Row({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-12 shrink-0 items-center gap-2 border-b px-4 py-2">
      <label
        htmlFor={htmlFor}
        className="w-14 shrink-0 text-muted-foreground text-sm"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function FileTypeIcon({ contentType }: { contentType: string }) {
  const className = "size-4 shrink-0";
  if (contentType.startsWith("image/")) {
    return <ImageIcon className={cn(className, "text-sky-600")} />;
  }
  if (contentType === "application/pdf" || contentType.startsWith("text/")) {
    return <FileTextIcon className={cn(className, "text-red-600")} />;
  }
  return <FileIcon className={cn(className, "text-muted-foreground")} />;
}

type FormatCommand = "bold" | "italic" | "underline" | "insertUnorderedList";

const formats: { command: FormatCommand; label: string; icon: ReactNode }[] = [
  { command: "bold", label: "太字", icon: <BoldIcon /> },
  { command: "italic", label: "斜体", icon: <ItalicIcon /> },
  { command: "underline", label: "下線", icon: <UnderlineIcon /> },
  { command: "insertUnorderedList", label: "箇条書き", icon: <ListIcon /> },
];

/**
 * 本文の入力欄 (書式付き) と、書式のボタン。
 * 内容はブラウザーの編集機能 (contentEditable) に任せ、変わるたびに HTML を親へ伝える。
 * children は入力欄とツールバーの間に置くもの (添付ファイルの一覧など)。
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
  toolbar: (format: ReactNode) => ReactNode;
  children?: ReactNode;
}) {
  const [active, setActive] = useState<Record<string, boolean>>({});
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  /** リンクや絵文字を入れる範囲。ほかの入力欄へ移る前の選択を覚えておく。 */
  const savedRange = useRef<Range | null>(null);
  const linkRef = useRef<HTMLInputElement>(null);

  // 最初の内容を入れる。保存してあった下書きも通るので、許可したタグだけに整えてから入れる。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 入れるのは最初の 1 回だけ (以後は入力欄が内容を持つ)
  useLayoutEffect(() => {
    if (editorRef.current) {
      editorRef.current.innerHTML = sanitizeHtml(initialHtml);
    }
  }, []);

  const refreshActive = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.anchorNode) return;
    if (!editor.contains(selection.anchorNode)) return;
    const next: Record<string, boolean> = {};
    for (const { command } of formats) {
      try {
        next[command] = document.queryCommandState(command);
      } catch {
        next[command] = false;
      }
    }
    setActive(next);
  }, [editorRef]);

  useEffect(() => {
    document.addEventListener("selectionchange", refreshActive);
    return () => document.removeEventListener("selectionchange", refreshActive);
  }, [refreshActive]);

  const emit = () => onChange(editorRef.current?.innerHTML ?? "");

  function run(command: FormatCommand) {
    editorRef.current?.focus();
    document.execCommand(command);
    emit();
    refreshActive();
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

  /** 本文の中の選択範囲を覚える (ほかの入力欄へフォーカスが移る前に呼ぶ)。 */
  function saveRange() {
    const selection = window.getSelection();
    const editor = editorRef.current;
    savedRange.current =
      selection &&
      selection.rangeCount > 0 &&
      editor?.contains(selection.anchorNode)
        ? selection.getRangeAt(0).cloneRange()
        : null;
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

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: 書式付きの入力欄は textarea では作れない */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: クリックで起きるページ移動を止めるだけで、操作は割り当てていない */}
      <div
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        tabIndex={0}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={emit}
        onPaste={handlePaste}
        // 本文の中のリンクを押しても、ページを移動しない。
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("a"))
            event.preventDefault();
        }}
        className="min-h-40 flex-1 overflow-y-auto break-words px-4 py-3 text-base leading-relaxed outline-none md:text-sm [&_a]:text-primary [&_a]:underline [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_h1]:font-semibold [&_h1]:text-lg [&_h2]:font-semibold [&_h2]:text-base [&_h3]:font-semibold [&_hr]:my-2 [&_ol]:list-decimal [&_pre]:whitespace-pre-wrap [&_td]:pr-3 [&_td]:align-top [&_th]:pr-3 [&_th]:text-left [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6"
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
      {toolbar(
        <>
          {formats.map(({ command, label, icon }) => (
            <Hint key={command} label={label} side="top">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={label}
                aria-pressed={active[command] ?? false}
                disabled={disabled}
                // 押しても本文の選択が外れないようにする。
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => run(command)}
                className="aria-pressed:bg-muted"
              >
                {icon}
              </Button>
            </Hint>
          ))}
          <Hint label="リンク" side="top">
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
