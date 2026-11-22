import { describe, expect, it } from "vitest";
import { resolveApiUrl } from "./api-url";

describe("resolveApiUrl", () => {
  it("localhost で開いたときは、設定のまま", () => {
    expect(
      resolveApiUrl("http://localhost:8787/", {
        protocol: "http:",
        hostname: "localhost",
      }),
    ).toBe("http://localhost:8787");
  });

  it("LAN の IP アドレスで開いたときは、同じ機器の API へ向ける", () => {
    expect(
      resolveApiUrl("http://localhost:8787", {
        protocol: "http:",
        hostname: "192.168.1.20",
      }),
    ).toBe("http://192.168.1.20:8787");
  });

  it("設定が localhost 以外 (本番など) なら、そのまま", () => {
    expect(
      resolveApiUrl("https://mail.example.com", {
        protocol: "http:",
        hostname: "192.168.1.20",
      }),
    ).toBe("https://mail.example.com");
  });

  it("Tauri や Capacitor、画面の無い環境では、設定のまま", () => {
    expect(
      resolveApiUrl("http://localhost:8787", {
        protocol: "https:",
        hostname: "tauri.localhost",
      }),
    ).toBe("http://localhost:8787");
    expect(
      resolveApiUrl("http://localhost:8787", {
        protocol: "capacitor:",
        hostname: "localhost",
      }),
    ).toBe("http://localhost:8787");
    expect(resolveApiUrl("http://localhost:8787", null)).toBe(
      "http://localhost:8787",
    );
  });
});
