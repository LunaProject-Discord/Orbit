import { describe, expect, it } from "vitest";
import {
  createConsoleMailer,
  loadSystemMailConfig,
  renderSystemMail,
} from "./system-mail.js";

describe("loadSystemMailConfig", () => {
  it("SYSTEM_MAIL_HOST が無ければ null", () => {
    expect(loadSystemMailConfig({})).toBe(null);
    expect(loadSystemMailConfig({ SYSTEM_MAIL_HOST: " " })).toBe(null);
  });

  it("既定は 587 番の STARTTLS", () => {
    expect(
      loadSystemMailConfig({
        SYSTEM_MAIL_HOST: "smtp.example.com",
        SYSTEM_MAIL_FROM: "Orbit <no-reply@example.com>",
        SYSTEM_MAIL_USER: "user",
        SYSTEM_MAIL_PASSWORD: "secret",
      }),
    ).toEqual({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "user",
      password: "secret",
      from: "Orbit <no-reply@example.com>",
    });
  });

  it("465 番は最初から TLS。SYSTEM_MAIL_SECURE で上書きできる", () => {
    const base = {
      SYSTEM_MAIL_HOST: "smtp.example.com",
      SYSTEM_MAIL_FROM: "no-reply@example.com",
    };
    expect(
      loadSystemMailConfig({ ...base, SYSTEM_MAIL_PORT: "465" })?.secure,
    ).toBe(true);
    expect(
      loadSystemMailConfig({
        ...base,
        SYSTEM_MAIL_PORT: "2465",
        SYSTEM_MAIL_SECURE: "true",
      })?.secure,
    ).toBe(true);
  });

  it("書きかけの設定は起動時に止める", () => {
    expect(() =>
      loadSystemMailConfig({ SYSTEM_MAIL_HOST: "smtp.example.com" }),
    ).toThrow(/SYSTEM_MAIL_FROM/);
    expect(() =>
      loadSystemMailConfig({
        SYSTEM_MAIL_HOST: "smtp.example.com",
        SYSTEM_MAIL_FROM: "a@example.com",
        SYSTEM_MAIL_USER: "user",
      }),
    ).toThrow(/SYSTEM_MAIL_PASSWORD/);
    expect(() =>
      loadSystemMailConfig({
        SYSTEM_MAIL_HOST: "smtp.example.com",
        SYSTEM_MAIL_FROM: "a@example.com",
        SYSTEM_MAIL_PORT: "abc",
      }),
    ).toThrow(/SYSTEM_MAIL_PORT/);
  });
});

describe("renderSystemMail", () => {
  const mail = {
    to: "a@example.com",
    subject: "件名",
    lines: ["<b>あおい</b> さん", "本文です。"],
    action: { label: "開く", url: "https://example.com/?a=1&b=2" },
    footer: ["有効期限は 1 時間です。"],
  };

  it("テキストにはリンクをそのまま書く", () => {
    const { text } = renderSystemMail(mail);
    expect(text).toContain("https://example.com/?a=1&b=2");
    expect(text).toContain("有効期限は 1 時間です。");
  });

  it("HTML では、名前などに含まれる記号を無害にする", () => {
    const { html } = renderSystemMail(mail);
    expect(html).toContain("&lt;b&gt;あおい&lt;/b&gt; さん");
    expect(html).not.toContain("<b>あおい</b>");
    expect(html).toContain('href="https://example.com/?a=1&amp;b=2"');
  });
});

describe("createConsoleMailer", () => {
  it("送らずに、宛先と本文をログへ出す", async () => {
    const logs: string[] = [];
    await createConsoleMailer((message) => logs.push(message)).send({
      to: "a@example.com",
      subject: "件名",
      lines: ["本文"],
      action: { label: "開く", url: "https://example.com/x" },
    });
    expect(logs.join("\n")).toContain("宛先: a@example.com");
    expect(logs.join("\n")).toContain("https://example.com/x");
  });
});
