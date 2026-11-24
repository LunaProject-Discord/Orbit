"use client";

import { cn } from "cn";
import { CopyIcon, MenuIcon, MinusIcon, SquareIcon, XIcon } from "lucide-react";
import { type MouseEvent, type ReactNode, useEffect, useState } from "react";
import { OrbitMark } from "@/components/brand/orbit-logo";
import { Hint } from "@/components/hint";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  type DesktopPlatform,
  desktopPlatform,
  desktopWindow,
  isDesktopApp,
  showSystemMenu,
} from "@/lib/desktop/app";
import { useTitleBarMenu } from "@/lib/desktop/title-bar-menu";

/**
 * Windows のキャプションボタンの字形 (Segoe Fluent Icons / Segoe MDL2 Assets)。
 * OS の枠のボタンと同じ絵にするため、OS に入っているアイコンのフォントで描く。
 * Windows 11 は Segoe Fluent Icons、Windows 10 は Segoe MDL2 Assets が入っている (どちらも同じ字の位置)。
 */
const CAPTION_GLYPHS = {
  minimize: "",
  maximize: "",
  restore: "",
  close: "",
} as const;

type Caption = keyof typeof CAPTION_GLYPHS;

/** Linux には OS 共通のアイコンのフォントが無いので、アプリのアイコンで描く。 */
function CaptionIcon({ kind }: { kind: Caption }) {
  switch (kind) {
    case "minimize":
      return <MinusIcon className="size-3.5" />;
    case "maximize":
      return <SquareIcon className="size-3" />;
    case "restore":
      return <CopyIcon className="size-3 -scale-x-100" />;
    case "close":
      return <XIcon className="size-3.5" />;
  }
}

function CaptionButton({
  kind,
  label,
  onClick,
  platform,
}: {
  kind: Caption;
  label: string;
  onClick: () => void;
  platform: DesktopPlatform;
}) {
  const windows = platform === "windows";
  return (
    <button
      type="button"
      aria-label={label}
      // OS の枠のボタンと同じく、OS の説明 (ツールチップ) を出す。
      title={label}
      // キーボードの移動先には入れない (OS のウィンドウ枠のボタンと同じ扱い)。
      tabIndex={-1}
      onClick={onClick}
      className={cn(
        "flex h-full items-center justify-center outline-none transition-colors duration-100",
        windows ? "w-[46px]" : "w-11",
        kind === "close"
          ? // Windows 11 の閉じるボタンの色。
            "hover:bg-[#c42b1c] hover:text-white active:bg-[#c42b1c]/90 active:text-white/80"
          : windows
            ? // Windows 11 の SubtleFillColorSecondary / Tertiary。
              "hover:bg-black/[0.0373] active:bg-black/[0.0241] dark:active:bg-white/[0.0419] dark:hover:bg-white/[0.0605]"
            : "hover:bg-sidebar-accent",
      )}
    >
      {windows ? (
        <span
          aria-hidden
          className="text-[10px] leading-none"
          style={{ fontFamily: '"Segoe Fluent Icons", "Segoe MDL2 Assets"' }}
        >
          {CAPTION_GLYPHS[kind]}
        </span>
      ) : (
        <CaptionIcon kind={kind} />
      )}
    </button>
  );
}

