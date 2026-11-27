"use client";

import { cn } from "cn";
import { CopyIcon, MinusIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { OrbitMark } from "@/components/brand/orbit-logo";
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
import { titleBarHeight } from "@/lib/desktop/title-bar-height";
import { useTitleBarTitle, windowTitle } from "@/lib/desktop/title-bar-menu";
import {
  type CaptionArea,
  isTopRow,
  isWindowDragTarget,
  type RowBox,
  rowInsets,
  TITLE_BAR_ROW_ATTRIBUTE,
} from "@/lib/desktop/title-bar-rows";

/**
 * Windows のキャプションボタンの字形 (Segoe Fluent Icons / Segoe MDL2 Assets)。
 * OS の枠のボタンと同じ絵にするため、OS に入っているアイコンのフォントで描く。
 * Windows 11 は Segoe Fluent Icons、Windows 10 は Segoe MDL2 Assets が入っている (どちらも同じ字の位置)。
 * 一度は画素に合わせた SVG に変えたが (PR #175)、実機ではフォントの細い線の方がよいとのことで戻した
 * (あおいさんの判断)。色だけは Windows 11 の標準色にそろえている。
 */
const CAPTION_GLYPHS = {
  minimize: "",
  maximize: "",
  restore: "",
  close: "",
} as const;

type Caption = keyof typeof CAPTION_GLYPHS;

/** キャプションボタン 1 つの幅 (Windows 11 の枠のボタンと同じ 46px。Linux も同じにする)。 */
const CAPTION_BUTTON_WIDTH = 46;
/** キャプションボタンと、上部の行の中身との間。 */
const CAPTION_GAP = 8;
/**
 * macOS の信号機ボタンの右端 + 間 (px)。apps/desktop の tauri.macos.conf.json の
 * trafficLightPosition (x 20) に、ボタン 3 つ分 (間隔 20px、幅 14px) と間 14px を足した値。
 * 行の先頭のボタンは -ml-2 で左へ寄せているので、アイコンはここから 8px 右に来る。
 */
const MAC_TRAFFIC_LIGHTS_END = 88;

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
  active,
}: {
  kind: Caption;
  label: string;
  onClick: () => void;
  platform: DesktopPlatform;
  /** ウィンドウが前面にあるか。 */
  active: boolean;
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
      style={{ width: CAPTION_BUTTON_WIDTH }}
      className={cn(
        "flex h-full items-center justify-center outline-none transition-colors duration-100",
        // Windows 11 の TextFillColorPrimary (前面) / TextFillColorDisabled (後ろ)。
        windows
          ? active
            ? "text-black/[0.8956] dark:text-white"
            : "text-black/[0.3614] dark:text-white/[0.3628]"
          : !active && "text-foreground/50",
        kind === "close"
          ? // Windows 11 の閉じるボタンの色。
            "hover:bg-[#c42b1c] hover:text-white active:bg-[#c42b1c]/90 active:text-white/80"
          : windows
            ? // Windows 11 の SubtleFillColorSecondary / Tertiary。
              "hover:bg-black/[0.0373] active:bg-black/[0.0241] dark:active:bg-white/[0.0419] dark:hover:bg-white/[0.0605]"
            : "hover:bg-accent",
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

/**
 * Linux の右クリックで出す、システムメニューの代わり (OS のメニューを呼び出す手段が無いため)。
 * 上部の行はアプリのあちこちにあるので、見えない受け口に右クリックを送り、押した位置に出す
 * (text-context-menu.tsx と同じ作り)。
 */
function LinuxSystemMenu({
  maximized,
  triggerRef,
}: {
  maximized: boolean;
  triggerRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger
        ref={triggerRef}
        aria-hidden="true"
        className="pointer-events-none fixed top-0 left-0 size-0"
      />
      <ContextMenuContent finalFocus={false} className="min-w-48">
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

const INTEGRATED_ATTRIBUTE = "data-titlebar-integrated";

function setInset(
  row: HTMLElement,
  side: "start" | "end",
  value: number | null,
) {
  const attribute = `data-titlebar-${side}`;
  const property = `--titlebar-${side}`;
  if (value === null) {
    if (!row.hasAttribute(attribute)) return;
    row.removeAttribute(attribute);
    row.style.removeProperty(property);
    return;
  }
  const next = `${value}px`;
  if (row.getAttribute(attribute) === next) return;
  row.setAttribute(attribute, next);
  row.style.setProperty(property, next);
}

/**
 * 上部の行 (data-titlebar) を見張り、ボタンにかかる行に余白を空ける。
 * 上端に行があるか (細いタイトルバーが要らないか) を html の data-titlebar-integrated で示す。
 * 戻り値の関数で止める。
 */
function watchTitleBarRows(platform: DesktopPlatform): () => void {
  const root = document.documentElement;
  const mac = platform === "macos";
  let frame = 0;
  const resizeObserver = new ResizeObserver(() => schedule());

  const measure = () => {
    frame = 0;
    const area: CaptionArea = {
      viewportWidth: root.clientWidth,
      reserveLeft: mac ? MAC_TRAFFIC_LIGHTS_END : 0,
      reserveRight: mac ? 0 : CAPTION_BUTTON_WIDTH * 3 + CAPTION_GAP,
      // 細いタイトルバーを出している間は、その下の行も上端の行として扱う。
      maxTop: titleBarHeight(),
    };
    let integrated = false;
    for (const row of document.querySelectorAll<HTMLElement>(
      `[${TITLE_BAR_ROW_ATTRIBUTE}]`,
    )) {
      const kind = row.getAttribute(TITLE_BAR_ROW_ATTRIBUTE);
      // 細いタイトルバーそのもの。
      if (kind === "bar" || kind === "false") continue;
      resizeObserver.observe(row);
      const rect = row.getBoundingClientRect();
      const style = getComputedStyle(row);
      const box: RowBox = {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        paddingLeft: Number.parseFloat(style.paddingLeft) || 0,
        paddingRight: Number.parseFloat(style.paddingRight) || 0,
        gap: Number.parseFloat(style.columnGap) || 0,
      };
      // data-titlebar-off の中 (ほかの画面に覆われている行) は、タイトルバーにしない。
      const visible =
        style.visibility !== "hidden" &&
        row.closest("[data-titlebar-off]") === null;
      if (visible && isTopRow(box, area)) integrated = true;
      const insets =
        visible && kind !== "drag"
          ? rowInsets(box, area)
          : { start: null, end: null };
      setInset(row, "start", insets.start);
      setInset(row, "end", insets.end);
    }
    if (integrated !== root.hasAttribute(INTEGRATED_ATTRIBUTE)) {
      root.toggleAttribute(INTEGRATED_ATTRIBUTE, integrated);
      // 細いタイトルバーの分だけ行の位置が変わるので、測り直す。
      schedule();
    }
  };
  function schedule() {
    if (frame === 0) frame = requestAnimationFrame(measure);
  }

  // 画面の切り替え、サイドバーの開閉、幅の変更のたびに測り直す。
  const mutationObserver = new MutationObserver(schedule);
  mutationObserver.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "hidden", "data-open", "data-closed"],
  });
  window.addEventListener("resize", schedule);
  document.addEventListener("transitionend", schedule, true);
  measure();
  return () => {
    if (frame !== 0) cancelAnimationFrame(frame);
    mutationObserver.disconnect();
    resizeObserver.disconnect();
    window.removeEventListener("resize", schedule);
    document.removeEventListener("transitionend", schedule, true);
    root.removeAttribute(INTEGRATED_ATTRIBUTE);
  };
}

/**
 * 上部の行の空き部分の操作。ドラッグでウィンドウを動かし、ダブルクリックで最大化する
 * (macOS はシステム設定に従う)。右クリックでは、Windows は OS のシステムメニュー、Linux はその代わりのメニューを出す。
 * Tauri の data-tauri-drag-region は macOS のダブルクリックを常に最大化にするので使わず、同じ決まりで自前で受け持つ。
 */
function watchWindowDrag(
  platform: DesktopPlatform,
  openLinuxMenu: (x: number, y: number) => void,
): () => void {
  const mac = platform === "macos";
  let pressed: { x: number; y: number } | null = null;
  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || (event.detail !== 1 && event.detail !== 2)) {
      return;
    }
    if (!isWindowDragTarget(event.composedPath())) return;
    // macOS では、OS と同じく離したときに動かす (離す前に動かしたらやめる)。
    if (mac && event.detail === 2) {
      pressed = { x: event.clientX, y: event.clientY };
      return;
    }
    // 文字の選択を始めない。
    event.preventDefault();
    if (event.detail === 2) void desktopWindow.titleBarDoubleClick();
    else void desktopWindow.startDragging();
  };
  const onMouseUp = (event: MouseEvent) => {
    const start = pressed;
    pressed = null;
    if (
      event.button === 0 &&
      event.detail === 2 &&
      start?.x === event.clientX &&
      start.y === event.clientY &&
      isWindowDragTarget(event.composedPath())
    ) {
      void desktopWindow.titleBarDoubleClick();
    }
  };
  const onContextMenu = (event: MouseEvent) => {
    if (!isWindowDragTarget(event.composedPath())) return;
    // 文字のメニュー (text-context-menu.tsx) や、行を囲むメニューには渡さない。
    event.preventDefault();
    event.stopPropagation();
    if (platform === "windows") showSystemMenu();
    else if (platform === "linux") openLinuxMenu(event.clientX, event.clientY);
  };
  document.addEventListener("mousedown", onMouseDown);
  if (mac) document.addEventListener("mouseup", onMouseUp);
  document.addEventListener("contextmenu", onContextMenu, true);
  return () => {
    document.removeEventListener("mousedown", onMouseDown);
    document.removeEventListener("mouseup", onMouseUp);
    document.removeEventListener("contextmenu", onContextMenu, true);
  };
}

