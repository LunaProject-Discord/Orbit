"use client";

import { type ReactElement, useRef, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** 自身か、中の省略表示 (truncate) の要素が、幅に収まらず切れているか。 */
function isClipped(element: Element): boolean {
  return [element, ...element.querySelectorAll(".truncate")].some(
    (target) => target.scrollWidth > target.clientWidth,
  );
}

/**
 * カーソルを合わせたとき (キーボードではフォーカスしたとき) に出す説明。
 * ブラウザーの title 属性の代わりに使う。label が無ければ何も付けない。
 */
export function Hint({
  label,
  shortcut,
  side,
  whenClipped = false,
  children,
}: {
  label: string | null | undefined;
  /** 説明に添えるショートカットキー。 */
  shortcut?: string;
  side?: "top" | "bottom" | "left" | "right";
  /** 文字が幅に収まらず切れているときだけ出す (長い名前の全体を見せる用途)。 */
  whenClipped?: boolean;
  /** 説明を付ける要素。 */
  children: ReactElement;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!label) return children;
  return (
    <Tooltip
      open={open}
      onOpenChange={(next) =>
        setOpen(
          next &&
            (!whenClipped ||
              (trigger.current !== null && isClipped(trigger.current))),
        )
      }
    >
      <TooltipTrigger ref={trigger} render={children} />
      <TooltipContent side={side} className="break-all">
        {label}
        {shortcut && (
          <kbd className="shrink-0 font-sans text-background/70">
            {shortcut}
          </kbd>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
