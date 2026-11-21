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
      <span
        className="shrink-0"
        style={{ width: `${entry.depth * 0.75}rem` }}
        aria-hidden="true"
      />
      <MailboxIcon specialUse={entry.mailbox.specialUse} />
      <span className="truncate">{mailboxLabel(entry.mailbox)}</span>
    </>
  );
}
