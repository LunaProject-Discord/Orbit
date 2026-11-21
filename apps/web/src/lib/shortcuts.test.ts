import { describe, expect, it } from "vitest";
import { resolveShortcut } from "@/lib/shortcuts";

const key = (value: string, modifiers: Partial<Record<string, boolean>> = {}) =>
  resolveShortcut({
    key: value,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...modifiers,
  });

describe("resolveShortcut", () => {
  it("キーを操作に対応させる", () => {
    expect(key("j")).toBe("next");
    expect(key("ArrowUp")).toBe("previous");
    expect(key("Escape")).toBe("close");
    expect(key("m")).toBe("toggleRead");
    expect(key("s")).toBe("toggleStar");
    expect(key("c")).toBe("compose");
    expect(key("/")).toBe("search");
    expect(key("r")).toBe("reply");
    expect(key("R", { shiftKey: true })).toBe("replyAll");
    expect(key("f")).toBe("forward");
    expect(key("e")).toBe("archive");
    expect(key("a")).toBe("archive");
    expect(key("Delete")).toBe("delete");
    expect(key("v")).toBe("move");
    expect(key("x")).toBe("select");
    expect(key("z")).toBeNull();
  });

  it("Shift との組み合わせは、割り当てたものだけを受け付ける", () => {
    expect(key("I", { shiftKey: true })).toBe("markRead");
    expect(key("U", { shiftKey: true })).toBe("markUnread");
    expect(key("#", { shiftKey: true })).toBe("delete");
    expect(key("!", { shiftKey: true })).toBe("junk");
    expect(key("S", { shiftKey: true })).toBeNull();
  });

  it("Ctrl / Cmd / Alt との組み合わせと、変換中の入力は無視する", () => {
    expect(key("a", { ctrlKey: true })).toBeNull();
    expect(key("s", { metaKey: true })).toBeNull();
    expect(key("e", { altKey: true })).toBeNull();
    expect(key("j", { isComposing: true })).toBeNull();
  });
});
