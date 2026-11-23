import { describe, expect, it } from "vitest";
import { planAccountChannels } from "./push";

const accounts = [
  { id: "a1", email: "work@example.com", displayName: "仕事用" },
  { id: "a2", email: "home@example.com", displayName: null },
];

describe("planAccountChannels", () => {
  it("アカウントごとに分類を作る (名前は表示名、無ければメールアドレス)", () => {
    expect(planAccountChannels(accounts, [])).toEqual({
      create: [
        { id: "new-mail-a1", name: "仕事用" },
        { id: "new-mail-a2", name: "home@example.com" },
      ],
      remove: [],
    });
  });

  it("名前が変わったものだけ作り直し、無くなったアカウントの分は消す", () => {
    expect(
      planAccountChannels(accounts, [
        { id: "new-mail", name: "新着メール" },
        { id: "new-mail-a1", name: "仕事" },
        { id: "new-mail-a2", name: "home@example.com" },
        { id: "new-mail-gone", name: "old@example.com" },
      ]),
    ).toEqual({
      create: [{ id: "new-mail-a1", name: "仕事用" }],
      remove: ["new-mail-gone"],
    });
  });
});
