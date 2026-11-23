// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { patchCidReferences } from "@/lib/attachments";

describe("patchCidReferences", () => {
  const build = () => {
    const doc = document.implementation.createHTMLDocument("");
    doc.head.innerHTML = "<style>.bg{background:url(cid:bg)}</style>";
    doc.body.innerHTML =
      '<img id="logo" src="cid:logo@example.com">' +
      '<img id="photo" src="cid:photo%201">' +
      '<div id="cell" style="background:url(\'cid:bg\')">cid:logo@example.com と書いた文字</div>';
    return doc;
  };

  it("表示中の文書の cid: を、取得済みの画像の URL に置き換える", () => {
    const doc = build();
    const changed = patchCidReferences(
      doc,
      new Map([
        ["logo@example.com", "data:image/png;base64,AAAA"],
        ["bg", "data:image/gif;base64,BBBB"],
      ]),
    );
    expect(changed).toBe(true);
    expect(doc.getElementById("logo")?.getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(doc.getElementById("cell")?.getAttribute("style")).toContain(
      "url('data:image/gif;base64,BBBB')",
    );
    expect(doc.querySelector("style")?.textContent).toContain(
      "url(data:image/gif;base64,BBBB)",
    );
    // 取得していない画像と、本文の文字はそのまま。
    expect(doc.getElementById("photo")?.getAttribute("src")).toBe(
      "cid:photo%201",
    );
    expect(doc.getElementById("cell")?.textContent).toContain(
      "cid:logo@example.com",
    );
  });

  it("置き換えるものが無ければ false を返す", () => {
    const doc = build();
    expect(patchCidReferences(doc, new Map())).toBe(false);
    expect(
      patchCidReferences(doc, new Map([["other", "data:image/png;base64,C"]])),
    ).toBe(false);
  });
});
