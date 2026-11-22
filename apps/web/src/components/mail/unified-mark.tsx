import { cn } from "cn";
import {
  FilePenLineIcon,
  InboxIcon,
  LayersIcon,
  SendIcon,
  StarIcon,
} from "lucide-react";
import { ACCOUNT_TEXT_CLASS, accountColorStyle } from "@/lib/account-colors";
import type { BuiltinStyle, UnifiedFolder } from "@/lib/api";
import { EMOJI_FONT_FAMILY, isEmojiIcon } from "@/lib/emoji/emoji";
import { LucideSvg, useIconNode } from "@/lib/lucide/icons";
import type { BuiltinView } from "@/lib/unified";

/** サイドバー上部に初めからある項目のアイコン。 */
export const BUILTIN_ICONS: Record<
  BuiltinView,
  React.ComponentType<{ className?: string }>
> = {
  inbox: InboxIcon,
  starred: StarIcon,
  drafts: FilePenLineIcon,
  outgoing: SendIcon,
};

/**
 * 初めからある項目のアイコン。アイコンを選んでいればそれを、選んでいなければ
 * 初期のアイコンを、選んだ色 (無ければ周りの文字色) で出す。
 */
export function BuiltinMark({
  view,
  style,
  className,
}: {
  view: BuiltinView;
  style: Pick<BuiltinStyle, "icon" | "color">;
  className?: string;
}) {
  const Icon = BUILTIN_ICONS[view];
  if (style.icon !== null) {
    return <UnifiedMark folder={style} className={className} fallback={Icon} />;
  }
  return (
    <span
      aria-hidden="true"
      style={style.color ? accountColorStyle(style.color) : undefined}
      className={cn(
        "flex size-4 shrink-0",
        style.color && ACCOUNT_TEXT_CLASS,
        className,
      )}
    >
      <Icon className="size-4 text-inherit!" />
    </span>
  );
}

/**
 * 統合フォルダのアイコン。選んだアイコンか絵文字を、選んだ色で出す
 * (色を選んでいなければ周りの文字色、アイコンを選んでいなければ重なりのアイコン)。
 */
export function UnifiedMark({
  folder,
  className,
  fallback: Fallback = LayersIcon,
}: {
  folder: Pick<UnifiedFolder, "icon" | "color">;
  className?: string;
  /** アイコンを選んでいない (または無くなった名前の) ときに出すアイコン。 */
  fallback?: React.ComponentType<{ className?: string }>;
}) {
  const emoji =
    folder.icon !== null && isEmojiIcon(folder.icon) ? folder.icon : null;
  const node = useIconNode(emoji ? null : folder.icon);
  const style = folder.color ? accountColorStyle(folder.color) : undefined;
  const tone = folder.color ? ACCOUNT_TEXT_CLASS : undefined;
  if (emoji) {
    return (
      <span
        aria-hidden="true"
        style={{ fontFamily: EMOJI_FONT_FAMILY }}
        className={cn(
          "flex size-4 shrink-0 items-center justify-center text-sm leading-none",
          className,
        )}
      >
        {emoji}
      </span>
    );
  }
  // 選んだアイコンの図形を読み込んでいる間 (undefined) は、同じ大きさの空きを出しておく。
  if (node === undefined) {
    return (
      <span aria-hidden="true" className={cn("size-4 shrink-0", className)} />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={style}
      className={cn("flex size-4 shrink-0", tone, className)}
    >
      {node ? (
        <LucideSvg node={node} className="size-4 text-inherit!" />
      ) : (
        <Fallback className="size-4 text-inherit!" />
      )}
    </span>
  );
}
