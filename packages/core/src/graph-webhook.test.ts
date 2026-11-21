import { describe, expect, it } from "vitest";
import {
  graphClientState,
  graphWebhookBaseUrl,
  verifyGraphClientState,
} from "./graph-webhook.js";

describe("graphWebhookBaseUrl", () => {
  it("公開された HTTPS の URL のときだけ、通知の受け口を返す", () => {
    expect(graphWebhookBaseUrl("https://api.example.com")).toBe(
      "https://api.example.com/v1/webhooks/microsoft",
    );
    expect(graphWebhookBaseUrl("https://example.com/mail/")).toBe(
      "https://example.com/mail/v1/webhooks/microsoft",
    );
  });

  it("HTTP、localhost、IP アドレス、不正な値では null を返す", () => {
    for (const url of [
      undefined,
      "",
      "not a url",
      "http://api.example.com",
      "http://localhost:8787",
      "https://localhost:8787",
      "https://192.168.1.10",
    ]) {
      expect(graphWebhookBaseUrl(url)).toBeNull();
    }
  });
});

describe("graphClientState", () => {
  const key = Buffer.alloc(32, 7);

  it("アカウントごとに違う値になり、照合できる", () => {
    const state = graphClientState(key, "account-1");
    expect(state).toHaveLength(64);
    expect(state).not.toBe(graphClientState(key, "account-2"));
    expect(verifyGraphClientState(key, "account-1", state)).toBe(true);
  });

  it("違う値や文字列でない値は通さない", () => {
    const state = graphClientState(key, "account-1");
    expect(verifyGraphClientState(key, "account-2", state)).toBe(false);
    expect(verifyGraphClientState(key, "account-1", `${state}x`)).toBe(false);
    expect(verifyGraphClientState(key, "account-1", undefined)).toBe(false);
    expect(
      verifyGraphClientState(Buffer.alloc(32, 8), "account-1", state),
    ).toBe(false);
  });
});
