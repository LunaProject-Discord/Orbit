// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfPreview } from "@/components/mail/pdf-preview";

type Params = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  params: [] as Params[],
  destroyed: 0,
  result: null as null | (() => Promise<unknown>),
  workerOptions: { workerSrc: "" },
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  version: "9.9.9",
  GlobalWorkerOptions: mocks.workerOptions,
  AnnotationMode: { ENABLE: 1 },
  getDocument: (params: Params) => {
    mocks.params.push(params);
    return {
      promise: mocks.result?.() ?? new Promise(() => {}),
      destroy: async () => {
        mocks.destroyed += 1;
      },
    };
  },
}));

const page = {
  getViewport: ({ scale }: { scale: number }) => ({
    width: 600 * scale,
    height: 800 * scale,
  }),
  render: () => ({ promise: new Promise(() => {}), cancel: () => {} }),
};

function documentWith(numPages: number) {
  return { numPages, getPage: async () => page };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.params = [];
  mocks.destroyed = 0;
  mocks.result = null;
  // happy-dom は大きさを計算しないので、表示領域の幅を決めておく。
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function render() {
  await act(async () => {
    root.render(
      <PdfPreview blob={new Blob(["%PDF-1.7"])} title="見積書.pdf" />,
    );
  });
  // 読み込み (動的 import と Promise) が済むのを待つ。
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("PdfPreview", () => {
  it("読み込み中は印を出し、信頼できないファイル向けの設定で開く", async () => {
    await render();
    expect(container.textContent).toContain("PDF を読み込んでいます");
    expect(container.querySelector("[data-slot=spinner]")).not.toBeNull();
    const [params] = mocks.params;
    expect(params).toMatchObject({
      enableXfa: false,
      cMapPacked: true,
      disableWorkerRendering: true,
    });
    expect(String(params?.cMapUrl)).toMatch(/\/pdfjs\/9\.9\.9\/cmaps\/$/);
    expect(String(params?.standardFontDataUrl)).toMatch(
      /\/pdfjs\/9\.9\.9\/standard_fonts\/$/,
    );
    expect(String(params?.wasmUrl)).toMatch(/\/pdfjs\/9\.9\.9\/wasm\/$/);
    expect(mocks.workerOptions.workerSrc).toMatch(
      /\/pdfjs\/9\.9\.9\/pdf\.worker\.min\.js$/,
    );
  });

  it("パスワード付きの PDF は、白い画面ではなく説明を出す", async () => {
    mocks.result = () =>
      Promise.reject(
        Object.assign(new Error("No password given"), {
          name: "PasswordException",
        }),
      );
    await render();
    const alert = container.querySelector("[role=alert]");
    expect(alert?.textContent).toContain("パスワードで保護された PDF");
    expect(alert?.textContent).toContain("別のアプリで開いてください");
  });

  it("すべてのページの枠を縦に並べ、拡大・縮小できる", async () => {
    mocks.result = async () => documentWith(3);
    await render();
    const pages = container.querySelectorAll<HTMLElement>("[data-pdf-page]");
    expect(pages).toHaveLength(3);
    // 幅 390 から余白 (12px × 2) を引いた幅に合わせる。
    expect(pages[0]?.style.width).toBe("366px");
    expect(container.textContent).toContain("1 / 3");
    expect(container.textContent).toContain("100%");

    const zoomIn = container.querySelector<HTMLButtonElement>(
      "button[aria-label=拡大]",
    );
    await act(async () => zoomIn?.click());
    expect(container.textContent).toContain("125%");
    expect(pages[0]?.style.width).toBe("457.5px");

    const fit = container.querySelector<HTMLButtonElement>(
      "button[aria-label^=幅に合わせる]",
    );
    await act(async () => fit?.click());
    expect(container.textContent).toContain("100%");
  });

  it("閉じたら読み込みと文書を片付ける", async () => {
    mocks.result = async () => documentWith(1);
    await render();
    act(() => root.render(<div />));
    expect(mocks.destroyed).toBe(1);
  });
});
