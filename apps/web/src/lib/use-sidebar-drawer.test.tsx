// @vitest-environment happy-dom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTopSheet, openSheetCount } from "@/lib/sheet-back";
import { useSidebarDrawer } from "@/lib/use-sidebar-drawer";

let setOpen: (open: boolean) => void = () => {};
let shown = false;

function Harness() {
  const [open, setOpenState] = useState(false);
  setOpen = setOpenState;
  shown = open;
  const asideRef = useRef<HTMLElement>(null);
  const backdropRef = useRef<HTMLButtonElement>(null);
  useSidebarDrawer({
    asideRef,
    backdropRef,
    open,
    onOpenChange: setOpenState,
  });
  return (
    <>
      <button ref={backdropRef} type="button" aria-label="閉じる" />
      <aside ref={asideRef} />
    </>
  );
}

describe("useSidebarDrawer (引き出しのサイドバー)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let narrow = true;

  beforeEach(async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    narrow = true;
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({ matches: narrow, media: query }) as unknown as MediaQueryList,
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("開いている間は Esc で閉じる", async () => {
    await act(async () => setOpen(true));
    expect(shown).toBe(true);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(shown).toBe(false);
  });

  it("スマホ幅で開いている間は、戻る操作で閉じる", async () => {
    expect(openSheetCount()).toBe(0);
    await act(async () => setOpen(true));
    expect(openSheetCount()).toBe(1);
    await act(async () => {
      expect(closeTopSheet()).toBe(true);
    });
    expect(shown).toBe(false);
    expect(openSheetCount()).toBe(0);
  });

  it("広い画面では戻る操作に登録しない", async () => {
    narrow = false;
    await act(async () => setOpen(true));
    expect(openSheetCount()).toBe(0);
  });
});
