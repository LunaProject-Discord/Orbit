import { constants } from "node:crypto";

/**
 * 古いメールサーバー (TLS の安全な再ネゴシエーション = RFC 5746 に対応していないもの)
 * へ接続するための TLS の設定。allow が false なら何も変えない。
 *
 * OpenSSL 3 は、こうしたサーバーとの接続を既定で断る
 * ("unsafe legacy renegotiation disabled")。許可すると、通信の途中に割り込める
 * 攻撃者が接続の先頭にデータを差し込める弱点 (CVE-2009-3555) を受け入れることになるので、
 * 全体ではなく、利用者が明示的に許可したアカウントの接続にだけ使う。
 * 証明書の検証や TLS のバージョンの下限は変えない。
 */
export function legacyTlsOptions(allow: boolean): { secureOptions?: number } {
  return allow ? { secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT } : {};
}

/** 接続の失敗が、サーバーが安全な再ネゴシエーションに対応していないためかどうか。 */
export function isLegacyTlsError(detail: string | null | undefined): boolean {
  return /unsafe legacy renegotiation disabled/i.test(detail ?? "");
}
