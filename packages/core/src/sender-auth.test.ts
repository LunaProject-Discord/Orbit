import { describe, expect, it } from "vitest";
import {
  checkSender,
  displayNameMismatch,
  organizationalDomain,
  parseAuthenticationResults,
} from "./sender-auth.js";

describe("parseAuthenticationResults", () => {
  it("Gmail の形を読む (コメントと引用符を含む)", () => {
    const value =
      'mx.google.com; dkim=pass header.i=@example.com header.s=s1 header.b="ab;c"; spf=softfail (google.com: domain of transitioning x@example.org does not designate 192.0.2.1 as permitted sender) smtp.mailfrom=x@example.org; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.com';
    expect(parseAuthenticationResults(value)).toEqual({
      authservId: "mx.google.com",
      spf: { result: "softfail", domain: "example.org" },
      dkim: [{ result: "pass", domain: "example.com" }],
      dmarc: { result: "pass", domain: "example.com" },
      compauth: null,
    });
  });

  it("判定したサーバーを省いた Microsoft の形を読む", () => {
    const value =
      "spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=example.com; dkim=pass (signature was verified) header.d=example.com;dmarc=pass action=none header.from=example.com;compauth=pass reason=100";
    expect(parseAuthenticationResults(value)).toEqual({
      authservId: "",
      spf: { result: "pass", domain: "example.com" },
      dkim: [{ result: "pass", domain: "example.com" }],
      dmarc: { result: "pass", domain: "example.com" },
      compauth: { result: "pass", domain: null },
    });
  });

  it("DKIM の署名が複数あれば、すべて読む", () => {
    const result = parseAuthenticationResults(
      "mx.example; dkim=pass header.d=example.com; dkim=fail header.d=esp.example; dkim/1=neutral header.i=@x.example",
    );
    expect(result?.dkim).toEqual([
      { result: "pass", domain: "example.com" },
      { result: "fail", domain: "esp.example" },
      { result: "neutral", domain: "x.example" },
    ]);
  });

  it("結果の無いものや空は null か空の結果", () => {
    expect(parseAuthenticationResults(undefined)).toBeNull();
    expect(parseAuthenticationResults("")).toBeNull();
    expect(parseAuthenticationResults("mx.example; none")).toEqual({
      authservId: "mx.example",
      spf: null,
      dkim: [],
      dmarc: null,
      compauth: null,
    });
  });
});

describe("organizationalDomain", () => {
  it("公開サフィックスを考えて組織のドメインにする", () => {
    expect(organizationalDomain("mail.example.co.jp")).toBe("example.co.jp");
    expect(organizationalDomain("a.b.example.com")).toBe("example.com");
    expect(organizationalDomain("example.com")).toBe("example.com");
  });
});

describe("displayNameMismatch", () => {
  it("会社名を名乗っているのに別のドメインなら、その名前を返す", () => {
    expect(
      displayNameMismatch("Amazon.co.jp", "info@amaz0n-secure.example"),
    ).toBe("amazon.co.jp");
    expect(displayNameMismatch("Amazon", "info@amaz0n-secure.example")).toBe(
      "Amazon",
    );
    expect(displayNameMismatch("楽天カード", "card@rakuten-info.example")).toBe(
      "楽天",
    );
    expect(
      displayNameMismatch("ＡＰＰＬＥ サポート", "x@support.example"),
    ).toBe("Apple");
  });

  it("本物のドメイン (サブドメインを含む) なら食い違いにしない", () => {
    expect(
      displayNameMismatch("Amazon.co.jp", "store-news@amazon.co.jp"),
    ).toBeNull();
    expect(
      displayNameMismatch("楽天市場", "info@emagazine.rakuten.co.jp"),
    ).toBeNull();
    expect(displayNameMismatch("GitHub", "noreply@github.com")).toBeNull();
  });

  it("英字の名前は単語として一致したときだけ当てはめる", () => {
    expect(
      displayNameMismatch("Pineapple Studio", "a@pine.example"),
    ).toBeNull();
    expect(displayNameMismatch("佐藤 美咲", "misaki@example.com")).toBeNull();
  });

  it("表示名の中のアドレスが別のドメインなら食い違い", () => {
    expect(displayNameMismatch("support@bank.example", "x@phish.example")).toBe(
      "support@bank.example",
    );
    expect(
      displayNameMismatch("support@example.com", "support@mail.example.com"),
    ).toBeNull();
    // ドメインとして成り立たないもの (Next.js など) は比べない。
    expect(
      displayNameMismatch("Next.js Weekly", "news@weekly.example"),
    ).toBeNull();
  });
});

describe("checkSender", () => {
  const from = { name: "Example", address: "news@example.com" };

  it("DMARC に合格し、ドメインが一致すれば確認済み", () => {
    const auth = parseAuthenticationResults(
      "mx.example; dmarc=pass header.from=example.com",
    );
    expect(checkSender(from, auth)).toEqual({
      verified: true,
      warnings: [],
      claimed: null,
    });
  });

  it("合格したドメインが差出人と違えば、確認済みにしない", () => {
    const auth = parseAuthenticationResults(
      "mx.example; dmarc=pass header.from=other.example",
    );
    expect(checkSender(from, auth).verified).toBe(false);
  });

  it("DMARC に不合格なら警告", () => {
    const auth = parseAuthenticationResults(
      "mx.example; dmarc=fail header.from=example.com",
    );
    expect(checkSender(from, auth).warnings).toEqual(["dmarc_fail"]);
  });

  it("DMARC が無く、SPF に失敗し DKIM にも合格していなければ警告", () => {
    expect(
      checkSender(
        from,
        parseAuthenticationResults(
          "mx.example; spf=fail smtp.mailfrom=example.com",
        ),
      ).warnings,
    ).toEqual(["auth_fail"]);
    expect(
      checkSender(
        from,
        parseAuthenticationResults(
          "mx.example; spf=fail smtp.mailfrom=example.com; dkim=pass header.d=example.com",
        ),
      ).warnings,
    ).toEqual([]);
  });

  it("認証結果が無くても、表示名の食い違いは調べる", () => {
    expect(
      checkSender({ name: "PayPal", address: "service@pay-pal.example" }, null),
    ).toEqual({
      verified: false,
      warnings: ["name_mismatch"],
      claimed: "PayPal",
    });
  });
});
