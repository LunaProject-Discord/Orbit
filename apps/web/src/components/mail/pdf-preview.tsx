"use client";

import { FileWarningIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from "pdfjs-dist";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  canvasPixelRatio,
  clampZoom,
  currentPageIndex,
  MAX_ZOOM,
  MIN_ZOOM,
  type PdfErrorKind,
  pdfErrorKind,
  pdfErrorMessage,
  stepZoom,
} from "@/lib/pdf-preview";

/*
 * 添付の PDF を pdf.js で canvas に描いて表示する。PDF ビューアの無い環境
 * (Android の WebView など。どちらを使うかは lib/pdf-preview.ts の pdfPreviewMethod) で使う。
 *
 * PDF は差出人が自由に作れるので、描くのは canvas だけにする。注釈のリンクや入力欄の層、
 * PDF の中のスクリプト (pdf.js のビューアの機能) は使わない。XFA のフォームも描かない。
 * pdf.js 本体は大きいので、プレビューを開いたときに初めて読み込む。
 */

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

/** ページの周りと間の余白 (px)。幅に合わせるときに差し引く。 */
const PAGE_PADDING = 12;
/** 幅に合わせるときの上限 (px)。広い画面で 1 ページが巨大にならないようにする。 */
const MAX_FIT_WIDTH = 1000;
/** 拡大率を変えている間 (ピンチ中など) は描き直さず、止まってからこの時間 (ms) 後に描く。 */
const REDRAW_DELAY_MS = 150;

/**
 * pdf.js が実行中に取得するファイル (ワーカー、CMap、フォント、wasm) の置き場。
 * scripts/copy-pdfjs.mjs が public/pdfjs/<版>/ に写している。ワーカーから取得するので絶対 URL にする。
 */
function assetBase(version: string): string {
  return new URL(`/pdfjs/${version}/`, window.location.href).href;
}

let pdfjsLoading: Promise<PdfJs> | null = null;

/**
 * pdf.js を読み込む。古めの WebView でも動くよう legacy の版を使う。
 * 読み込めなかったとき (通信が切れていたなど) は、次に開いたときにもう一度試す。
 */
function loadPdfJs(): Promise<PdfJs> {
  pdfjsLoading ??= import("pdfjs-dist/legacy/build/pdf.mjs").then(
    (pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = `${assetBase(pdfjs.version)}pdf.worker.min.js`;
      return pdfjs;
    },
    (error: unknown) => {
      pdfjsLoading = null;
      throw error;
    },
  );
  return pdfjsLoading;
}

type Size = { width: number; height: number };

type State =
  | { status: "loading" }
  | { status: "error"; kind: PdfErrorKind }
  | {
      status: "ready";
      doc: PDFDocumentProxy;
      /** 1 ページ目の大きさ (拡大率 1)。まだ読み込んでいないページの仮の大きさにも使う。 */
      first: Size;
      /** 注釈の見た目 (スタンプや書き込みなど) を canvas に描く指定。リンクの層は作らない。 */
      annotationMode: number;
    };

