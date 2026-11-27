"use client";

import { cn } from "cn";
import {
  AppWindowIcon,
  EllipsisVerticalIcon,
  FileIcon,
  FileTextIcon,
  ImageIcon,
  Maximize2Icon,
  Minimize2Icon,
  MinusIcon,
  PaperclipIcon,
  SendIcon,
  Trash2Icon,
  WifiOffIcon,
  XIcon,
} from "lucide-react";
import {
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { EmojiPickerButton } from "@/components/emoji-picker";
import { Hint } from "@/components/hint";
import { Editor, TextEditor } from "@/components/mail/editor";
import { RecipientInput } from "@/components/mail/recipient-input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { AccountMark } from "@/lib/account-icons";
import {
  type Account,
  ApiError,
  deleteAttachment,
  forwardAttachments,
  NetworkError,
  type SignatureRule,
  type UploadedAttachment,
  uploadAttachment,
} from "@/lib/api";
import { attachmentErrorMessage } from "@/lib/attachments";
import {
  attachmentLimit,
  type ComposeDraft,
  canSendFrom,
  draftAsFormat,
  draftBody,
  draftSignature,
  hasFormatting,
  isTextDraft,
  MAX_ATTACHMENT_COUNT,
  NO_SENDABLE_ACCOUNT,
  RECEIVE_ONLY_SEND_ERROR,
  replaceSignature,
  replaceTextSignature,
  resolveRecipients,
  senderAccount,
} from "@/lib/compose";
import { useDateStyle } from "@/lib/date-format-settings";
import { setTitleBarTitle } from "@/lib/desktop/title-bar-menu";
import { insertIntoField } from "@/lib/emoji/insert";
import { formatShortTime, formatSize } from "@/lib/format";
import { sendMailOrQueue, useOnline } from "@/lib/offline";
import { randomUuid } from "@/lib/uuid";

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
      case "receive_only":
        return RECEIVE_ONLY_SEND_ERROR;
      case "attachment_not_found":
        return "添付ファイルがサーバーに残っていません。外してから、もう一度添付してください。";
      case "attachments_too_large":
        return `添付ファイルが大きすぎます。このアカウントでは合計 ${formatSize(limit)} までです。`;
    }
    if (error.status === 400) {
      return "入力内容に誤りがあります。宛先と件名を確認してください。";
    }
  }
  return "送信できませんでした。時間をおいてもう一度お試しください。";
}

const titles = {
  new: "新しいメール",
  reply: "返信",
  forward: "転送",
} as const;

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
  /** 連絡先ごと、会話ごとの署名。宛先や差出人が変わったら、本文の署名を入れ替える。 */
  signatureRules?: readonly SignatureRule[];
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
  /** 作成画面を新しいウィンドウへ移す。移せない環境 (スマホアプリ) では渡さない。 */
  onPopOut?: () => void;
  /**
   * 作成画面だけを出すウィンドウ (デスクトップ版の新規作成など)。ウィンドウいっぱいに広げ、
   * 折りたたみ・最大化・新しいウィンドウで開くボタンは出さない。閉じるとウィンドウも閉じる。
   */
  standalone?: boolean;
  onChange: (draft: ComposeDraft) => void;
  /** 送信を始める前に呼ぶ。下書きの保存を止めるのを待ってから送信する。 */
  onBeforeSend: () => Promise<void>;
  /** 送信を受け付けてもらえなかった。下書きの保存を再開する。 */
  onSendFailed: () => void;
  /** 送信を受け付けてもらえた。 */
  onSent: () => void;
  onDiscard: () => void;
};

