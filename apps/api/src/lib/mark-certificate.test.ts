import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EVIL_ROOT,
  FAKE_LEAF,
  TEST_INTERMEDIATE,
  TEST_ROOT,
  TLS_LEAF,
  VMC_LEAF,
} from "./mark-certificate.fixtures.js";
import {
  logotypeSvg,
  parsePemChain,
  verifyMarkCertificate,
} from "./mark-certificate.js";
import { MARK_CERTIFICATE_ROOTS } from "./mark-roots.js";

const roots = [new X509Certificate(TEST_ROOT)];
const now = Date.parse("2030-01-01T00:00:00Z");
const chain = (...pems: string[]) => pems.join("\n");

describe("verifyMarkCertificate", () => {
  it("信頼する発行元までたどれる BIMI の証明書から、中のロゴを取り出す", () => {
    const svg = verifyMarkCertificate(
      chain(VMC_LEAF, TEST_INTERMEDIATE, TEST_ROOT),
      "brand.example",
      { now, roots },
    );
    expect(svg).toContain("<svg");
    expect(svg).toContain("<title>Brand</title>");
  });

  it("ルートを省いた連なりでも確かめられる", () => {
    expect(
      verifyMarkCertificate(
        chain(VMC_LEAF, TEST_INTERMEDIATE),
        "BRAND.example",
        {
          now,
          roots,
        },
      ),
    ).toContain("<svg");
  });

  it("ドメインが違う、用途が違う、期限外のものは使わない", () => {
    const full = chain(VMC_LEAF, TEST_INTERMEDIATE);
    expect(
      verifyMarkCertificate(full, "brand-look.example", { now, roots }),
    ).toBeNull();
    expect(
      verifyMarkCertificate(
        chain(TLS_LEAF, TEST_INTERMEDIATE),
        "brand.example",
        {
          now,
          roots,
        },
      ),
    ).toBeNull();
    expect(
      verifyMarkCertificate(full, "brand.example", {
        now: Date.parse("2200-01-01T00:00:00Z"),
        roots,
      }),
    ).toBeNull();
  });

  it("信頼していない発行元のもの、途中が欠けたものは使わない", () => {
    expect(
      verifyMarkCertificate(chain(FAKE_LEAF, EVIL_ROOT), "brand.example", {
        now,
        roots,
      }),
    ).toBeNull();
    expect(
      verifyMarkCertificate(VMC_LEAF, "brand.example", { now, roots }),
    ).toBeNull();
    // 実際の発行元だけを信頼するなら、テスト用の発行元の証明書は通らない。
    expect(
      verifyMarkCertificate(
        chain(VMC_LEAF, TEST_INTERMEDIATE, TEST_ROOT),
        "brand.example",
        { now },
      ),
    ).toBeNull();
  });

  it("証明書でない文字列は使わない", () => {
    expect(verifyMarkCertificate("not a pem", "brand.example")).toBeNull();
    expect(
      parsePemChain(
        "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----",
      ),
    ).toEqual([]);
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