/**
 * デスクトップ版のウィンドウ枠。ブラウザーでは何も出さない。
 *
 * 各アプリの上部の行 (data-titlebar を付けたヘッダーやサイドバーのロゴの行) をタイトルバーとして使う。
 * - Windows / Linux は、最小化・最大化・閉じるのボタンを画面の右上 (上部の行の右端) に重ねる。高さは上部の行と同じ。
 * - macOS は OS の信号機ボタン (titleBarStyle Overlay) が左上に出るので、ボタンは置かない。
 * - 上端に上部の行が無い画面 (ログイン、作成専用のウィンドウなど) では、細いタイトルバー
 *   (アイコンと名前) を出す。高さは globals.css の --titlebar-height。
 * 上部の行の余白の空け方とドラッグの決まりは lib/desktop/title-bar-rows.ts。
 */
export function DesktopTitleBar() {
  const [platform, setPlatform] = useState<DesktopPlatform | null>(null);
  const [maximized, setMaximized] = useState(false);
  /** ウィンドウが前面にあるか。後ろにあるときは、OS の枠と同じく文字とアイコンを薄くする。 */
  const [active, setActive] = useState(true);
  /** 上端に上部の行があるか (細いタイトルバーを出さないか)。 */
  const [integrated, setIntegrated] = useState(false);
  const linuxMenuRef = useRef<HTMLDivElement>(null);
  const title = windowTitle(useTitleBarTitle());

  useEffect(() => {
    if (!isDesktopApp()) return;
    setPlatform(desktopPlatform());
    const update = () => void desktopWindow.isMaximized().then(setMaximized);
    update();
    const removeResized = desktopWindow.onResized(update);
    const onFocus = () => setActive(true);
    // メール本文 (iframe) へ移っただけでも blur が届くので、ウィンドウ自体が後ろへ回ったかを確かめる。
    const onBlur = () => setTimeout(() => setActive(document.hasFocus()), 0);
    setActive(document.hasFocus());
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      removeResized();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // 上部の行の余白と、細いタイトルバーを出すかどうか。
  useEffect(() => {
    if (!platform) return;
    const root = document.documentElement;
    const stop = watchTitleBarRows(platform);
    const sync = () => setIntegrated(root.hasAttribute(INTEGRATED_ATTRIBUTE));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributeFilter: [INTEGRATED_ATTRIBUTE] });
    return () => {
      observer.disconnect();
      stop();
    };
  }, [platform]);

  useEffect(() => {
    if (!platform) return;
    return watchWindowDrag(platform, (x, y) => {
      // 見えない受け口に右クリックを送り、押した位置にメニューを出す。
      linuxMenuRef.current?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          button: 2,
        }),
      );
    });
  }, [platform]);

  // OS のウィンドウの名前 (タスクバーや Alt+Tab に出る) も合わせる。
  useEffect(() => {
    if (!platform) return;
    void desktopWindow.setTitle(title);
  }, [platform, title]);

  if (!platform) return null;
  const mac = platform === "macos";

  return (
    <>
      {!integrated && (
        <div
          {...{ [TITLE_BAR_ROW_ATTRIBUTE]: "bar" }}
          className={cn(
            "fixed inset-x-0 top-0 z-[60] flex h-(--titlebar-height) select-none items-center border-b bg-sidebar text-sidebar-foreground",
            !active && "text-sidebar-foreground/50",
          )}
          style={mac ? undefined : { paddingRight: CAPTION_BUTTON_WIDTH * 3 }}
        >
          <span
            className={cn(
              "pointer-events-none flex min-w-0 items-center gap-2",
              mac ? "absolute inset-x-0 justify-center" : "ml-3",
            )}
          >
            <OrbitMark className="size-4 shrink-0" />
            <span className="truncate text-xs">{title}</span>
          </span>
        </div>
      )}
      {!mac && (
        <div
          // 上部の行があるときはその高さ (56px)、無いときは細いタイトルバーの高さ。
          className="fixed top-0 right-0 z-[60] flex h-(--desktop-caption-height) select-none"
        >
          <CaptionButton
            kind="minimize"
            label="最小化"
            onClick={desktopWindow.minimize}
            platform={platform}
            active={active}
          />
          <CaptionButton
            kind={maximized ? "restore" : "maximize"}
            label={maximized ? "元に戻す" : "最大化"}
            onClick={desktopWindow.toggleMaximize}
            platform={platform}
            active={active}
          />
          <CaptionButton
            kind="close"
            label="閉じる"
            onClick={desktopWindow.close}
            platform={platform}
            active={active}
          />
        </div>
      )}
      {platform === "linux" && (
        <LinuxSystemMenu maximized={maximized} triggerRef={linuxMenuRef} />
      )}
    </>
  );
}
