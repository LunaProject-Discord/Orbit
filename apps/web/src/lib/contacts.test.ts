import { describe, expect, it } from "vitest";
import type { Contact } from "@/lib/api";
import { matchStrength, rankContacts } from "@/lib/contacts";

const contact = (address: string, name: string | null = null): Contact => ({
  address,
  name,
  sentCount: 0,
  receivedCount: 0,
  lastAt: null,
  score: 0,
});

// サーバーの並び (よくやり取りする順)。
const contacts = [
  contact("support@example.com", "サポート窓口"),
  contact("taro.yamada@example.jp", "山田 太郎"),
  contact("hanako@example.net", "Hanako Sato"),
  contact("ataro@example.org"),
];

describe("matchStrength", () => {
  it("先頭・語の先頭・途中で強さが変わる", () => {
    expect(matchStrength(contacts[1] as Contact, "taro")).toBe(3);
    expect(matchStrength(contacts[1] as Contact, "yamada")).toBe(2);
    expect(matchStrength(contacts[1] as Contact, "太郎")).toBe(2);
    expect(matchStrength(contacts[1] as Contact, "amad")).toBe(1);
    expect(matchStrength(contacts[1] as Contact, "suzuki")).toBe(0);
  });

  it("全角・大文字の違いは区別しない", () => {
    expect(matchStrength(contacts[2] as Contact, "ＳＡＴＯ")).toBe(2);
  });

  it("空白で区切った語は、すべて合う必要がある", () => {
    expect(matchStrength(contacts[2] as Contact, "hanako sato")).toBe(2);
    expect(matchStrength(contacts[2] as Contact, "hanako suzuki")).toBe(0);
  });
});

describe("rankContacts", () => {
  it("語の先頭から合うものを、よくやり取りする順に前へ出す", () => {
    expect(
      rankContacts(contacts, "taro").map((entry) => entry.address),
    ).toEqual(["taro.yamada@example.jp", "ataro@example.org"]);
  });

  it("選び済みのアドレスと、空の入力は除く", () => {
    expect(
      rankContacts(contacts, "example", {
        exclude: ["SUPPORT@example.com"],
      }).map((entry) => entry.address),
    ).toEqual([
      "taro.yamada@example.jp",
      "hanako@example.net",
      "ataro@example.org",
    ]);
    expect(rankContacts(contacts, "  ")).toEqual([]);
  });

  it("件数を絞れる", () => {
    expect(rankContacts(contacts, "example", { limit: 2 })).toHaveLength(2);
  });
});
