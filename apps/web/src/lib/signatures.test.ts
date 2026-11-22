import { describe, expect, it } from "vitest";
import type { SignatureRule } from "@/lib/api";
import { resolveSignature } from "@/lib/signatures";

const rule = (
  kind: SignatureRule["kind"],
  key: string,
  signatureHtml: string | null,
  accountId: string | null = null,
): SignatureRule => ({
  id: `${kind}:${accountId ?? ""}:${key}`,
  kind,
  accountId,
  key,
  label: null,
  signatureHtml,
  updatedAt: "2026-11-22T00:00:00.000Z",
});

const ACCOUNT = "<div>アカウントの署名</div>";
const base = {
  accountId: "acc1",
  accountSignature: ACCOUNT,
  to: [] as { address: string }[],
};

describe("resolveSignature", () => {
  it("決まりが無ければ、アカウントの署名を使う", () => {
    expect(
      resolveSignature({
        ...base,
        rules: [],
        to: [{ address: "a@example.com" }],
      }),
    ).toEqual({ html: ACCOUNT, source: "account" });
  });

  it("宛先に連絡先の署名があれば使う (大文字と小文字は区別しない)", () => {
    expect(
      resolveSignature({
        ...base,
        rules: [rule("contact", "a@example.com", "<div>A 向け</div>")],
        to: [{ address: "A@Example.com" }],
      }),
    ).toEqual({ html: "<div>A 向け</div>", source: "contact" });
  });

  it("連絡先に「署名を付けない」を決めてあれば、署名なしになる", () => {
    expect(
      resolveSignature({
        ...base,
        rules: [rule("contact", "a@example.com", null)],
        to: [{ address: "a@example.com" }],
      }),
    ).toEqual({ html: null, source: "contact" });
  });

  it("宛先に決めていない相手が混ざるときは、アカウントの署名を使う", () => {
    expect(
      resolveSignature({
        ...base,
        rules: [rule("contact", "a@example.com", "<div>A 向け</div>")],
        to: [{ address: "a@example.com" }, { address: "b@example.com" }],
      }).source,
    ).toBe("account");
  });

  it("宛先の全員が同じ署名なら使い、違う署名が混ざるならアカウントの署名を使う", () => {
    const to = [{ address: "a@example.com" }, { address: "b@example.com" }];
    expect(
      resolveSignature({
        ...base,
        rules: [
          rule("contact", "a@example.com", "<div>社内</div>"),
          rule("contact", "b@example.com", "<div>社内</div>"),
        ],
        to,
      }),
    ).toEqual({ html: "<div>社内</div>", source: "contact" });
    expect(
      resolveSignature({
        ...base,
        rules: [
          rule("contact", "a@example.com", "<div>社内</div>"),
          rule("contact", "b@example.com", "<div>社外</div>"),
        ],
        to,
      }).source,
    ).toBe("account");
  });

  it("会話の署名は、連絡先の署名より優先する", () => {
    const rules = [
      rule("contact", "a@example.com", "<div>A 向け</div>"),
      rule("thread", "t1", "<div>この会話</div>", "acc1"),
    ];
    expect(
      resolveSignature({
        ...base,
        rules,
        threadKey: "t1",
        to: [{ address: "a@example.com" }],
      }),
    ).toEqual({ html: "<div>この会話</div>", source: "thread" });
    // 別の会話や、別のアカウントの同じキーには効かない。
    expect(
      resolveSignature({
        ...base,
        rules,
        threadKey: "t2",
        to: [{ address: "a@example.com" }],
      }).source,
    ).toBe("contact");
    expect(
      resolveSignature({ ...base, accountId: "acc2", rules, threadKey: "t1" })
        .source,
    ).toBe("account");
  });
});
