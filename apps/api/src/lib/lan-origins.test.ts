import { describe, expect, it } from "vitest";
import { lanOrigins } from "./lan-origins.js";

const interfaces = {
  lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  eth0: [
    { address: "192.168.1.20", family: "IPv4", internal: false },
    { address: "fe80::1", family: "IPv6", internal: false },
  ],
};

describe("lanOrigins", () => {
  it("localhost のオリジンを、この PC の名前と IP アドレスに置き換える", () => {
    expect(lanOrigins(["http://localhost:3000"], "Desk", interfaces)).toEqual([
      "http://desk:3000",
      "http://desk.local:3000",
      "http://192.168.1.20:3000",
    ]);
  });

  it("localhost 以外のオリジン (本番のドメインなど) からは何も足さない", () => {
    expect(
      lanOrigins(["https://mail.example.com"], "desk", interfaces),
    ).toEqual([]);
  });

  it("設定済みのオリジンは重ねて返さない", () => {
    expect(
      lanOrigins(
        ["http://localhost:3000", "http://192.168.1.20:3000"],
        "",
        interfaces,
      ),
    ).toEqual([]);
  });
});
