"use client";

import {
  DownloadIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  ImageIcon,
  Loader2Icon,
  MailIcon,
  PaperclipIcon,
  PresentationIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError, type Attachment } from "@/lib/api";
import {
  type AttachmentKind,
  attachmentErrorMessage,
  attachmentKind,
  type Preview,
  previewOf,
} from "@/lib/attachments";
import { formatSize } from "@/lib/format";
import { fetchAttachment } from "@/lib/offline";
import { cn } from "@/lib/utils";

const KIND_STYLE: Record<AttachmentKind, { icon: ReactNode; tone: string }> = {
  image: { icon: <ImageIcon />, tone: "bg-sky-500/10 text-sky-600" },
  pdf: { icon: <FileTextIcon />, tone: "bg-red-500/10 text-red-600" },
  sheet: {
    icon: <FileSpreadsheetIcon />,
    tone: "bg-emerald-500/10 text-emerald-600",
  },
  document: { icon: <FileTextIcon />, tone: "bg-blue-500/10 text-blue-600" },
  slides: {
    icon: <PresentationIcon />,
    tone: "bg-orange-500/10 text-orange-600",
  },
  archive: {
    icon: <FileArchiveIcon />,
    tone: "bg-amber-500/10 text-amber-600",
  },
  audio: { icon: <FileAudioIcon />, tone: "bg-violet-500/10 text-violet-600" },
  video: { icon: <FileVideoIcon />, tone: "bg-violet-500/10 text-violet-600" },
  text: { icon: <FileTextIcon />, tone: "bg-muted text-muted-foreground" },
  mail: { icon: <MailIcon />, tone: "bg-muted text-muted-foreground" },
  file: { icon: <FileIcon />, tone: "bg-muted text-muted-foreground" },
};

const nameOf = (file: Attachment) => file.filename || "(名前なし)";

