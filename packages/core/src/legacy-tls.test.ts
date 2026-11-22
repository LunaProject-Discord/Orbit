import { constants } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isLegacyTlsError, legacyTlsOptions } from "./legacy-tls.js";

describe("legacyTlsOptions", () => {
  it("許可していなければ TLS の設定を変えない", () => {
    expect(legacyTlsOptions(false)).toEqual({});
  });

  it("許可したときだけ、古いサーバーへの接続を認める", () => {
    expect(legacyTlsOptions(true)).toEqual({
      secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT,
    });
  });
});

describe("isLegacyTlsError", () => {
  it("OpenSSL の再ネゴシエーションのエラーを見分ける", () => {
    expect(
      isLegacyTlsError(
        "609AB595FFFF0000:error:0A000152:SSL routines:final_renegotiate:unsafe legacy renegotiation disabled:../deps/openssl/openssl/ssl/statem/extensions.c:897:",
      ),
    ).toBe(true);
  });

  it("ほかの失敗は見分けない", () => {
    expect(isLegacyTlsError("connect ECONNREFUSED 192.0.2.1:993")).toBe(false);
    expect(isLegacyTlsError("self-signed certificate")).toBe(false);
    expect(isLegacyTlsError(null)).toBe(false);
  });
});
