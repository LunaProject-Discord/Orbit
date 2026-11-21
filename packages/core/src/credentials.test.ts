import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptCredentials,
  encryptCredentials,
  loadEncryptionKey,
} from "./credentials.js";

const key = randomBytes(32);
const credentials = { type: "password", password: "ひみつ pass:word" } as const;

describe("credentials", () => {
  it("暗号化した認証情報を復号できる", () => {
    const encrypted = encryptCredentials(credentials, key, "user-1");
    expect(encrypted).not.toContain("pass:word");
    expect(decryptCredentials(encrypted, key, "user-1")).toEqual(credentials);
  });

  it("同じ内容でも毎回違う暗号文になる", () => {
    expect(encryptCredentials(credentials, key, "user-1")).not.toBe(
      encryptCredentials(credentials, key, "user-1"),
    );
  });

  it("別の利用者の行に付け替えると復号できない", () => {
    const encrypted = encryptCredentials(credentials, key, "user-1");
    expect(() => decryptCredentials(encrypted, key, "user-2")).toThrow();
  });

  it("鍵が違う、または改ざんされていると復号できない", () => {
    const encrypted = encryptCredentials(credentials, key, "user-1");
    expect(() =>
      decryptCredentials(encrypted, randomBytes(32), "user-1"),
    ).toThrow();
    const parts = encrypted.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptCredentials(parts.join(":"), key, "user-1")).toThrow();
  });

  it("鍵の長さを検証する", () => {
    expect(() => loadEncryptionKey(undefined)).toThrow();
    expect(() => loadEncryptionKey("c2hvcnQ=")).toThrow();
    expect(loadEncryptionKey(key.toString("base64"))).toEqual(key);
  });
});
