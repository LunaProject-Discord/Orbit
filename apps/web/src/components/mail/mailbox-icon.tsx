import { cn } from "cn";
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
import { UnifiedMark } from "@/components/mail/unified-mark";
import { ACCOUNT_TEXT_CLASS, accountColorStyle } from "@/lib/account-colors";
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

/**
 * フォルダのアイコン。受信トレイなどの役割があればそのアイコン、無ければフォルダ。
 * アプリ内でアイコンや色を付けていれば (icon / color)、そちらを出す。
 */
export function MailboxIcon({
  specialUse,
  icon = null,
  color = null,
  className,
}: {
  specialUse: Mailbox["specialUse"];
  icon?: string | null;
  color?: string | null;
  className?: string;
}) {
  const Icon = (specialUse && icons[specialUse]) || FolderIcon;
  if (icon) {
    return (
      <UnifiedMark
        folder={{ icon, color }}
        className={className}
        fallback={Icon}
      />
    );
  }
  if (color) {
    return (
      <span
        aria-hidden="true"
        style={accountColorStyle(color)}
        className={cn("flex size-4 shrink-0", ACCOUNT_TEXT_CLASS, className)}
      >
        <Icon className="size-4 text-inherit!" />
      </span>
    );
  }
  return <Icon className={className} />;
}

/** フォルダ 1 件のアイコン (アプリ内で付けたアイコンと色を含む)。 */
export function MailboxMark({
  mailbox,
  className,
}: {
  mailbox: Pick<Mailbox, "specialUse" | "icon" | "color"> | null | undefined;
  className?: string;
}) {
  return (
    <MailboxIcon
      specialUse={mailbox?.specialUse ?? null}
      icon={mailbox?.icon}
      color={mailbox?.color}
      className={className}
    />
  );
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
        <MailboxMark mailbox={entry.mailbox} />
      </span>
      <span className="truncate">{mailboxLabel(entry.mailbox)}</span>
    </>
  );
}