export function PdfPreview({ blob, title }: { blob: Blob; title: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  /** 1 が幅に合わせた大きさ。 */
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const [width, setWidth] = useState(0);
  const [current, setCurrent] = useState(1);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  /** 拡大率を変えたときに、指 (またはカーソル) の下の位置を動かさないための情報。 */
  const anchor = useRef<{ ratio: number; x: number; y: number } | null>(null);

  const attachScroller = useCallback((element: HTMLDivElement | null) => {
    scrollerRef.current = element;
    setScroller(element);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    setState({ status: "loading" });
    setZoom(1);
    zoomRef.current = 1;
    setCurrent(1);
    void (async () => {
      try {
        const pdfjs = await loadPdfJs();
        const data = new Uint8Array(await blob.arrayBuffer());
        if (cancelled) return;
        const base = assetBase(pdfjs.version);
        task = pdfjs.getDocument({
          data,
          cMapUrl: `${base}cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${base}standard_fonts/`,
          wasmUrl: `${base}wasm/`,
          iccUrl: `${base}iccs/`,
          // 差出人のファイルなので、XFA のフォーム (HTML として組み立てる) は描かない。
          // なお isEvalSupported は、この版の pdf.js では eval を使わなくなったため無くなっている。
          enableXfa: false,
          // 巨大な画像を仕込んだ PDF でメモリを使い果たさないよう、描く画像の画素数に上限を設ける。
          maxImageSize: 8192 * 8192,
          // 描画用のワーカーのファイルは配っていないので、描画は画面側で行う (読み込みはワーカー)。
          disableWorkerRendering: true,
        });
        const doc = await task.promise;
        const page = await doc.getPage(1);
        const { width, height } = page.getViewport({ scale: 1 });
        if (cancelled) return;
        setState({
          status: "ready",
          doc,
          first: { width, height },
          annotationMode: pdfjs.AnnotationMode.ENABLE,
        });
      } catch (error) {
        if (!cancelled)
          setState({ status: "error", kind: pdfErrorKind(error) });
      }
    })();
    return () => {
      cancelled = true;
      // 読み込み中でも読み込み後でも、ワーカーの中の文書ごと片付ける。
      void task?.destroy();
    };
  }, [blob]);

  /** ページを読み込む (同じページは 1 度だけ)。 */
  const loadPage = useMemo(() => {
    if (state.status !== "ready") return null;
    const { doc } = state;
    const pages = new Map<number, Promise<PDFPageProxy>>();
    return (number: number) => {
      let page = pages.get(number);
      if (!page) {
        page = doc.getPage(number);
        pages.set(number, page);
      }
      return page;
    };
  }, [state]);

  // 表示領域の幅に合わせて、ページの大きさを決める。
  useEffect(() => {
    if (!scroller) return;
    const update = () => setWidth(scroller.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller]);

  /** 拡大率を変える。x, y は動かさない位置 (表示領域の左上から)。省略すると表示領域の中央。 */
  const applyZoom = useCallback((next: number, x?: number, y?: number) => {
    const element = scrollerRef.current;
    const zoom = clampZoom(next);
    if (!element || zoom === zoomRef.current) return;
    anchor.current = {
      ratio: zoom / zoomRef.current,
      x: x ?? element.clientWidth / 2,
      y: y ?? element.clientHeight / 2,
    };
    zoomRef.current = zoom;
    setZoom(zoom);
  }, []);

  // 拡大率を変えたら、基準の位置が同じ場所に来るようにスクロールし直す (描く前に行う)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: zoom は描き直しのきっかけとして使う
  useLayoutEffect(() => {
    const element = scrollerRef.current;
    const target = anchor.current;
    anchor.current = null;
    if (!element || !target) return;
    element.scrollLeft =
      (element.scrollLeft + target.x) * target.ratio - target.x;
    element.scrollTop =
      (element.scrollTop + target.y) * target.ratio - target.y;
  }, [zoom]);

  // ピンチと、Ctrl + ホイール (トラックパッドのピンチもこれで届く) で拡大・縮小する。
  useEffect(() => {
    if (!scroller) return;
    let pinch: { distance: number; zoom: number } | null = null;
    const distance = (touches: TouchList) => {
      const [a, b] = [touches[0], touches[1]];
      return a && b
        ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
        : 0;
    };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      const start = distance(event.touches);
      pinch = start > 0 ? { distance: start, zoom: zoomRef.current } : null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const [a, b] = [event.touches[0], event.touches[1]];
      if (!pinch || !a || !b) return;
      // 2 本指の間はスクロールさせず、拡大・縮小だけにする。
      event.preventDefault();
      const rect = scroller.getBoundingClientRect();
      applyZoom(
        (pinch.zoom * distance(event.touches)) / pinch.distance,
        (a.clientX + b.clientX) / 2 - rect.left,
        (a.clientY + b.clientY) / 2 - rect.top,
      );
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) pinch = null;
    };
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const rect = scroller.getBoundingClientRect();
      applyZoom(
        zoomRef.current * Math.exp(-event.deltaY / 200),
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
    };
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchmove", onTouchMove, { passive: false });
    scroller.addEventListener("touchend", onTouchEnd, { passive: true });
    scroller.addEventListener("touchcancel", onTouchEnd, { passive: true });
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchmove", onTouchMove);
      scroller.removeEventListener("touchend", onTouchEnd);
      scroller.removeEventListener("touchcancel", onTouchEnd);
      scroller.removeEventListener("wheel", onWheel);
    };
  }, [scroller, applyZoom]);

  // いま見ているページの番号を、スクロールに合わせて出す。
  useEffect(() => {
    if (!scroller || state.status !== "ready") return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = scroller.getBoundingClientRect().top;
      const bottoms = Array.from(
        scroller.querySelectorAll("[data-pdf-page]"),
        (page) => page.getBoundingClientRect().bottom - top,
      );
      setCurrent(currentPageIndex(bottoms, scroller.clientHeight) || 1);
    };
    const onScroll = () => {
      frame ||= requestAnimationFrame(update);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [scroller, state.status]);

  if (state.status === "loading") {
    return (
      <output className="flex size-full select-none items-center justify-center gap-2 text-muted-foreground text-sm">
        <Spinner className="size-4" />
        PDF を読み込んでいます
      </output>
    );
  }
  if (state.status === "error") {
    return (
      <div
        role="alert"
        className="flex size-full select-none flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground text-sm"
      >
        <FileWarningIcon className="size-8" aria-hidden="true" />
        <p className="max-w-xs text-balance">{pdfErrorMessage(state.kind)}</p>
      </div>
    );
  }

  const available = Math.min(width - PAGE_PADDING * 2, MAX_FIT_WIDTH);
  const scale = available > 0 ? (available / state.first.width) * zoom : 0;
  const count = state.doc.numPages;

  return (
    <div className="relative size-full select-none">
      <div
        ref={attachScroller}
        // 2 本指の操作は画面側で拡大・縮小に使う (ブラウザーに画面全体を拡大させない)。
        className="absolute inset-0 touch-pan-x touch-pan-y overflow-auto overscroll-contain"
        role="document"
        aria-label={title}
      >
        {scale > 0 && loadPage && (
          <div
            className="flex w-max min-w-full flex-col items-center"
            style={{
              gap: PAGE_PADDING,
              padding: PAGE_PADDING,
              // 下のツールバーに最後のページが隠れないようにする。
              paddingBottom: PAGE_PADDING + 56,
            }}
          >
            {Array.from({ length: count }, (_, index) => (
              <PdfPage
                // biome-ignore lint/suspicious/noArrayIndexKey: ページの番号そのものが識別子
                key={index}
                number={index + 1}
                scale={scale}
                estimate={state.first}
                loadPage={loadPage}
                root={scroller}
                annotationMode={state.annotationMode}
              />
            ))}
          </div>
        )}
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-full bg-popover/95 p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
          <span className="px-2.5 text-muted-foreground text-xs tabular-nums">
            {current} / {count}
          </span>
          <Hint label="縮小">
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              aria-label="縮小"
              disabled={zoom <= MIN_ZOOM}
              onClick={() => applyZoom(stepZoom(zoom, -1))}
            >
              <ZoomOutIcon />
            </Button>
          </Hint>
          <Hint label="幅に合わせる">
            <Button
              variant="ghost"
              size="sm"
              className="min-w-14 rounded-full tabular-nums"
              aria-label={`幅に合わせる (いまは ${Math.round(zoom * 100)}%)`}
              onClick={() => applyZoom(1)}
            >
              {Math.round(zoom * 100)}%
            </Button>
          </Hint>
          <Hint label="拡大">
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              aria-label="拡大"
              disabled={zoom >= MAX_ZOOM}
              onClick={() => applyZoom(stepZoom(zoom, 1))}
            >
              <ZoomInIcon />
            </Button>
          </Hint>
        </div>
      </div>
    </div>
  );
}

