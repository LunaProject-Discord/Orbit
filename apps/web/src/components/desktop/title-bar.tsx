"use client";

import { cn } from "cn";
import { CopyIcon, MenuIcon, MinusIcon, SquareIcon, XIcon } from "lucide-react";
import {
  type MouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
import {
  useTitleBarMenu,
  useTitleBarTitle,
  windowTitle,
} from "@/lib/desktop/title-bar-menu";

type Caption = "minimize" | "maximize" | "restore" | "close";

/** 画面の拡大率 (devicePixelRatio)。モニターを移ったときや拡大率を変えたときに追う。 */
function useDevicePixelRatio(): number {
  const [ratio, setRatio] = useState(1);
  useEffect(() => {
    let query: MediaQueryList | null = null;
    const update = () => {
      setRatio(window.devicePixelRatio || 1);
      query?.removeEventListener("change", update);
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      query.addEventListener("change", update);
    };
    update();
    return () => query?.removeEventListener("change", update);
  }, []);
  return ratio;
}

/**
 * Windows 11 のキャプションボタンの絵 (最小化・最大化・元に戻す・閉じる)。
 * 形は OS の枠のボタン (Segoe Fluent Icons の ChromeMinimize / ChromeMaximize / ChromeRestore /
 * ChromeClose) と同じ 10px 四方。以前はそのフォントの字で描いていたが、WebView では文字として
 * 薄く細く描かれ、OS のボタンと見比べると違って見えた (あおいさんの指摘)。そこで OS と同じように、
 * 画面の画素に合わせた太さの線で描く (拡大率 125% までは 1 画素、それより大きければ比例して太くする)。
 */
function WindowsCaptionGlyph({ kind }: { kind: Caption }) {
  const ratio = useDevicePixelRatio();
  const ref = useRef<SVGSVGElement>(null);
  // 拡大率が 125% などのとき、ボタンの中央が画素の途中に来て線がにじむ (薄く見える)。
  // 絵の左上を画素の境目に合わせるよう、端数の分だけずらす。
  useLayoutEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const align = () => {
      svg.style.translate = "";
      const box = svg.getBoundingClientRect();
      const dx = Math.round(box.left * ratio) / ratio - box.left;
      const dy = Math.round(box.top * ratio) / ratio - box.top;
      svg.style.translate = `${dx}px ${dy}px`;
    };
    align();
    window.addEventListener("resize", align);
    return () => window.removeEventListener("resize", align);
  }, [ratio]);
  // 以下は画面の画素で数える。
  const size = Math.round(10 * ratio);
  // 斜めの線 (閉じる) はにじんで細く見えるので、拡大率どおりの太さにする。
  const stroke =
    kind === "close"
      ? Math.max(1, ratio)
      : Math.max(1, Math.floor(ratio + 0.25));
  const half = stroke / 2;
  const radius = Math.max(1, Math.round(ratio));
  let shape: ReactNode;
  switch (kind) {
    case "minimize": {
      const y = Math.floor(size / 2) + half;
      shape = <path d={`M0 ${y}H${size}`} />;
      break;
    }
    case "maximize":
      shape = (
        <rect
          x={half}
          y={half}
          width={size - stroke}
          height={size - stroke}
          rx={radius}
        />
      );
      break;
    case "restore": {
      // 手前の四角 (左下) と、右上にずらした奥の四角の見えている部分 (上と右の辺)。
      const offset = Math.max(2, Math.round(2 * ratio));
      const back = radius + 0.5 * ratio;
      shape = (
        <>
          <rect
            x={half}
            y={offset + half}
            width={size - offset - stroke}
            height={size - offset - stroke}
            rx={radius}
          />
          <path
            d={[
              `M${offset + half} ${offset}`,
              `V${half + back}`,
              `A${back} ${back} 0 0 1 ${offset + half + back} ${half}`,
              `H${size - half - back}`,
              `A${back} ${back} 0 0 1 ${size - half} ${half + back}`,
              `V${size - offset - half - back}`,
              `A${back} ${back} 0 0 1 ${size - half - back} ${size - offset - half}`,
              `H${size - offset}`,
            ].join("")}
          />
        </>
      );
      break;
    }
    case "close":
      shape = (
        <path
          d={`M${half} ${half}L${size - half} ${size - half}M${size - half} ${half}L${half} ${size - half}`}
        />
      );
      break;
  }
  return (
    <svg
      ref={ref}
      aria-hidden="true"
      width={size / ratio}
      height={size / ratio}
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      // 縦横の線は画素にぴったり合わせて、OS のボタンと同じく濃くくっきり描く (斜めの線は対象外)。
      shapeRendering={kind === "close" ? undefined : "crispEdges"}
    >
      {shape}
    </svg>
  );
}

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
      className={cn(
        "flex h-full items-center justify-center outline-none transition-colors duration-100",
        windows ? "w-[46px]" : "w-11",
        // Windows 11 の TextFillColorPrimary (前面) / TextFillColorDisabled (後ろ)。
        windows &&
          (active
            ? "text-black/[0.8956] dark:text-white"
            : "text-black/[0.3614] dark:text-white/[0.3628]"),
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
        <WindowsCaptionGlyph kind={kind} />
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

  // OS のウィンドウの名前 (タスクバーや Alt+Tab に出る) も合わせる。
  useEffect(() => {
    if (!platform) return;
    void desktopWindow.setTitle(title);
  }, [platform, title]);

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
          "pointer-events-none flex min-w-0 items-center gap-2",
          mac
            ? "absolute inset-x-0 justify-center"
            : hamburger
              ? "ml-1"
              : "ml-3",
        )}
      >
        <OrbitMark className="size-4 shrink-0" />
        <span className="truncate text-xs">{title}</span>
      </span>
      <span data-tauri-drag-region className="h-full flex-1" />
      {!mac && (
        <>
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
