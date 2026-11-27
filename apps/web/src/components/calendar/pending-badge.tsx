"use client";

import { cn } from "cn";
import { CircleAlertIcon, CloudUploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PendingState } from "@/lib/calendar/conflict-labels";

/**
 * 予定の詳細に出す「未送信」の印。送信できなかった操作は、理由と
 * 「確認する」(反映されなかった変更の一覧を開く) を添える。
 * やり直す・破棄のボタンは一覧の側にだけ置く (同じ操作を 2 か所に出さない)。
 */
export function PendingBadge({
  state,
  offline,
  onShowDetails,
  className,
}: {
  state: PendingState | null;
  /** オフライン中なら「接続すると送ります」と添える。 */
  offline: boolean;
  onShowDetails?: (() => void) | null;
  className?: string;
}) {
  if (!state) return null;
  const failed = state.tone === "error";
  const note = failed
    ? state.detail
    : state.tone === "blocked"
      ? state.detail
      : offline
        ? "接続すると送信します"
        : "送信しています";
  return (
    <output
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-xs",
        failed
          ? "bg-destructive/10 text-destructive dark:bg-destructive/20"
          : "bg-muted text-muted-foreground",
        className,
      )}
    >
      {failed ? (
        <CircleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
      ) : (
        <CloudUploadIcon aria-hidden="true" className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{state.label}</span>
        {note && <span className="opacity-80"> · {note}</span>}
      </span>
      {failed && onShowDetails && (
        <Button
          variant="ghost"
          size="xs"
          className="-my-1 -mr-1.5 shrink-0 text-destructive hover:text-destructive"
          onClick={onShowDetails}
        >
          確認する
        </Button>
      )}
    </output>
  );
}
