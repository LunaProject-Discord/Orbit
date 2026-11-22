import { describe, expect, it } from "vitest";
import { unsubscribeLinks } from "./unsubscribe";

describe("unsubscribeLinks", () => {
  it("https はホスト名、mailto は宛先を名前に出す", () => {
    expect(
      unsubscribeLinks([
        "https://news.example.com/unsubscribe?id=1",
        "mailto:stop%2Bnews@example.com?subject=unsubscribe",
      ]),
    ).toEqual([
      {
        href: "https://news.example.com/unsubscribe?id=1",
        label: "ページを開く (news.example.com)",
      },
      {
        href: "mailto:stop%2Bnews@example.com?subject=unsubscribe",
        label: "メールで依頼 (stop+news@example.com)",
      },
    ]);
  });

  it("https と mailto 以外、URL でないものは出さない", () => {
    expect(
      unsubscribeLinks(["javascript:alert(1)", "http://example.com", "x"]),
    ).toEqual([]);
  });
});
