"use client";

import { CheckCheckIcon, RefreshCwIcon, WifiOffIcon } from "lucide-react";
import { useOnline, useQueuedSends } from "@/lib/offline";
import { syncStatusLabel } from "@/lib/offline/status";

/** サーバーと同期できているか、オフラインで何を預かっているかを 1 行で示す。 */
export function SyncStatus({ pendingActions }: { pendingActions: number }) {
  const online = useOnline();
  // サーバーに断られたメールは自動では送らないので、数えない。
  const queuedSends = useQueuedSends().filter(
    (item) => item.error === null,
  ).length;
  const label = syncStatusLabel({ online, queuedSends, pendingActions });
  const busy = online && (queuedSends > 0 || pendingActions > 0);
  return (
    <output className="flex shrink-0 items-center gap-2 border-t px-3 py-2 text-muted-foreground text-xs">
      {!online ? (
        <WifiOffIcon className="size-3.5 shrink-0" aria-hidden="true" />
      ) : busy ? (
        <RefreshCwIcon className="size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <CheckCheckIcon
          className="size-3.5 shrink-0 text-emerald-600"
          aria-hidden="true"
        />
      )}
      <span className="min-w-0 truncate">{label}</span>
    </output>
  );
}
