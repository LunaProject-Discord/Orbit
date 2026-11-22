// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiUrl,
  checkServer,
  chosenServerUrl,
  hasServerUrl,
  isBundledApp,
  normalizeServerUrl,
  setServerUrl,
} from "./server-url";

type TestWindow = {
  Capacitor?: { isNativePlatform: () => boolean };
  __TAURI_INTERNALS__?: unknown;
};
const w = window as unknown as TestWindow;

afterEach(() => {
  delete w.Capacitor;
  delete w.__TAURI_INTERNALS__;
  window.localStorage.clear();
  vi.unstubAllEnvs();
});

describe("normalizeServerUrl", () => {
  it("スキームが無ければ https を補い、末尾の / とパスを落とす", () => {
    expect(normalizeServerUrl("mail.example.com")).toBe(
      "https://mail.example.com",
    );
    expect(normalizeServerUrl(" https://mail.example.com/login?x=1 ")).toBe(
      "https://mail.example.com",
    );
    expect(normalizeServerUrl("http://192.168.1.10:8787/")).toBe(
      "http://192.168.1.10:8787",
    );
  });

  it("使えない形は null", () => {
    expect(normalizeServerUrl("")).toBeNull();
    expect(normalizeServerUrl("ftp://mail.example.com")).toBeNull();
    expect(normalizeServerUrl("https://user:pass@mail.example.com")).toBeNull();
    expect(normalizeServerUrl("https://")).toBeNull();
    expect(normalizeServerUrl("mail example")).toBeNull();
  });
});

describe("接続先の選択", () => {
  it("Web では保存した値を使わない", () => {
    setServerUrl("https://other.example.com");
    expect(isBundledApp()).toBe(false);
    expect(chosenServerUrl()).toBeNull();
    expect(hasServerUrl()).toBe(true);
    expect(apiUrl()).not.toBe("https://other.example.com");
  });

  it("Capacitor では保存した値を使う", () => {
    w.Capacitor = { isNativePlatform: () => true };
    expect(isBundledApp()).toBe(true);
    setServerUrl("https://mail.example.com");
    expect(hasServerUrl()).toBe(true);
    expect(apiUrl()).toBe("https://mail.example.com");
    setServerUrl(null);
    expect(chosenServerUrl()).toBeNull();
  });

  it("Tauri も同梱アプリとして扱う", () => {
    w.__TAURI_INTERNALS__ = {};
    expect(isBundledApp()).toBe(true);
  });

  it("ブラウザーで読み込まれた Capacitor (Web 版) は同梱アプリではない", () => {
    w.Capacitor = { isNativePlatform: () => false };
    expect(isBundledApp()).toBe(false);
  });
});

describe("checkServer", () => {
  const respond = (status: number, body: unknown) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
      })) as unknown as typeof fetch;

  it("このアプリのサーバーなら ok", async () => {
    const fetcher = vi.fn(respond(200, { name: "mail-api", version: 1 }));
    expect(await checkServer("https://mail.example.com", fetcher)).toEqual({
      ok: true,
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://mail.example.com/v1");
  });

  it("別のサーバーなら not_mail_server", async () => {
    expect(
      await checkServer("https://example.com", respond(200, { hello: 1 })),
    ).toEqual({ ok: false, reason: "not_mail_server" });
    expect(
      await checkServer("https://example.com", respond(404, null)),
    ).toEqual({ ok: false, reason: "not_mail_server" });
  });

  it("届かなければ unreachable", async () => {
    const fetcher = (async () => {
      throw new TypeError("failed");
    }) as unknown as typeof fetch;
    expect(await checkServer("https://nowhere.example", fetcher)).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });
});
