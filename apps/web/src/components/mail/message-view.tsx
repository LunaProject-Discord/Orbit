"use client";

import { ArrowLeftIcon, PaperclipIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, getMessage, type MessageDetail } from "@/lib/api";
import {
  addressFull,
  addressLabel,
  formatFullDate,
  formatSize,
} from "@/lib/format";

/**
 * メール本文の HTML を iframe に入れるための文書。
 * CSP で外部への通信をすべて止め、開封を知らせる追跡画像なども読み込ませない。
 */
function buildSrcDoc(html: string): string {
  return [
    "<!doctype html><html><head>",
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\">",
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

  return <MessageContent message={state.message} backButton={backButton} />;
}

function MessageContent({
  message,
  backButton,
}: {
  message: MessageDetail;
  backButton: React.ReactNode;
}) {
  const srcDoc = useMemo(
    () => (message.bodyHtml ? buildSrcDoc(message.bodyHtml) : null),
    [message.bodyHtml],
  );
  const files = message.attachments.filter((file) => !file.inline);

  return (
    <article className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-col gap-3 border-b p-4 sm:p-6">
        {backButton}
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
        // スクリプトの実行もこのアプリのデータへのアクセスも禁止する。
        // 許可するのは、本文内のリンクを新しいタブで開くことだけ。
        <iframe
          title="メール本文"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          srcDoc={srcDoc}
          referrerPolicy="no-referrer"
          className="min-h-[60vh] w-full flex-1 border-0 bg-white"
        />
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