/** Linux の右クリックで出す、システムメニューの代わり (OS のメニューを呼び出す手段が無いため)。 */
function LinuxSystemMenu({
  maximized,
  children,
}: {
  maximized: boolean;
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      {children}
      <ContextMenuContent
        className="min-w-48"
        // タイトルバー (z-[60]) より手前に出す。
        positionerClassName="z-[70]"
      >
        <ContextMenuItem
          disabled={!maximized}
          onClick={desktopWindow.toggleMaximize}
        >
          元のサイズに戻す
        </ContextMenuItem>
        <ContextMenuItem onClick={desktopWindow.minimize}>
          最小化
        </ContextMenuItem>
        <ContextMenuItem
          disabled={maximized}
          onClick={desktopWindow.toggleMaximize}
        >
          最大化
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={desktopWindow.close}>閉じる</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * デスクトップ版のウィンドウ枠 (タイトルバー)。ブラウザーでは何も出さない。
 * 左から、ハンバーガーメニュー (サイドバーの開閉)、アプリのアイコン、アプリ名、
 * Windows / Linux は右端に最小化・最大化・閉じるボタン (OS の枠を外しているため)。
 * macOS は OS の信号機ボタンが左上に重なるので、その分を空けてからハンバーガーメニューを置き、名前は中央に出す。
 * 右クリックでは、OS のシステムメニュー (元のサイズに戻す・移動・最小化・最大化・閉じる) を出す。
 * 高さは globals.css の --titlebar-height。
 */
export function DesktopTitleBar() {
  const [platform, setPlatform] = useState<DesktopPlatform | null>(null);
  const [maximized, setMaximized] = useState(false);
  /** ウィンドウが前面にあるか。後ろにあるときは、OS の枠と同じく文字とアイコンを薄くする。 */
  const [active, setActive] = useState(true);
  const menu = useTitleBarMenu();

  useEffect(() => {
    if (!isDesktopApp()) return;
    setPlatform(desktopPlatform());
    const update = () => void desktopWindow.isMaximized().then(setMaximized);
    update();
    const removeResized = desktopWindow.onResized(update);
    const onFocus = () => setActive(true);
    const onBlur = () => setActive(false);
    setActive(document.hasFocus());
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      removeResized();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  if (!platform) return null;
  const mac = platform === "macos";

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    // 右クリックの標準のメニュー (と、アプリの文字のメニュー) の代わりに、OS のメニューを出す。
    event.preventDefault();
    showSystemMenu();
  };

  const hamburger = menu && (
    <Hint label={menu.label} shortcut={menu.shortcut}>
      <button
        type="button"
        aria-label={menu.label}
        aria-expanded={menu.expanded}
        aria-controls="mail-sidebar"
        onClick={menu.onClick}
        className={cn(
          // 幅は折りたたんだサイドバーの帯 (w-12) と同じにして、帯のアイコンと縦に揃える。
          "flex h-full w-12 shrink-0 items-center justify-center outline-none transition-colors hover:bg-sidebar-accent focus-visible:bg-sidebar-accent",
          mac && "ml-[72px] w-10 rounded-md",
        )}
      >
        <MenuIcon className="size-4" />
      </button>
    </Hint>
  );

  const content = (
    <>
      {hamburger}
      <span
        className={cn(
          "pointer-events-none flex items-center gap-2",
          mac
            ? "absolute inset-x-0 justify-center"
            : hamburger
              ? "ml-1"
              : "ml-3",
        )}
      >
        <OrbitMark className="size-4" />
        <span className="text-xs">Orbit Mail</span>
      </span>
      <span data-tauri-drag-region className="h-full flex-1" />
      {!mac && (
        <>
          <CaptionButton
            kind="minimize"
            label="最小化"
            onClick={desktopWindow.minimize}
            platform={platform}
          />
          <CaptionButton
            kind={maximized ? "restore" : "maximize"}
            label={maximized ? "元に戻す" : "最大化"}
            onClick={desktopWindow.toggleMaximize}
            platform={platform}
          />
          <CaptionButton
            kind="close"
            label="閉じる"
            onClick={desktopWindow.close}
            platform={platform}
          />
        </>
      )}
    </>
  );

  const className = cn(
    "fixed inset-x-0 top-0 z-[60] flex h-(--titlebar-height) select-none items-center border-b bg-sidebar text-sidebar-foreground",
    !active && "text-sidebar-foreground/50",
  );

  if (platform === "linux") {
    return (
      <LinuxSystemMenu maximized={maximized}>
        <ContextMenuTrigger
          render={<div data-tauri-drag-region className={className} />}
        >
          {content}
        </ContextMenuTrigger>
      </LinuxSystemMenu>
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: OS のウィンドウ枠と同じく、右クリックでシステムメニューを出すだけ
    <div
      data-tauri-drag-region
      onContextMenu={platform === "windows" ? onContextMenu : undefined}
      className={className}
    >
      {content}
    </div>
  );
}
