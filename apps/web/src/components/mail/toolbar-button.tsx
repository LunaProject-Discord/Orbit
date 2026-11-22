"use client";

import type { ComponentProps, ReactElement } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** ボタンにカーソルを合わせたときに出す説明。操作の名前と、あればショートカットキー。 */
export function ToolbarTooltip({
  label,
  shortcut,
  children,
}: {
  label: string;
  shortcut?: string;
  /** 説明を付けるボタン。 */
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>
        {label}
        {shortcut && (
          <kbd className="font-sans text-background/70">{shortcut}</kbd>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * ツールバーに並べる、アイコンだけのボタン。名前は読み上げ用に付け、
 * カーソルを合わせたとき (キーボードではフォーカスしたとき) に説明として出す。
 */
export function ToolbarButton({
  label,
  shortcut,
  children,
  ...props
}: {
  label: string;
  shortcut?: string;
} & Omit<ComponentProps<typeof Button>, "aria-label" | "title">) {
  return (
    <ToolbarTooltip label={label} shortcut={shortcut}>
      <Button variant="ghost" size="icon-sm" aria-label={label} {...props}>
        {children}
      </Button>
    </ToolbarTooltip>
  );
}

/** ツールバーのボタンのまとまりを分ける縦線。 */
export function ToolbarSeparator({ className }: { className?: string }) {
  return (
    <span
      className={`mx-1 h-5 w-px shrink-0 bg-border ${className ?? ""}`}
      aria-hidden="true"
    />
  );
}
