import { describe, expect, it } from "vitest";
import { formatBackupCode, stripCodeSeparators } from "./one-time-code-input";

describe("stripCodeSeparators", () => {
  it("貼り付けた空白やハイフンを除く", () => {
    expect(stripCodeSeparators("123 456")).toBe("123456");
    expect(stripCodeSeparators(" aB3dE-fG7hJ\n")).toBe("aB3dEfG7hJ");
  });
});

describe("formatBackupCode", () => {
  it("5 文字ごとにハイフンを入れ、大文字と小文字はそのまま", () => {
    expect(formatBackupCode("aB3dEfG7hJ")).toBe("aB3dE-fG7hJ");
    expect(formatBackupCode("aB3dE-fG7hJ")).toBe("aB3dE-fG7hJ");
  });

  it("5 文字以下ならハイフンを入れない", () => {
    expect(formatBackupCode("abc")).toBe("abc");
  });
});
