import { describe, expect, it } from "vitest";
import {
  buildPrintDocument,
  escapeHtml,
  type PrintableMessage,
} from "@/lib/print-message";

const message = (input: Partial<PrintableMessage> = {}): PrintableMessage => ({
  subject: "見積もりの件",
  from: [{ name: "山田 太郎", address: "taro@example.com" }],
  to: [{ address: "hanako@example.com" }],
  cc: [],
  date: "2026年11月27日 (金) 9:00",
  bodyHtml: null,
  bodyText: "よろしくお願いします。",
  attachments: [],
  ...input,
});

describe("buildPrintDocument", () => {
  it("件名、差出人、宛先、日時、本文を並べる", () => {
    const html = buildPrintDocument([message()]);
    expect(html).toContain("<title>見積もりの件</title>");
    expect(html).toContain("山田 太郎 &lt;taro@example.com&gt;");
    expect(html).toContain("hanako@example.com");
    expect(html).toContain("2026年11月27日 (金) 9:00");
    expect(html).toContain("よろしくお願いします。");
    // 空の欄 (Cc、添付) は出さない。
    expect(html).not.toContain("<th>Cc</th>");
    expect(html).not.toContain("<th>添付</th>");
  });

  it("テキストの本文と件名は HTML として解釈させない", () => {
    const html = buildPrintDocument([
      message({
        subject: "<b>件名</b>",
        bodyText: "<script>alert(1)</script>",
      }),
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;件名&lt;/b&gt;");
  });

  it("HTML の本文はそのまま入れ、CSP でスクリプトと外部の読み込みを止める", () => {
    const html = buildPrintDocument([message({ bodyHtml: "<p>本文</p>" })]);
    expect(html).toContain("<p>本文</p>");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('img-src data:"');
    expect(
      buildPrintDocument([message()], { allowRemoteImages: true }),
    ).toContain("img-src data: https:");
  });

  it("会話のメールを順に並べ、添付ファイルの名前も出す", () => {
    const html = buildPrintDocument([
      message({ bodyText: "1 通目" }),
      message({ bodyText: "2 通目", attachments: ["a.pdf", "b.png"] }),
    ]);
    expect(html.indexOf("1 通目")).toBeLessThan(html.indexOf("2 通目"));
    expect(html).toContain("<th>添付</th><td>a.pdf, b.png</td>");
  });

  it("件名が無ければ (件名なし) にする", () => {
    expect(buildPrintDocument([message({ subject: "" })])).toContain(
      "<title>(件名なし)</title>",
    );
  });
});

describe("escapeHtml", () => {
  it("記号を置き換える", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });
});