const NO_RULES: readonly SignatureRule[] = [];

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
  signatureRules = NO_RULES,
  notice,
  savedAt,
  saveProblem,
  contentVersion,
  onOpenChange,
  onPopOut,
  standalone = false,
  onChange,
  onBeforeSend,
  onSendFailed,
  onSent,
  onDiscard,
}: Props) {
  const dateStyle = useDateStyle();
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
  /** テキストだけで書くときの入力欄。 */
  const textRef = useRef<HTMLTextAreaElement>(null);
  /** 書式付きからテキストに切り替える前の確認を出しているか。 */
  const [confirmPlain, setConfirmPlain] = useState(false);
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
  const plain = draft ? isTextDraft(draft) : false;

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: 形式を切り替えたときは書き始めの位置に戻さない (plain は入れない)
  useEffect(() => {
    if (!open || minimized || !draftKey) return;
    if (mode === "reply" && plain) {
      const text = textRef.current;
      if (!text) return;
      text.focus();
      text.setSelectionRange(0, 0);
      text.scrollTop = 0;
    } else if (mode === "reply") {
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
        const key = randomUuid();
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

  /** 差出人を変える処理。描画のたびに最新のものに差し替える (下の effect から呼ぶため)。 */
  const changeAccountRef = useRef<(accountId: string) => void>(() => {});
  const draftAccountId = draft?.accountId ?? null;
  // 受信専用のアカウントが差出人になっていたら (送信サーバーを外す前に書いた下書きなど)、
  // 送信できるアカウントに切り替える。署名もそのアカウントのものに入れ替わる。
  useEffect(() => {
    if (!open || !draftAccountId) return;
    const current = accounts.find((item) => item.id === draftAccountId);
    if (!current || canSendFrom(current)) return;
    const next = senderAccount(accounts, draftAccountId);
    if (next) changeAccountRef.current(next.id);
  }, [open, draftAccountId, accounts]);

  // 作成専用のウィンドウでは、件名をタイトルバーに出す (「件名 ― Orbit Mail」)。
  const windowName = draft ? draft.subject.trim() || titles[draft.mode] : null;
  useEffect(() => {
    if (!standalone) return;
    setTitleBarTitle(windowName);
  }, [standalone, windowName]);
  useEffect(() => {
    if (!standalone) return;
    return () => setTitleBarTitle(null);
  }, [standalone]);

  if (!draft || !open) return null;

  // ほかの欄で選び済みの宛先は、候補に出さない。
  const chosenAddresses = [
    ...draft.to.list,
    ...draft.cc.list,
    ...draft.bcc.list,
  ].map((entry) => entry.address);
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
  /** 差出人に選べるアカウント。受信専用のアカウントは送信できないので除く。 */
  const senders = accounts.filter(canSendFrom);
  /** 今の差出人から送れるか。受信専用のアカウントのままなら送れない。 */
  const canSend = !account || canSendFrom(account);
  /** 送れないときの案内。送信できるアカウントが 1 つも無いか、差出人が受信専用か。 */
  const senderProblem = canSend
    ? null
    : senders.length === 0
      ? NO_SENDABLE_ACCOUNT
      : RECEIVE_ONLY_SEND_ERROR;
  // 差出人の選択肢。今の差出人が受信専用なら、選べない項目として残して表示だけする。
  const fromChoices = canSend || !account ? senders : [...senders, account];
  /** アイコンを選んだアカウントがあれば、色の点も同じ幅に置いて、名前の頭をそろえる。 */
  const fromMarkClass = fromChoices.some((item) => item.icon !== null)
    ? "size-5"
    : undefined;
  const pendingFiles = draft.forwardAttachments?.files ?? [];
  const uploading = uploads.length > 0 || pendingFiles.length > 0;

  /**
   * 差出人や宛先を変える。変えたことで使う署名 (会話、連絡先、アカウントの順に探す) が
   * 変わるときだけ、本文の署名を入れ替える。変わらなければ、手で直した署名もそのまま残る。
   */
  function changeWithSignature(update: (latest: ComposeDraft) => ComposeDraft) {
    commit((current) => {
      const next = update(current);
      const before = draftSignature(current, accounts, signatureRules).html;
      const after = draftSignature(next, accounts, signatureRules).html;
      if ((before ?? "") === (after ?? "")) return next;
      if (isTextDraft(next)) {
        return {
          ...next,
          text: replaceTextSignature(next.text ?? "", before, after),
        };
      }
      const editor = editorRef.current;
      const html = replaceSignature(editor?.innerHTML ?? next.html, after);
      if (editor) editor.innerHTML = html;
      return { ...next, html };
    });
  }

  function changeAccount(accountId: string) {
    changeWithSignature((current) => ({ ...current, accountId }));
  }
  changeAccountRef.current = changeAccount;

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
    // 送れない理由は差出人の下に出しているので、ここでは送らないだけにする。
    if (senderProblem) return;
    if (uploading) {
      setError(
        "添付ファイルをアップロードしています。完了してから送信してください。",
      );
      return;
    }
    const to = resolveRecipients(draft.to);
    const cc = resolveRecipients(draft.cc);
    const bcc = resolveRecipients(draft.bcc);
    const invalid = [...to.invalid, ...cc.invalid, ...bcc.invalid];
    if (invalid.length > 0) {
      setError(`メールアドレスの形式が正しくありません: ${invalid.join("、")}`);
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
    const body = draftBody(draft, editorRef.current?.innerHTML);
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
          text: body.text,
          // テキストだけで書いたメールは、HTML を付けずに送る。
          ...(body.html !== null ? { html: body.html } : {}),
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
        ? "下書きを保存できていません。接続が戻りしだい保存します"
        : "下書きを保存できません。宛先と添付ファイルを確認してください"}
    </span>
  ) : (
    savedAt && (
      <span className="truncate text-muted-foreground text-xs">
        下書きを保存しました {formatShortTime(savedAt, dateStyle)}
      </span>
    )
  );

  if (minimized && !standalone) {
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
          aria-label="作成画面を展開"
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

  /**
   * 書式付きとテキストを切り替える。書式付きからテキストにすると失われる書式があれば、先に確かめる。
   */
  function changeFormat(next: "html" | "text", confirmed = false) {
    if (!draft) return;
    if (next === "text" && !plain && !confirmed) {
      const html = editorRef.current?.innerHTML ?? draft.html;
      if (hasFormatting(html)) {
        setConfirmPlain(true);
        return;
      }
    }
    commit((current) =>
      draftAsFormat(
        next === "text" && editorRef.current
          ? { ...current, html: editorRef.current.innerHTML }
          : current,
        next,
      ),
    );
  }

  const renderToolbar = (format: ReactNode) => (
    <div className="flex shrink-0 items-center gap-1 border-t px-3 py-2">
      <Button
        type="submit"
        disabled={sending || uploading || !canSend}
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
      <DropdownMenu>
        <Hint label="その他のオプション" side="top">
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="その他のオプション"
                disabled={sending}
              />
            }
          >
            <EllipsisVerticalIcon />
          </DropdownMenuTrigger>
        </Hint>
        <DropdownMenuContent
          align="start"
          side="top"
          className="w-auto min-w-56"
        >
          <DropdownMenuCheckboxItem
            checked={plain}
            onCheckedChange={(checked) =>
              changeFormat(checked ? "text" : "html")
            }
          >
            テキストのみ (書式なし)
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
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
  );

  const extras = (
    <>
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
                <Spinner className="size-3" />
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
                    files: pendingFiles.filter((item) => item.id !== file.id),
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
      <p
        className={cn(
          "shrink-0 px-4 pb-2 text-muted-foreground text-xs",
          // 広い画面では見出しに出す (見出しの無い作成専用のウィンドウを除く)。
          !standalone && "sm:hidden",
        )}
      >
        {saved}
      </p>
      {!online && (
        <p className="flex shrink-0 items-center gap-2 border-t bg-muted/50 px-4 py-2 text-muted-foreground text-xs">
          <WifiOffIcon className="size-3.5 shrink-0" aria-hidden="true" />
          オフラインです。送信したメールは、接続後に自動で送られます。
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
    </>
  );

  return (
    <section
      aria-label="メールの作成"
      data-maximized={maximized || undefined}
      className={cn(
        "fixed inset-0 top-(--titlebar-height) z-40 flex flex-col bg-popover text-popover-foreground sm:shadow-2xl",
        standalone
          ? "sm:shadow-none"
          : maximized
            ? "sm:inset-4 sm:top-[calc(var(--titlebar-height)+1rem)] sm:rounded-xl sm:border"
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
          {!standalone && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="閉じる (下書きは残ります)"
              onClick={() => onOpenChange(false)}
            >
              <XIcon />
            </Button>
          )}
          {/* 作成専用のウィンドウでは、題名はタイトルバーに出している。 */}
          <h2
            className={cn(
              "min-w-0 flex-1 truncate font-semibold text-base",
              standalone && "sr-only",
            )}
          >
            {titles[draft.mode]}
          </h2>
          {standalone && <span className="flex-1" />}
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
          <Button type="submit" disabled={sending || uploading || !canSend}>
            <SendIcon />
            {sending ? "送信中…" : "送信"}
          </Button>
        </header>

        {/* 広い画面: 窓の見出し。作成専用のウィンドウでは、題名はタイトルバーに出すので置かない。 */}
        <header
          className={cn(
            "hidden h-12 shrink-0 items-center gap-2 border-b pr-2 pl-4",
            !standalone && "sm:flex",
          )}
        >
          <h2 className="shrink-0 font-semibold text-sm">
            {titles[draft.mode]}
          </h2>
          <span className="min-w-0 flex-1 truncate">{saved}</span>
          {!standalone && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="作成画面を折りたたむ"
              onClick={() => setMinimized(true)}
            >
              <MinusIcon />
            </Button>
          )}
          {onPopOut && (
            <Hint label="新しいウィンドウで開く">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="新しいウィンドウで開く"
                onClick={onPopOut}
              >
                <AppWindowIcon />
              </Button>
            </Hint>
          )}
          {!standalone && (
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
          )}
          {!standalone && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="閉じる (下書きは残ります)"
              onClick={() => onOpenChange(false)}
            >
              <XIcon />
            </Button>
          )}
        </header>

        {notice && (
          <p className="shrink-0 border-b bg-muted/50 px-4 py-2 text-muted-foreground text-xs">
            {notice}
          </p>
        )}

        <Row label="差出人" htmlFor={`${id}-from`}>
          <div className="min-w-0 max-w-full">
            <Select
              items={fromChoices.map((item) => ({
                value: item.id,
                label: fromLabel(item),
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
                className="w-auto max-w-full *:data-[slot=select-value]:min-w-0"
              >
                <SelectValue>
                  {(value: string | null) => {
                    const item = fromChoices.find(
                      (choice) => choice.id === value,
                    );
                    if (!item) return null;
                    return (
                      <>
                        <AccountMark
                          accounts={accounts}
                          account={item}
                          size="sm"
                          className={fromMarkClass}
                        />
                        <span className="min-w-0 truncate">
                          {fromLabel(item)}
                        </span>
                      </>
                    );
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent
                align="start"
                className="w-auto max-w-[calc(100vw-1rem)]"
              >
                {fromChoices.map((item) => (
                  <SelectItem
                    key={item.id}
                    value={item.id}
                    disabled={!canSendFrom(item)}
                  >
                    <span className="flex items-center gap-2">
                      <AccountMark
                        accounts={accounts}
                        account={item}
                        size="sm"
                        className={fromMarkClass}
                      />
                      {fromLabel(item)}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </Row>

        {senderProblem && (
          <p
            role="alert"
            className="shrink-0 border-b bg-destructive/10 px-4 py-2 text-destructive text-xs"
          >
            {senderProblem}
          </p>
        )}

        <Row label="宛先" htmlFor={`${id}-to`}>
          <RecipientInput
            id={`${id}-to`}
            inputRef={toRef}
            value={draft.to}
            onChange={(value) =>
              changeWithSignature((current) => ({ ...current, to: value }))
            }
            exclude={chosenAddresses}
            disabled={sending}
          />
          {!showExtra && (
            <button
              type="button"
              onClick={() => setExtraShownFor(draft.idempotencyKey)}
              className="relative shrink-0 rounded-sm px-1 text-muted-foreground text-xs outline-none pointer-coarse:px-2 pointer-coarse:py-2 pointer-coarse:text-sm pointer-coarse:after:absolute pointer-coarse:after:-inset-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
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
                exclude={chosenAddresses}
                disabled={sending}
              />
            </Row>
            <Row label="Bcc" htmlFor={`${id}-bcc`}>
              <RecipientInput
                id={`${id}-bcc`}
                value={draft.bcc}
                onChange={(value) => set("bcc", value)}
                exclude={chosenAddresses}
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
            className="h-7 min-w-0 pointer-coarse:h-10 flex-1 bg-transparent font-medium text-base outline-none md:text-sm"
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

        {plain ? (
          <TextEditor
            key={`${draft.idempotencyKey}:${contentVersion}:text`}
            textRef={textRef}
            value={draft.text ?? ""}
            disabled={sending}
            onChange={(text) => set("text", text)}
            onFiles={addFiles}
            toolbar={renderToolbar}
          >
            {extras}
          </TextEditor>
        ) : (
          <Editor
            key={`${draft.idempotencyKey}:${contentVersion}`}
            editorRef={editorRef}
            initialHtml={draft.html}
            disabled={sending}
            onChange={(html) => set("html", html)}
            onFiles={addFiles}
            toolbar={renderToolbar}
          >
            {extras}
          </Editor>
        )}

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
            ここにファイルをドロップすると添付できます
          </div>
        )}
      </form>
      <AlertDialog open={confirmPlain} onOpenChange={setConfirmPlain}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>テキストのみに切り替えますか？</AlertDialogTitle>
            <AlertDialogDescription>
              太字や色、リンク、リストなどの書式は失われます。引用は行頭の「&gt;」になります。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmPlain(false);
                changeFormat("text", true);
              }}
            >
              切り替える
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/** 差出人の選択肢に出す名前。受信専用のアカウントには、そのことを添える。 */
function fromLabel(account: Account): string {
  const name = account.displayName
    ? `${account.displayName} <${account.email}>`
    : account.email;
  return canSendFrom(account) ? name : `${name} (受信専用)`;
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
