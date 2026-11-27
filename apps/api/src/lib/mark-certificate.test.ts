import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EVIL_ROOT,
  FAKE_LEAF,
  INT_EMPTY_CRL,
  INT_FORGED_CRL,
  INT_REVOKED_CRL,
  INT_SHORT_CRL,
  NO_CRL_LEAF,
  ROOT_EMPTY_CRL,
  TEST_INTERMEDIATE,
  TEST_ROOT,
  TLS_LEAF,
  VMC_LEAF,
} from "./mark-certificate.fixtures.js";
import {
  checkMarkCertificate,
  logotypeSvg,
  parsePemChain,
  verifyMarkCertificate,
} from "./mark-certificate.js";
import { crlDistributionPoints, parseCrl } from "./mark-crl.js";
import { MARK_CERTIFICATE_ROOTS } from "./mark-roots.js";

const roots = [new X509Certificate(TEST_ROOT)];
const now = Date.parse("2030-01-01T00:00:00Z");
const chain = (...pems: string[]) => pems.join("\n");
const INT_URL = "http://crl.test.example/int.crl";
const ROOT_URL = "http://crl.test.example/root.crl";

/** 場所ごとに失効リスト (base64) を返す、取得の代わり。取得した場所も覚える。 */
function crls(map: Record<string, string | null>) {
  const fetched: string[] = [];
  const fetchCrl = async (url: string) => {
    fetched.push(url);
    const value = map[url];
    return value ? Buffer.from(value, "base64") : null;
  };
  return { fetched, fetchCrl };
}

const goodCrls = () =>
  crls({ [INT_URL]: INT_EMPTY_CRL, [ROOT_URL]: ROOT_EMPTY_CRL });

describe("checkMarkCertificate", () => {
  it("信頼する発行元までたどれる BIMI の証明書から、中のロゴを取り出す", () => {
    const checked = checkMarkCertificate(
      chain(VMC_LEAF, TEST_INTERMEDIATE, TEST_ROOT),
      "brand.example",
      { now, roots },
    );
    expect(checked?.svg).toContain("<title>Brand</title>");
    expect(checked?.links).toHaveLength(2);
  });

  it("ルートを省いた連なりでも確かめられる", () => {
    expect(
      checkMarkCertificate(
        chain(VMC_LEAF, TEST_INTERMEDIATE),
        "BRAND.example",
        {
          now,
          roots,
        },
      )?.svg,
    ).toContain("<svg");
  });

  it("ドメインが違う、用途が違う、期限外のものは使わない", () => {
    const full = chain(VMC_LEAF, TEST_INTERMEDIATE);
    expect(
      checkMarkCertificate(full, "brand-look.example", { now, roots }),
    ).toBeNull();
    expect(
      checkMarkCertificate(
        chain(TLS_LEAF, TEST_INTERMEDIATE),
        "brand.example",
        {
          now,
          roots,
        },
      ),
    ).toBeNull();
    expect(
      checkMarkCertificate(full, "brand.example", {
        now: Date.parse("2200-01-01T00:00:00Z"),
        roots,
      }),
    ).toBeNull();
  });

  it("信頼していない発行元のもの、途中が欠けたものは使わない", () => {
    expect(
      checkMarkCertificate(chain(FAKE_LEAF, EVIL_ROOT), "brand.example", {
        now,
        roots,
      }),
    ).toBeNull();
    expect(
      checkMarkCertificate(VMC_LEAF, "brand.example", { now, roots }),
    ).toBeNull();
    // 実際の発行元だけを信頼するなら、テスト用の発行元の証明書は通らない。
    expect(
      checkMarkCertificate(
        chain(VMC_LEAF, TEST_INTERMEDIATE, TEST_ROOT),
        "brand.example",
        { now },
      ),
    ).toBeNull();
  });

  it("証明書でない文字列は使わない", () => {
    expect(checkMarkCertificate("not a pem", "brand.example")).toBeNull();
    expect(
      parsePemChain(
        "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----",
      ),
    ).toEqual([]);
  });
});

describe("verifyMarkCertificate (失効の確認)", () => {
  const pem = chain(VMC_LEAF, TEST_INTERMEDIATE);

  it("本人と途中の証明書が失効していなければロゴを返す", async () => {
    const { fetched, fetchCrl } = goodCrls();
    expect(
      await verifyMarkCertificate(pem, "brand.example", {
        now,
        roots,
        fetchCrl,
      }),
    ).toContain("<svg");
    expect(fetched).toEqual([INT_URL, ROOT_URL]);
  });

  it("失効していれば null", async () => {
    const { fetchCrl } = crls({
      [INT_URL]: INT_REVOKED_CRL,
      [ROOT_URL]: ROOT_EMPTY_CRL,
    });
    expect(
      await verifyMarkCertificate(pem, "brand.example", {
        now,
        roots,
        fetchCrl,
      }),
    ).toBeNull();
  });

  it("失効リストを取得できない、署名が合わない、古いときは error", async () => {
    const missing = crls({ [ROOT_URL]: ROOT_EMPTY_CRL });
    expect(
      await verifyMarkCertificate(pem, "brand.example", {
        now,
        roots,
        fetchCrl: missing.fetchCrl,
      }),
    ).toBe("error");
    const forged = crls({
      [INT_URL]: INT_FORGED_CRL,
      [ROOT_URL]: ROOT_EMPTY_CRL,
    });
    expect(
      await verifyMarkCertificate(pem, "brand.example", {
        now,
        roots,
        fetchCrl: forged.fetchCrl,
      }),
    ).toBe("error");
    const stale = crls({
      [INT_URL]: INT_SHORT_CRL,
      [ROOT_URL]: ROOT_EMPTY_CRL,
    });
    expect(
      await verifyMarkCertificate(pem, "brand.example", {
        now,
        roots,
        fetchCrl: stale.fetchCrl,
      }),
    ).toBe("error");
  });

  it("本人の証明書に失効リストの場所が無ければ使わない", async () => {
    const { fetchCrl } = goodCrls();
    expect(
      await verifyMarkCertificate(
        chain(NO_CRL_LEAF, TEST_INTERMEDIATE),
        "brand.example",
        { now, roots, fetchCrl },
      ),
    ).toBeNull();
  });
});

describe("失効リストの読み取り", () => {
  it("場所と、失効した通し番号を読む", () => {
    expect(crlDistributionPoints(new X509Certificate(VMC_LEAF))).toEqual([
      INT_URL,
    ]);
    const revoked = parseCrl(Buffer.from(INT_REVOKED_CRL, "base64"));
    const serial = new X509Certificate(VMC_LEAF).serialNumber;
    expect(revoked?.revoked.has(serial.replace(/^(00)+/, ""))).toBe(true);
    expect(parseCrl(Buffer.from(INT_EMPTY_CRL, "base64"))?.revoked.size).toBe(
      0,
    );
    expect(parseCrl(Buffer.from("garbage"))).toBeNull();
  });
});

describe("logotypeSvg", () => {
  it("ロゴの拡張が無い証明書では null", () => {
    expect(logotypeSvg(new X509Certificate(TEST_ROOT))).toBeNull();
  });
});

describe("MARK_CERTIFICATE_ROOTS", () => {
  it("どれも証明書として読める", () => {
    for (const pem of MARK_CERTIFICATE_ROOTS) {
      expect(() => new X509Certificate(pem)).not.toThrow();
    }
    expect(MARK_CERTIFICATE_ROOTS.length).toBeGreaterThan(0);
  });
});
