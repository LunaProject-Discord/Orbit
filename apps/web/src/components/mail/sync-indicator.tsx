import { cn } from "cn";
import {
  CheckCheckIcon,
  CircleAlertIcon,
  RefreshCwIcon,
  WifiOffIcon,
} from "lucide-react";
import type { SyncStatus } from "@/lib/sync-status";

/** 同期の状況 (同期済み、同期中、オフラインなど) を、印と短い文言で出す。 */
export function SyncIndicator({
  status,
  short = false,
  className,
}: {
  status: SyncStatus;
  /** 狭い場所用に、短い文言だけを出す。 */
  short?: boolean;
  className?: string;
}) {
  const Icon =
    status.tone === "ok"
      ? CheckCheckIcon
      : status.tone === "busy"
        ? RefreshCwIcon
        : status.tone === "offline"
          ? WifiOffIcon
          : CircleAlertIcon;
  return (
    <output
      // 状況が変わったときだけ、読み上げで知らせる。
      aria-live="polite"
      title={short ? status.label : undefined}
      className={cn(
        "flex min-w-0 items-center gap-2 text-muted-foreground text-xs",
        short && "gap-1",
        className,
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0",
          status.tone === "ok" && "text-emerald-600 dark:text-emerald-500",
          status.tone === "error" && "text-destructive",
        )}
      />
      <span className="truncate">{short ? status.short : status.label}</span>
    </output>
  );
}