/**
 * ファイルとして保存する。中身は差出人が自由に決められるので、種類は付けずに渡し、
 * ブラウザーがこのアプリのページとして開くことのないようにする。
 */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(
    new Blob([blob], { type: "application/octet-stream" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // 保存が始まる前に消さないよう、少し待ってから解放する。
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

type Opened = {
  file: Attachment;
  preview: Preview;
  /** 取得できたら入る。text は文字、それ以外は blob の URL。 */
  content: { url: string } | { text: string } | null;
};

type Props = {
  messageId: string;
  /** 本文の下に並べる添付ファイル (本文に埋め込んだ画像は含めない)。 */
  files: Attachment[];
  /** 会話の中の 1 通として表示する (スクロールは会話全体で行う)。 */
  inThread?: boolean;
};

/** 本文の下に並べる添付ファイルのカード。押すとプレビュー (できなければ保存) する。 */
export function MessageAttachments({
  messageId,
  files,
  inThread = false,
}: Props) {
  /** 取得中の添付ファイルの ID。 */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  /** 取得済みの実体。同じファイルをもう一度開いたときに取得し直さない。 */
  const cache = useRef(new Map<string, Blob>());
  const abort = useRef(new AbortController());
  const openedUrl =
    opened?.content && "url" in opened.content ? opened.content.url : null;

  // 別のメールに切り替えたら、取得を止めて、覚えていた実体も手放す。
  // biome-ignore lint/correctness/useExhaustiveDependencies: messageId は切り替わりのきっかけとして使う
  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    const blobs = cache.current;
    return () => {
      controller.abort();
      blobs.clear();
      setBusy(new Set());
      setError(null);
      setOpened(null);
    };
  }, [messageId]);

  useEffect(() => {
    if (!openedUrl) return;
    return () => URL.revokeObjectURL(openedUrl);
  }, [openedUrl]);

  /** 実体を取得する。失敗したら説明を出して null を返す。 */
  async function load(file: Attachment): Promise<Blob | null> {
    const cached = cache.current.get(file.id);
    if (cached) return cached;
    const { signal } = abort.current;
    setError(null);
    setBusy((current) => new Set(current).add(file.id));
    try {
      const blob = await fetchAttachment(messageId, file.id, signal);
      cache.current.set(file.id, blob);
      return blob;
    } catch (cause) {
      if (!signal.aborted) {
        setError(
          `「${nameOf(file)}」: ${attachmentErrorMessage(
            cause instanceof ApiError ? cause.code : null,
          )}`,
        );
      }
      return null;
    } finally {
      if (!signal.aborted) {
        setBusy((current) => {
          const next = new Set(current);
          next.delete(file.id);
          return next;
        });
      }
    }
  }

  async function save(file: Attachment) {
    const blob = await load(file);
    if (blob) saveBlob(blob, file.filename || "attachment");
  }

  async function saveAll() {
    for (const file of files) await save(file);
  }

  async function open(file: Attachment) {
    const preview = previewOf(file);
    if (!preview) {
      await save(file);
      return;
    }
    setOpened({ file, preview, content: null });
    const blob = await load(file);
    const content: Opened["content"] = !blob
      ? null
      : preview.kind === "text"
        ? { text: await blob.text() }
        : {
            url: URL.createObjectURL(
              new Blob([blob], {
                type: preview.kind === "pdf" ? "application/pdf" : preview.type,
              }),
            ),
          };
    setOpened((current) => {
      // 取得している間に閉じられたか、別のファイルを開いていたら捨てる。
      if (current?.file.id !== file.id || !content) {
        if (content && "url" in content) URL.revokeObjectURL(content.url);
        return current?.file.id === file.id ? null : current;
      }
      return { ...current, content };
    });
  }

  if (files.length === 0) return null;
  const total = files.reduce((sum, file) => sum + file.size, 0);

  return (
    <section
      aria-label="添付ファイル"
      className={cn(
        "flex shrink-0 flex-col gap-2 sm:px-6",
        inThread
          ? "px-4 pb-4"
          : // 本文と一緒には流さず、メール表示の下端に留める。
            "sticky bottom-0 max-h-[40%] overflow-y-auto border-t bg-background p-4",
      )}
    >
      <div className="flex min-h-6 items-center gap-2 text-muted-foreground text-xs">
        <PaperclipIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span>
          添付ファイル {files.length} 件 ({formatSize(total)})
        </span>
        {files.length > 1 && (
          <Button
            variant="ghost"
            size="xs"
            disabled={busy.size > 0}
            onClick={() => void saveAll()}
          >
            すべて保存
          </Button>
        )}
      </div>
      <ul className="flex flex-wrap gap-2">
        {files.map((file) => {
          const style = KIND_STYLE[attachmentKind(file)];
          const previewable = previewOf(file) !== null;
          const loading = busy.has(file.id);
          return (
            <li
              key={file.id}
              className="relative flex w-full items-center gap-3 rounded-lg border p-2.5 transition-colors focus-within:bg-muted/50 hover:bg-muted/50 sm:w-64"
            >
              <span
                className={cn(
                  "flex size-10 shrink-0 items-center justify-center rounded-md [&_svg]:size-5",
                  style.tone,
                )}
                aria-hidden="true"
              >
                {style.icon}
              </span>
              <span className="min-w-0 flex-1">
                {/* カード全体を押せるように、ボタンの当たり判定をカードいっぱいに広げる。 */}
                <Hint label={nameOf(file)} whenClipped>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => void open(file)}
                    className="block w-full truncate text-left font-medium text-sm outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring"
                  >
                    {nameOf(file)}
                    <span className="sr-only">
                      {previewable ? " をプレビュー" : " を保存"}
                    </span>
                  </button>
                </Hint>
                <span className="block text-muted-foreground text-xs">
                  {formatSize(file.size)}
                  {previewable && " · プレビュー可"}
                </span>
              </span>
              <Hint label="保存">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${nameOf(file)} を保存`}
                  // プレビューできないファイルはカード自体が保存のボタンなので、重複させない。
                  aria-hidden={previewable ? undefined : true}
                  tabIndex={previewable ? undefined : -1}
                  disabled={loading}
                  onClick={() => void save(file)}
                  className="relative"
                >
                  {loading ? (
                    <Loader2Icon className="animate-spin" />
                  ) : (
                    <DownloadIcon />
                  )}
                </Button>
              </Hint>
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}

      <Dialog
        open={opened !== null}
        onOpenChange={(open) => {
          if (!open) setOpened(null);
        }}
      >
        {opened && (
          <DialogContent className="flex h-[min(90dvh,56rem)] w-[min(96vw,72rem)] max-w-none flex-col gap-3 sm:max-w-none">
            <DialogHeader className="pr-10">
              <DialogTitle className="truncate leading-normal">
                {nameOf(opened.file)}
              </DialogTitle>
              <DialogDescription className="flex items-center gap-2">
                {formatSize(opened.file.size)}
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => void save(opened.file)}
                >
                  <DownloadIcon />
                  保存
                </Button>
              </DialogDescription>
            </DialogHeader>
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-md border bg-muted/30">
              {!opened.content ? (
                <output className="flex items-center gap-2 text-muted-foreground text-sm">
                  <Loader2Icon
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                  取得中です
                </output>
              ) : "text" in opened.content ? (
                <pre className="size-full overflow-auto whitespace-pre-wrap break-words p-4 text-sm">
                  {opened.content.text}
                </pre>
              ) : opened.preview.kind === "pdf" ? (
                <iframe
                  title={nameOf(opened.file)}
                  src={opened.content.url}
                  className="size-full border-0 bg-white"
                />
              ) : (
                // biome-ignore lint/performance/noImgElement: 取得済みの blob を表示するだけなので、画像の最適化は要らない
                <img
                  src={opened.content.url}
                  alt={nameOf(opened.file)}
                  className="max-h-full max-w-full object-contain"
                />
              )}
            </div>
          </DialogContent>
        )}
      </Dialog>
    </section>
  );
}
