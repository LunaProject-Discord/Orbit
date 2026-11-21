"use client";

import {
  ArchiveIcon,
  ArrowLeftIcon,
  FolderInputIcon,
  ImageOffIcon,
  MailIcon,
  MailOpenIcon,
  PaperclipIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import type { MessageActionInput } from "@/lib/actions";
import {
  ApiError,
  getMessage,
  listMailboxes,
  type Mailbox,
  type MessageDetail,
  type MessageSummary,
} from "@/lib/api";
import {
  addressFull,
  addressLabel,
  formatFullDate,
  formatSize,
} from "@/lib/format";

/**
 * 本文が外部サーバーの画像を参照しているか。
 * 「画像を表示」の案内を出すかどうかを決めるだけなので、厳密な解析はしない
 * (読み込みを実際に止めているのは iframe 側の CSP)。
 */
export function hasRemoteImages(html: string): boolean {
  return (
    /<img\b[^>]*\ssrc\s*=\s*["']?\s*(https?:)?\/\//i.test(html) ||
    /\bbackground\s*=\s*["']?\s*(https?:)?\/\//i.test(html) ||
    /url\(\s*["']?\s*(https?:)?\/\//i.test(html)
  );
}

/**
 * メール本文の HTML を iframe に入れるための文書。
 * CSP で外部への通信をすべて止め、開封を知らせる追跡画像なども読み込ませない。
 * allowRemoteImages が true のときだけ、https の画像の読み込みを許可する
 * (スクリプト、フォント、外部のスタイルシートなどは引き続き止める)。
 */
export function buildSrcDoc(html: string, allowRemoteImages = false): string {
  const imgSrc = allowRemoteImages ? "data: https:" : "data:";
  return [
    "<!doctype html><html><head>",
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${imgSrc}">`,
    // 画像を読み込むときに、このアプリの URL を相手のサーバーへ伝えない。
    '<meta name="referrer" content="no-referrer">',
    '<base target="_blank">',
    '<meta charset="utf-8">',
    "<style>html{background:#fff;color:#111}body{margin:16px;font-family:system-ui,sans-serif;font-size:14px;line-height:1.6;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>",
    "</head><body>",
    html,
    "</body></html>",
  ].join("");
}

type Props = {
  messageId: string;
  /** 値が変わると、表示を保ったまま取得し直す (同期による更新の反映)。 */
  refreshKey: number;
  /**
   * 一覧にあるこのメールの情報。既読やスターは操作した直後からここに反映されるので、
   * 表示にはこちらを優先して使う。一覧に無ければ null。
   */
  summary: MessageSummary | null;
  onAction: (messageIds: string[], input: MessageActionInput) => void;
  onBack: () => void;
  /** メールが削除されていた場合に呼ぶ。 */
  onMissing: () => void;
};

type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; message: MessageDetail };

export function MessageView({
  messageId,
  refreshKey,
  summary,
  onAction,
  onBack,
  onMissing,
}: Props) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [shownId, setShownId] = useState(messageId);
  if (shownId !== messageId) {
    // 別のメールを選んだら、前の本文を出したままにしない。
    setShownId(messageId);
    setState({ status: "loading" });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey は再取得のきっかけとして使う
  useEffect(() => {
    const controller = new AbortController();
    getMessage(messageId, controller.signal)
      .then((message) => setState({ status: "ready", message }))
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 404) {
          onMissing();
          return;
        }
        // 再取得の失敗では、表示中の本文を消さない。
        setState((current) =>
          current.status === "ready" ? current : { status: "error" },
        );
      });
    return () => controller.abort();
  }, [messageId, refreshKey, onMissing]);

  const backButton = (
    <Button
      variant="ghost"
      size="sm"
      onClick={onBack}
      className="-ml-2 self-start lg:hidden"
    >
      <ArrowLeftIcon />
      一覧に戻る
    </Button>
  );

  if (state.status === "loading") {
    return (
      <div className="flex flex-col gap-4 p-4 sm:p-6" aria-busy="true">
        {backButton}
        <output className="sr-only">メールを読み込み中</output>
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex flex-col gap-4 p-4 sm:p-6">
        {backButton}
        <p role="alert" className="text-muted-foreground text-sm">
          メールを読み込めませんでした。
        </p>
      </div>
    );
  }

  return (
    <MessageContent
      message={state.message}
      summary={summary}
      onAction={onAction}
      backButton={backButton}
    />
  );
}

/** フォルダ一覧は頻繁には変わらないので、アカウントごとに覚えておく。 */
const mailboxCache = new Map<string, Mailbox[]>();

function useMailboxes(accountId: string): Mailbox[] {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>(
    () => mailboxCache.get(accountId) ?? [],
  );
  useEffect(() => {
    const controller = new AbortController();
    setMailboxes(mailboxCache.get(accountId) ?? []);
    listMailboxes(accountId, controller.signal)
      .then((list) => {
        mailboxCache.set(accountId, list);
        setMailboxes(list);
      })
      .catch(() => {
        // 取得できなければ、移動先を選べないだけで他の操作は使える。
      });
    return () => controller.abort();
  }, [accountId]);
  return mailboxes;
}

const mailboxLabels: Partial<
  Record<NonNullable<Mailbox["specialUse"]>, string>
> = {
  inbox: "受信トレイ",
  sent: "送信済み",
  drafts: "下書き",
  trash: "ごみ箱",
  junk: "迷惑メール",
  archive: "アーカイブ",
};

/** 既読、スター、アーカイブ、削除、移動のボタン。 */
function MessageToolbar({
  message,
  summary,
  onAction,
}: {
  message: MessageDetail;
  summary: MessageSummary | null;
  onAction: Props["onAction"];
}) {
  const mailboxes = useMailboxes(message.accountId);
  const seen = summary?.seen ?? message.seen;
  const flagged = summary?.flagged ?? message.flagged;
  const currentMailboxId = summary?.mailboxId ?? null;
  const current = mailboxes.find((mailbox) => mailbox.id === currentMailboxId);
  const archive = mailboxes.find((mailbox) => mailbox.specialUse === "archive");
  const trash = mailboxes.find((mailbox) => mailbox.specialUse === "trash");
  const inTrash = current?.specialUse === "trash";
  // 移動先に選べるフォルダ。下書きなど、受信したメールを入れる場所でないものは除く。
  const destinations = mailboxes.filter(
    (mailbox) =>
      mailbox.id !== currentMailboxId &&
      mailbox.specialUse !== "drafts" &&
      mailbox.specialUse !== "sent" &&
      mailbox.specialUse !== "all" &&
      mailbox.specialUse !== "flagged",
  );
  const act = (input: MessageActionInput) => onAction([message.id], input);

  return (
    <div
      role="toolbar"
      aria-label="メールの操作"
      className="-ml-2 flex flex-wrap items-center gap-1"
    >
      <Button
        variant="ghost"
        size="sm"
        onClick={() => act({ action: "set_flags", seen: !seen })}
      >
        {seen ? <MailIcon /> : <MailOpenIcon />}
        {seen ? "未読にする" : "既読にする"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={flagged}
        onClick={() => act({ action: "set_flags", flagged: !flagged })}
      >
        <StarIcon
          className={flagged ? "fill-amber-400 text-amber-500" : undefined}
        />
        {flagged ? "スターを外す" : "スターを付ける"}
      </Button>
      {archive && archive.id !== currentMailboxId && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => act({ action: "move", mailboxId: archive.id })}
        >
          <ArchiveIcon />
          アーカイブ
        </Button>
      )}
      {(trash || inTrash) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            act(
              inTrash || !trash
                ? { action: "delete" }
                : { action: "move", mailboxId: trash.id },
            )
          }
        >
          <Trash2Icon />
          {inTrash ? "完全に削除" : "削除"}
        </Button>
      )}
      {destinations.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>
            <FolderInputIcon />
            移動
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {destinations.map((mailbox) => (
              <DropdownMenuItem
                key={mailbox.id}
                onClick={() => act({ action: "move", mailboxId: mailbox.id })}
              >
                <span className="truncate">
                  {(mailbox.specialUse && mailboxLabels[mailbox.specialUse]) ||
                    mailbox.name}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function MessageContent({
  message,
  summary,
  onAction,
  backButton,
}: {
  message: MessageDetail;
  summary: MessageSummary | null;
  onAction: Props["onAction"];
  backButton: React.ReactNode;
}) {
  /** 外部の画像を表示すると決めたメールの ID。別のメールを開くと元 (非表示) に戻る。 */
  const [imagesShownFor, setImagesShownFor] = useState<string | null>(null);
  const showImages = imagesShownFor === message.id;
  const srcDoc = useMemo(
    () => (message.bodyHtml ? buildSrcDoc(message.bodyHtml, showImages) : null),
    [message.bodyHtml, showImages],
  );
  const imagesBlocked =
    !showImages &&
    message.bodyHtml !== null &&
    hasRemoteImages(message.bodyHtml);
  const files = message.attachments.filter((file) => !file.inline);

  return (
    <article className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-col gap-3 border-b p-4 sm:p-6">
        {backButton}
        <MessageToolbar
          message={message}
          summary={summary}
          onAction={onAction}
        />
        <h2 className="font-semibold text-xl leading-snug">
          {message.subject || "(件名なし)"}
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">差出人</dt>
          <dd className="min-w-0 break-words">
            {message.from.length > 0
              ? message.from.map(addressFull).join(", ")
              : addressLabel(undefined)}
          </dd>
          {message.to.length > 0 && (
            <>
              <dt className="text-muted-foreground">宛先</dt>
              <dd className="min-w-0 break-words">
                {message.to.map(addressFull).join(", ")}
              </dd>
            </>
          )}
          {message.cc.length > 0 && (
            <>
              <dt className="text-muted-foreground">Cc</dt>
              <dd className="min-w-0 break-words">
                {message.cc.map(addressFull).join(", ")}
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">日時</dt>
          <dd>
            <time dateTime={message.receivedAt}>
              {formatFullDate(message.receivedAt)}
            </time>
          </dd>
        </dl>
        {files.length > 0 && (
          <ul aria-label="添付ファイル" className="flex flex-wrap gap-2">
            {files.map((file) => (
              <li key={file.id}>
                <Badge variant="outline" className="h-auto max-w-full py-1">
                  <PaperclipIcon aria-hidden="true" />
                  <span className="truncate">
                    {file.filename || "(名前なし)"}
                  </span>
                  <span className="text-muted-foreground">
                    {formatSize(file.size)}
                  </span>
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </header>

      {message.bodyFetchedAt === null ? (
        <output className="block p-4 text-muted-foreground text-sm sm:p-6">
          本文を取得中です。取得が終わると自動で表示されます。
        </output>
      ) : srcDoc ? (
        <>
          {imagesBlocked && (
            <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b bg-muted/50 px-4 py-2 sm:px-6">
              <ImageOffIcon
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="min-w-0 flex-1 text-muted-foreground text-sm">
                外部の画像は表示していません。表示すると、開封したことが差出人に伝わる場合があります。
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setImagesShownFor(message.id)}
              >
                このメールの画像を表示
              </Button>
            </div>
          )}
          {/* スクリプトの実行もこのアプリのデータへのアクセスも禁止する。
              許可するのは、本文内のリンクを新しいタブで開くことだけ。 */}
          <iframe
            title="メール本文"
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            srcDoc={srcDoc}
            referrerPolicy="no-referrer"
            className="min-h-[60vh] w-full flex-1 border-0 bg-white"
          />
        </>
      ) : message.bodyText ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {message.bodyText}
          </p>
        </div>
      ) : (
        <p className="p-4 text-muted-foreground text-sm sm:p-6">
          本文はありません。
        </p>
      )}
    </article>
  );
}
