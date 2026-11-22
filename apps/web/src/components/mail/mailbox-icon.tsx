import {
  ArchiveIcon,
  FilePenLineIcon,
  FolderIcon,
  InboxIcon,
  MailsIcon,
  OctagonAlertIcon,
  SendIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";
import type { Mailbox } from "@/lib/api";
import { type MailboxEntry, mailboxLabel } from "@/lib/mailboxes";

const icons: Record<
  NonNullable<Mailbox["specialUse"]>,
  React.ComponentType<{ className?: string }>
> = {
  inbox: InboxIcon,
  flagged: StarIcon,
  drafts: FilePenLineIcon,
  sent: SendIcon,
  archive: ArchiveIcon,
  all: MailsIcon,
  junk: OctagonAlertIcon,
  trash: Trash2Icon,
};

/** フォルダのアイコン。受信トレイなどの役割があればそのアイコン、無ければフォルダ。 */
export function MailboxIcon({
  specialUse,
  className,
}: {
  specialUse: Mailbox["specialUse"];
  className?: string;
}) {
  const Icon = (specialUse && icons[specialUse]) || FolderIcon;
  return <Icon className={className} />;
}

/**
 * 移動先のメニューの 1 行。サイドバーと同じアイコンを付け、
 * サブフォルダは階層の分だけ字下げする。
 */
export function MoveTarget({ entry }: { entry: MailboxEntry }) {
  return (
    <>
      {/* 字下げは余白で付ける。空の要素を並べると、項目の間隔の分だけアイコンがずれる。 */}
      <span
        className="flex shrink-0"
        style={{ paddingLeft: `${entry.depth * 0.75}rem` }}
      >
        <MailboxIcon specialUse={entry.mailbox.specialUse} />
      </span>
      <span className="truncate">{mailboxLabel(entry.mailbox)}</span>
    </>
  );
}
