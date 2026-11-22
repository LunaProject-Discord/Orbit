import { describe, expect, it } from "vitest";
import { isTemporaryLoginRefusal } from "./login-refusal.js";

describe("isTemporaryLoginRefusal", () => {
  it("同時接続数の上限は、一時的なものとして扱う", () => {
    expect(
      isTemporaryLoginRefusal({
        serverResponseCode: "UNAVAILABLE",
        responseText:
          "Maximum number of connections from user+IP exceeded (mail_max_userip_connections=10)",
      }),
    ).toBe(true);
    expect(
      isTemporaryLoginRefusal({
        serverResponseCode: "ALERT",
        responseText: "Too many simultaneous connections. (Failure)",
      }),
    ).toBe(true);
    expect(isTemporaryLoginRefusal({ serverResponseCode: "LIMIT" })).toBe(true);
    expect(
      isTemporaryLoginRefusal({
        responseText: "Temporary authentication failure.",
      }),
    ).toBe(true);
  });

  it("パスワードの誤りは、一時的なものとして扱わない", () => {
    expect(
      isTemporaryLoginRefusal({
        serverResponseCode: "AUTHENTICATIONFAILED",
        responseText: "Authentication failed.",
      }),
    ).toBe(false);
    expect(
      isTemporaryLoginRefusal({
        serverResponseCode: "AUTHENTICATIONFAILED",
        responseText: "Invalid credentials, try again later",
      }),
    ).toBe(false);
    expect(
      isTemporaryLoginRefusal({
        responseText: "Invalid credentials (Failure)",
      }),
    ).toBe(false);
    expect(isTemporaryLoginRefusal({ message: "Command failed" })).toBe(false);
  });
});
