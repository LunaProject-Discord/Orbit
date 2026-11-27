import { describe, expect, it } from "vitest";
import { WEB_FONTS } from "@/lib/web-fonts";
import { buildSrcDoc } from "./message-view";

const serif = WEB_FONTS.find((font) => font.family === "Noto Serif JP");

describe("buildSrcDoc の Web フォント", () => {
  it("Web フォントのスタイルシートを入れ、CSP で読み込みを許す", () => {
    const url = serif?.stylesheets[0] ?? "";
    const doc = buildSrcDoc("<p>本文</p>", false, undefined, "", "", [url]);
    expect(doc).toContain(
      `<link rel="stylesheet" href="${url.replaceAll("&", "&amp;")}">`,
    );
    expect(doc).toContain(
      "style-src 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net;",
    );
    expect(doc).toContain(
      "font-src https://fonts.gstatic.com https://cdn.jsdelivr.net",
    );
  });

  it("決まったもの以外のスタイルシートは入れない", () => {
    const doc = buildSrcDoc("<p>本文</p>", false, undefined, "", "", [
      "https://example.com/evil.css",
    ]);
    expect(doc).not.toContain("example.com");
    expect(doc).toContain("style-src 'unsafe-inline'; img-src data:");
    expect(doc).not.toContain("font-src");
  });
});