/** 解放する canvas。幅を 0 にすると、ガベージコレクションを待たずに画素のメモリを手放せる。 */
function releaseCanvases(host: HTMLElement) {
  for (const canvas of host.querySelectorAll("canvas")) canvas.width = 0;
  host.replaceChildren();
}

/**
 * 1 ページ。表示領域の近く (前後 1 画面分) にあるときだけ読み込んで描き、離れたら canvas を捨てる。
 * ページが多くても、描くのも持っておくのも見ている付近の数ページだけになる。
 */
function PdfPage({
  number,
  scale,
  estimate,
  loadPage,
  root,
  annotationMode,
}: {
  number: number;
  /** 表示の大きさ (拡大率 1 のページの幅に対する倍率)。 */
  scale: number;
  /** まだ読み込んでいないときの仮の大きさ (拡大率 1)。 */
  estimate: Size;
  loadPage: (number: number) => Promise<PDFPageProxy>;
  root: HTMLElement | null;
  annotationMode: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [drawn, setDrawn] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = box.current;
    if (!element || !root) return;
    const observer = new IntersectionObserver(
      ([entry]) => setNear(entry?.isIntersecting ?? false),
      { root, rootMargin: "100% 100%" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);

  useEffect(() => {
    if (!near || page) return;
    let cancelled = false;
    loadPage(number).then(
      (loaded) => {
        if (!cancelled) setPage(loaded);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [near, page, loadPage, number]);

  useEffect(() => {
    const target = host.current;
    if (!target) return;
    if (!near) {
      releaseCanvases(target);
      setDrawn(false);
      return;
    }
    if (!page) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    const draw = () => {
      const css = page.getViewport({ scale });
      const ratio = canvasPixelRatio(
        css.width,
        css.height,
        window.devicePixelRatio,
      );
      const viewport = page.getViewport({ scale: scale * ratio });
      // 描き終わるまでは前の canvas (拡大前の大きさを引き伸ばしたもの) を見せておき、白く点滅させない。
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      canvas.className = "absolute inset-0 size-full";
      task = page.render({ canvas, viewport, annotationMode });
      task.promise.then(
        () => {
          if (cancelled) {
            canvas.width = 0;
            return;
          }
          releaseCanvases(target);
          target.append(canvas);
          setDrawn(true);
          setFailed(false);
        },
        (error: unknown) => {
          canvas.width = 0;
          const name =
            error && typeof error === "object" && "name" in error
              ? error.name
              : "";
          if (cancelled || name === "RenderingCancelledException") return;
          setFailed(true);
        },
      );
    };
    const timer = window.setTimeout(
      draw,
      target.firstChild ? REDRAW_DELAY_MS : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      task?.cancel();
    };
  }, [near, page, scale, annotationMode]);

  // 読み込んだページは本当の大きさで (ページごとに大きさや向きが違うことがある)。
  const size = page
    ? page.getViewport({ scale })
    : { width: estimate.width * scale, height: estimate.height * scale };

  return (
    <div
      ref={box}
      data-pdf-page=""
      role="img"
      aria-label={`${number} ページ目`}
      className="relative shrink-0 bg-white shadow-sm ring-1 ring-black/10"
      style={{ width: size.width, height: size.height }}
    >
      <div ref={host} className="absolute inset-0" />
      {failed ? (
        <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-neutral-500 text-xs">
          このページを表示できませんでした
        </p>
      ) : (
        near &&
        !drawn && (
          <Spinner className="absolute top-1/2 left-1/2 size-5 -translate-x-1/2 -translate-y-1/2 text-neutral-400" />
        )
      )}
    </div>
  );
}
