"use client";

import { BellIcon, BellOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { NotificationStatus } from "@/lib/notifications";

const descriptions: Record<NotificationStatus, string> = {
  unsupported: "このブラウザーでは、新着メールの通知を出せません。",
  off: "新着メールが届いても、通知は出しません。",
  blocked:
    "ブラウザーの設定で、このサイトの通知が拒否されています。通知を出すには、ブラウザーの設定で許可してください。",
  page: "新着メールを通知します。この画面を開いている間だけ届きます。",
  push: "新着メールを通知します。この画面を閉じていても届きます。",
};

type Props = {
  status: NotificationStatus;
  /** 切り替えている間は true。 */
  busy: boolean;
  onChange: (enabled: boolean) => void;
};

/** 新着メールの通知を、このブラウザーで有効にするかどうかを選ぶメニュー。 */
export function NotificationToggle({ status, busy, onChange }: Props) {
  const enabled = status === "page" || status === "push";
  const label = enabled ? "通知: オン" : "通知: オフ";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="icon"
            aria-label={`新着メールの通知 (${enabled ? "オン" : "オフ"})`}
            title={label}
          />
        }
      >
        {enabled ? <BellIcon /> : <BellOffIcon />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <p className="px-2 py-1.5 text-muted-foreground text-xs leading-relaxed">
          {descriptions[status]}
        </p>
        {status !== "unsupported" && status !== "blocked" && (
          <DropdownMenuItem
            closeOnClick
            disabled={busy}
            onClick={() => onChange(!enabled)}
          >
            {enabled ? <BellOffIcon /> : <BellIcon />}
            {enabled ? "通知をオフにする" : "通知をオンにする"}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
