import { describe, expect, it } from "vitest";
import { isPrivateAddress } from "./host-check.js";

describe("isPrivateAddress", () => {
  it("内部向けのアドレスを判定する", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("外部のアドレスは通す", () => {
    for (const address of ["8.8.8.8", "172.32.0.1", "2001:4860:4860::8888"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});
