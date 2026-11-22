"use client";

import { cn } from "cn";
import { CopyIcon, MinusIcon, SquareIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { OrbitMark } from "@/components/brand/orbit-logo";
import {
  type DesktopPlatform,
  desktopPlatform,
  desktopWindow,
  isDesktopApp,
} from "@/lib/desktop/app";

function WindowButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      // キーボードの移動先には入れない (OS のウィンドウ枠のボタンと同じ扱い)。
      tabIndex={-1}
      onClick={onClick}
      className={cn(
        "flex h-full w-11 items-center justify-center outline-none transition-colors",
        danger
          ? "hover:bg-[#e81123] hover:text-white"
          : "hover:bg-sidebar-accent",
      )}
    >
      {children}
    </button>
  );
}

/**
 * デスクトップ版のウィンドウ枠 (タイトルバー)。ブラウザーでは何も出さない。
 * Windows / Linux は OS の枠を外しているので、最小化・最大化・閉じるボタンもここに置く。
 * macOS は OS の信号機ボタンが左上に重なるので、その分を空けて名前だけを出す。
 * 高さは globals.css の --titlebar-height。
 */
export function DesktopTitleBar() {
  const [platform, setPlatform] = useState<DesktopPlatform | null>(null);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isDesktopApp()) return;
    setPlatform(desktopPlatform());
    const update = () => void desktopWindow.isMaximized().then(setMaximized);
    update();
    return desktopWindow.onResized(update);
  }, []);

  if (!platform) return null;
  const mac = platform === "macos";

  return (
    <div
      data-tauri-drag-region
      className={cn(
        "fixed inset-x-0 top-0 z-[60] flex h-(--titlebar-height) select-none items-center border-b bg-sidebar text-sidebar-foreground",
        mac && "justify-center",
      )}
    >
      <OrbitMark className="pointer-events-none mr-2 ml-3 size-4" />
      <span className="pointer-events-none text-xs">Orbit Mail</span>
      {!mac && (
        <>
          <span data-tauri-drag-region className="h-full flex-1" />
          <WindowButton label="最小化" onClick={desktopWindow.minimize}>
            <MinusIcon className="size-3.5" />
          </WindowButton>
          <WindowButton
            label={maximized ? "元に戻す" : "最大化"}
            onClick={desktopWindow.toggleMaximize}
          >
            {maximized ? (
              <CopyIcon className="size-3 -scale-x-100" />
            ) : (
              <SquareIcon className="size-3" />
            )}
          </WindowButton>
          <WindowButton label="閉じる" onClick={desktopWindow.close} danger>
            <XIcon className="size-3.5" />
          </WindowButton>
        </>
      )}
    </div>
  );
}
