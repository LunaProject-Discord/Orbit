// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  externalLinkOf,
  externalUrl,
  interceptExternalLinks,
} from "./external-links";

const APP = "https://localhost";

describe("externalUrl", () => {
  it("ほかのサイトとメールアドレスは外で開く", () => {
    expect(externalUrl("https://example.com/a?b=1#c", APP)).toBe(
      "https://example.com/a?b=1#c",
    );
    expect(externalUrl("http://example.com/", APP)).toBe("http://example.com/");
    expect(externalUrl("mailto:someone@example.com", APP)).toBe(
      "mailto:someone@example.com",
    );
  });

  it("このアプリの画面と、ほかの種類の URL は対象にしない", () => {
    expect(externalUrl("https://localhost/settings", APP)).toBeNull();
    expect(externalUrl("about:srcdoc#top", APP)).toBeNull();
    expect(externalUrl("javascript:alert(1)", APP)).toBeNull();
    expect(externalUrl("file:///etc/passwd", APP)).toBeNull();
    expect(externalUrl("壊れた URL", APP)).toBeNull();
  });
});

describe("interceptExternalLinks", () => {
  const setup = (html: string) => {
    document.body.innerHTML = html;
    const open = vi.fn();
    const stop = interceptExternalLinks(document, open, APP);
    return { open, stop };
  };

  it("リンクの中の要素を押しても、外部の URL を開く", () => {
    const { open, stop } = setup(
      '<a href="https://example.com/x"><b id="inner">開く</b></a>',
    );
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    document.getElementById("inner")?.dispatchEvent(event);
    expect(open).toHaveBeenCalledWith("https://example.com/x");
    expect(event.defaultPrevented).toBe(true);
    stop();
  });

  it("アプリの中のリンクと、リンクでない場所はそのままにする", () => {
    const { open, stop } = setup(
      '<a id="app" href="https://localhost/settings">設定</a><p id="text">本文</p>',
    );
    for (const id of ["app", "text"]) {
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      document.getElementById(id)?.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(open).not.toHaveBeenCalled();
    stop();
  });

  it("解除した後は受け取らない", () => {
    const { open, stop } = setup('<a id="a" href="https://example.com/">x</a>');
    stop();
    document
      .getElementById("a")
      ?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    expect(open).not.toHaveBeenCalled();
  });
});

describe("externalLinkOf", () => {
  it("要素でないものは無視する", () => {
    expect(externalLinkOf(null, APP)).toBeNull();
    expect(externalLinkOf(window, APP)).toBeNull();
  });
});
