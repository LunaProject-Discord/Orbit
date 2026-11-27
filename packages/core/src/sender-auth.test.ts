import { describe, expect, it } from "vitest";
import {
  type AuthTrust,
  checkSender,
  displayNameMismatch,
  isCurrentSenderCheck,
  isTrustedAuthservId,
  organizationalDomain,
  parseAuthenticationResults,
  SENDER_CHECK_VERSION,
  selectAuthResults,
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
      version: SENDER_CHECK_VERSION,
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
      version: SENDER_CHECK_VERSION,
    });
  });

  it("DMARC の合格に header.from が無ければ、確認済みにしない", () => {
    const auth = parseAuthenticationResults("mx.google.com; dmarc=pass");
    expect(checkSender(from, auth).verified).toBe(false);
  });

  it("版の無い (古い決まりで作った) 結果は、いまの結果として使わない", () => {
    expect(isCurrentSenderCheck(checkSender(from, null))).toBe(true);
    expect(
      isCurrentSenderCheck({ verified: true, warnings: [], claimed: null }),
    ).toBe(false);
    expect(isCurrentSenderCheck(null)).toBe(false);
  });
});

describe("信頼する判定サーバー", () => {
  const gmail: AuthTrust = { provider: "gmail", host: "imap.gmail.com" };
  const microsoft: AuthTrust = { provider: "microsoft", host: null };
  const icloud: AuthTrust = { provider: "icloud", host: "imap.mail.me.com" };
  const generic: AuthTrust = { provider: "generic", host: "imap.example.net" };
  const from = { address: "suzuki@example.com" };
  const pass =
    "dkim=pass header.d=example.com; dmarc=pass header.from=example.com";

  it("アカウントごとに信頼する名前", () => {
    expect(isTrustedAuthservId(gmail, "mx.google.com")).toBe(true);
    expect(isTrustedAuthservId(gmail, "mx.google.com.evil.example")).toBe(
      false,
    );
    expect(isTrustedAuthservId(gmail, "")).toBe(false);
    expect(isTrustedAuthservId(microsoft, "")).toBe(true);
    expect(isTrustedAuthservId(microsoft, "x.eurprd01.prod.outlook.com")).toBe(
      true,
    );
    expect(isTrustedAuthservId(microsoft, "mx.google.com")).toBe(false);
    expect(isTrustedAuthservId(icloud, "dmarc.icloud.com")).toBe(true);
    expect(isTrustedAuthservId(icloud, "icloud.com.evil.example")).toBe(false);
    expect(isTrustedAuthservId(generic, "mx.example.net")).toBe(true);
    expect(isTrustedAuthservId(generic, "mx.small.example")).toBe(false);
    expect(isTrustedAuthservId(generic, "")).toBe(false);
    // 受信ホストが IP アドレスや公開サフィックスの下に無い名前なら、何も信頼しない。
    expect(
      isTrustedAuthservId({ provider: "generic", host: "192.0.2.1" }, "x"),
    ).toBe(false);
    expect(
      isTrustedAuthservId(
        { provider: "generic", host: "localhost" },
        "localhost",
      ),
    ).toBe(false);
    // 一般の設定で足した Gmail は Gmail として扱う。
    expect(
      isTrustedAuthservId(
        { provider: "generic", host: "imap.gmail.com" },
        "mx.google.com",
      ),
    ).toBe(true);
    expect(isTrustedAuthservId(null, "mx.google.com")).toBe(false);
  });

  it("受信サーバーが付けない一般のサーバーでは、差出人が書いた偽のヘッダーを使わない", () => {
    const forged = `mx.small.example; ${pass}`;
    expect(selectAuthResults([forged], generic)).toBeNull();
    expect(checkSender(from, selectAuthResults([forged], generic))).toEqual({
      verified: false,
      warnings: [],
      claimed: null,
      version: SENDER_CHECK_VERSION,
    });
    // 受信ホストと同じ組織の名前なら使う。
    expect(
      checkSender(from, selectAuthResults([`mx.example.net; ${pass}`], generic))
        .verified,
    ).toBe(true);
  });

  it("いちばん上が信頼しない名前なら、下の信頼する名前も使わない", () => {
    const values = [`mx.small.example; ${pass}`, `mx.google.com; ${pass}`];
    expect(selectAuthResults(values, gmail)).toBeNull();
  });

  it("同じ名前の 2 本目 (偽物の可能性) は使わず、上の本物を使う", () => {
    const values = [
      "mx.google.com; dmarc=fail header.from=example.com",
      `mx.google.com; ${pass}`,
    ];
    const results = selectAuthResults(values, gmail);
    expect(results?.dmarc).toEqual({ result: "fail", domain: "example.com" });
    expect(checkSender(from, results).warnings).toEqual(["dmarc_fail"]);
  });

  it("iCloud の方式ごとに分かれたヘッダーをまとめる", () => {
    const values = [
      "bimi.icloud.com; bimi=skipped reason=insufficient dmarc",
      "dmarc.icloud.com; dmarc=fail header.from=example.com",
      "dkim-verifier.icloud.com; dkim=none",
      "spf.icloud.com; spf=fail smtp.mailfrom=example.com",
      // iCloud のヘッダーの下に差出人が書いた偽物。
      `dmarc.icloud.com; ${pass}`,
    ];
    const results = selectAuthResults(values, icloud);
    expect(results).toMatchObject({
      authservId: "bimi.icloud.com",
      dmarc: { result: "fail", domain: "example.com" },
      spf: { result: "fail", domain: "example.com" },
      dkim: [{ result: "none", domain: null }],
    });
    expect(checkSender(from, results).warnings).toEqual(["dmarc_fail"]);
    expect(
      checkSender(
        from,
        selectAuthResults(
          [
            "bimi.icloud.com; bimi=pass",
            "dmarc.icloud.com; dmarc=pass header.from=example.com",
          ],
          icloud,
        ),
      ).verified,
    ).toBe(true);
  });

  it("Microsoft の名前を省いた形は、いちばん上の 1 本だけ", () => {
    const values = [
      "spf=fail smtp.mailfrom=example.com; dmarc=fail header.from=example.com",
      `spf=pass smtp.mailfrom=example.com; ${pass}`,
    ];
    expect(selectAuthResults(values, microsoft)?.dmarc?.result).toBe("fail");
  });
});
