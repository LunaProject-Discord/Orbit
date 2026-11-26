import { describe, expect, it, vi } from "vitest";
import {
  blocksDrag,
  forceReload,
  isHistoryButton,
  resolveDesktopKey,
} from "@/lib/desktop/browser-keys";

type Modifiers = Partial<{
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing: boolean;
}>;

const press = (
  key: string,
  modifiers: Modifiers = {},
  options: { mac?: boolean; editable?: boolean; code?: string } = {},
) =>
  resolveDesktopKey(
    {
      key,
      code:
        options.code ??
        (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : undefined),
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ...modifiers,
    },
    options,
  );

describe("resolveDesktopKey", () => {
  it("再読み込みのキーを、フォルダ・アカウントの更新と再読み込みに割り当てる", () => {
    expect(press("r", { ctrlKey: true })).toBe("refreshFolder");
    expect(press("F5")).toBe("refreshFolder");
    expect(press("R", { ctrlKey: true, shiftKey: true })).toBe(
      "refreshAccount",
    );
    expect(press("F5", { shiftKey: true })).toBe("refreshAccount");
    expect(press("r", { ctrlKey: true, altKey: true })).toBe("reload");
    expect(press("F5", { ctrlKey: true, altKey: true })).toBe("reload");
    expect(press("R", { ctrlKey: true, altKey: true, shiftKey: true })).toBe(
      "forceReload",
    );
    expect(press("F5", { ctrlKey: true, altKey: true, shiftKey: true })).toBe(
      "forceReload",
    );
    // ブラウザーの「キャッシュを使わずに再読み込み」(Ctrl+F5) は何もしない。
    expect(press("F5", { ctrlKey: true })).toBe("block");
  });

  it("Alt で文字が変わっても、キーの位置で判断する", () => {
    // macOS の Option+R は ® になる。
    expect(
      press("®", { metaKey: true, altKey: true }, { mac: true, code: "KeyR" }),
    ).toBe("reload");
  });

  it("検索のキーを、検索欄とメールの中の検索に割り当てる", () => {
    expect(press("f", { ctrlKey: true })).toBe("focusSearch");
    expect(press("F3")).toBe("focusSearch");
    expect(press("F", { ctrlKey: true, shiftKey: true })).toBe("findInMessage");
    expect(press("F3", { shiftKey: true })).toBe("findInMessage");
  });

  it("Ctrl+P は印刷、それ以外の組み合わせは止めるだけ", () => {
    expect(press("p", { ctrlKey: true })).toBe("print");
    expect(press("P", { ctrlKey: true, shiftKey: true })).toBe("block");
  });

  it("macOS では ⌘ を Ctrl の代わりに使い、Control との組み合わせは OS に任せる", () => {
    expect(press("r", { metaKey: true }, { mac: true })).toBe("refreshFolder");
    expect(press("f", { metaKey: true }, { mac: true })).toBe("focusSearch");
    expect(press("r", { ctrlKey: true }, { mac: true })).toBeNull();
    // Windows の Win キーとの組み合わせも OS に任せる。
    expect(press("r", { metaKey: true })).toBeNull();
  });

  it("ズーム、ソースの表示、開発者ツールなどのキーを止める", () => {
    expect(
      press("+", { ctrlKey: true, shiftKey: true }, { code: "Semicolon" }),
    ).toBe("block");
    expect(press("-", { ctrlKey: true }, { code: "Minus" })).toBe("block");
    expect(press("0", { ctrlKey: true }, { code: "Digit0" })).toBe("block");
    expect(press("u", { ctrlKey: true })).toBe("block");
    expect(press("s", { ctrlKey: true })).toBe("block");
    expect(press("I", { ctrlKey: true, shiftKey: true })).toBe("block");
    expect(press("F7")).toBe("block");
    expect(press("F12")).toBe("block");
    expect(press("BrowserBack")).toBe("block");
    expect(press("ArrowLeft", { altKey: true })).toBe("block");
  });

  it("入力欄の中では、文字の操作に使うキーを止めない", () => {
    expect(press("u", { ctrlKey: true }, { editable: true })).toBeNull();
    expect(press("s", { ctrlKey: true }, { editable: true })).toBeNull();
    // 再読み込みや検索は、入力欄の中でも割り当てどおり。
    expect(press("r", { ctrlKey: true }, { editable: true })).toBe(
      "refreshFolder",
    );
  });

  it("ふつうのキーや、文字の入力中は何もしない", () => {
    expect(press("a")).toBeNull();
    expect(press("c", { ctrlKey: true })).toBeNull();
    expect(press("v", { ctrlKey: true })).toBeNull();
    expect(press("a", { ctrlKey: true })).toBeNull();
    expect(press("F5", { isComposing: true })).toBeNull();
    // macOS の Option+← は単語単位の移動。
    expect(press("ArrowLeft", { altKey: true }, { mac: true })).toBeNull();
  });
});

describe("isHistoryButton", () => {
  it("マウスの戻る・進むボタンだけを対象にする", () => {
    expect(isHistoryButton(3)).toBe(true);
    expect(isHistoryButton(4)).toBe(true);
    expect(isHistoryButton(0)).toBe(false);
    expect(isHistoryButton(1)).toBe(false);
    expect(isHistoryButton(2)).toBe(false);
  });
});

describe("blocksDrag", () => {
  const element = (matches: Record<string, boolean>) =>
    ({
      closest: (selector: string) => (matches[selector] ? {} : null),
    }) as unknown as EventTarget;

  it("画像やリンクのドラッグを止める", () => {
    expect(blocksDrag(element({ "img, a, svg": true }))).toBe(true);
  });

  it("アプリが引っ張れるようにした要素と、入力欄の中はそのまま", () => {
    expect(
      blocksDrag(element({ "img, a, svg": true, '[draggable="true"]': true })),
    ).toBe(false);
    expect(
      blocksDrag(
        element({
          "img, a, svg": true,
          "input, textarea, select, [contenteditable]": true,
        }),
      ),
    ).toBe(false);
    expect(blocksDrag(element({}))).toBe(false);
    expect(blocksDrag(null)).toBe(false);
  });
});

describe("forceReload", () => {
  const fakeWindow = () => {
    const deleted: string[] = [];
    const reload = vi.fn();
    const win = {
      caches: {
        keys: async () => ["a", "b"],
        delete: async (key: string) => {
          deleted.push(key);
          return true;
        },
      },
      location: { reload },
    } as unknown as Window;
    return { win, deleted, reload };
  };

  it("控えを消してから、アプリ側に読み込み直しを頼む", async () => {
    const { win, deleted, reload } = fakeWindow();
    const native = vi.fn(async () => undefined);
    await forceReload(win, native);
    expect(deleted).toEqual(["a", "b"]);
    expect(native).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });

  it("アプリ側に頼めなければ、ふつうに再読み込みする", async () => {
    const { win, reload } = fakeWindow();
    await forceReload(win, async () => null);
    expect(reload).toHaveBeenCalledOnce();
  });
});
