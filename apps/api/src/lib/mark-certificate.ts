import { X509Certificate } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { collectStrings, readElement } from "./der.js";
import { crlDistributionPoints, revocationStatus } from "./mark-crl.js";
import { MARK_CERTIFICATE_ROOTS } from "./mark-roots.js";

// ---------------------------------------------------------------------------
// BIMI のロゴの証明書 (VMC: Verified Mark Certificate、CMC: Common Mark Certificate)。
// 認証局が「このドメインの持ち主が、このロゴの持ち主である」と確かめて発行する証明書で、
// ロゴそのもの (SVG) も中に入っている。これを確かめたロゴだけを出せば、似せたドメインに
// 他社のロゴを置かれても表示されない。
// ---------------------------------------------------------------------------

/** 証明書の用途 (拡張鍵用途) の「BIMI のロゴ」。 */
const BIMI_EKU = "1.3.6.1.5.5.7.3.31";
/** ロゴを入れる拡張 (logotype、RFC 3709) の OID を DER にしたもの (1.3.6.1.5.5.7.1.12)。 */
const LOGOTYPE_OID = Buffer.from([
  0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x01, 0x0c,
]);
/** 連なりの長さの上限 (発行元までたどる回数)。 */
const MAX_CHAIN = 5;
/** 圧縮を戻した SVG の大きさの上限 (BIMI のロゴは 32KB 以下が推奨)。 */
const MAX_LOGO_BYTES = 64 * 1024;
/**
 * Entrust のルートから、この日より後に発行された証明書は信頼しない
 * (主なメールサービスが、Entrust の新しい証明書を信頼しなくなったため)。
 */
const ENTRUST_CUTOFF = Date.parse("2024-11-15T00:00:00Z");

let trustedRoots: X509Certificate[] | null = null;

/** 信頼する発行元 (mark-roots.ts)。読めないものは飛ばす。 */
function defaultRoots(): X509Certificate[] {
  if (!trustedRoots) {
    trustedRoots = [];
    for (const pem of MARK_CERTIFICATE_ROOTS) {
      try {
        trustedRoots.push(new X509Certificate(pem));
      } catch {
        // 壊れた証明書は信頼しない。
      }
    }
  }
  return trustedRoots;
}

/** PEM の文字列から証明書を順に読む (先頭が本人の証明書)。読めなければ空。 */
export function parsePemChain(pem: string): X509Certificate[] {
  const certificates: X509Certificate[] = [];
  for (const match of pem.matchAll(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  )) {
    try {
      certificates.push(new X509Certificate(match[0]));
    } catch {
      return [];
    }
  }
  return certificates;
}

function validAt(certificate: X509Certificate, now: number): boolean {
  return (
    Date.parse(certificate.validFrom) <= now &&
    now <= Date.parse(certificate.validTo)
  );
}

function issuedBy(child: X509Certificate, parent: X509Certificate): boolean {
  try {
    return child.checkIssued(parent) && child.verify(parent.publicKey);
  } catch {
    return false;
  }
}

/** subjectAltName の DNS 名 (小文字)。 */
function dnsNames(certificate: X509Certificate): string[] {
  return (certificate.subjectAltName ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.toUpperCase().startsWith("DNS:"))
    .map((item) => item.slice(4).trim().toLowerCase());
}

/**
 * 証明書の logotype 拡張に入っているロゴ (data: URL の SVG) を取り出す。
 * SVG は gzip で圧縮されていることが多い (svgz)。無ければ null。
 */
export function logotypeSvg(certificate: X509Certificate): string | null {
  const der = certificate.raw;
  let at = der.indexOf(LOGOTYPE_OID);
  while (at >= 0) {
    // 拡張は SEQUENCE { OID, [critical BOOLEAN], OCTET STRING }。
    let offset = at + LOGOTYPE_OID.length;
    let element = readElement(der, offset);
    if (element?.tag === 0x01) {
      offset = element.end;
      element = readElement(der, offset);
    }
    if (element?.tag === 0x04) {
      const strings: string[] = [];
      collectStrings(der, element.start, element.end, 0x16, strings);
      for (const value of strings) {
        const svg = decodeLogoUrl(value);
        if (svg) return svg;
      }
    }
    at = der.indexOf(LOGOTYPE_OID, at + 1);
  }
  return null;
}

/** 「data:image/svg+xml;base64,...」から SVG の文字列を取り出す。 */
function decodeLogoUrl(value: string): string | null {
  const match = /^data:image\/svg\+xml(?:;[^,]*)?;base64,([\s\S]*)$/i.exec(
    value.trim(),
  );
  if (!match?.[1]) return null;
  let data = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
  if (data[0] === 0x1f && data[1] === 0x8b) {
    try {
      data = gunzipSync(data, { maxOutputLength: MAX_LOGO_BYTES });
    } catch {
      return null;
    }
  }
  if (data.length === 0 || data.length > MAX_LOGO_BYTES) return null;
  return data.toString("utf8");
}

/** 署名の連なりの 1 段 (証明書と、それに署名した発行元)。失効を確かめるのに使う。 */
export type ChainLink = {
  certificate: X509Certificate;
  issuer: X509Certificate;
};

/**
 * BIMI の証明書を、通信せずに確かめられる範囲で確かめる。確かめられなければ null。
 * - 本人の証明書の用途が BIMI のロゴで、期限内であること。
 * - 証明書の名前 (subjectAltName) に、BIMI のレコードを置いたドメインがあること。
 * - 信頼する発行元 (mark-roots.ts) まで、署名をたどれること。
 * 返す links は本人から発行元へ向かう順の連なりで、失効の確認 (verifyMarkCertificate) に使う。
 */
export function checkMarkCertificate(
  pem: string,
  domain: string,
  options: { now?: number; roots?: X509Certificate[] } = {},
): { svg: string; links: ChainLink[] } | null {
  const now = options.now ?? Date.now();
  const roots = options.roots ?? defaultRoots();
  const chain = parsePemChain(pem);
  const leaf = chain[0];
  if (!leaf || leaf.ca) return null;
  if (!(leaf.keyUsage ?? []).includes(BIMI_EKU)) return null;
  if (!validAt(leaf, now)) return null;
  if (!dnsNames(leaf).includes(domain.toLowerCase())) return null;

  const links: ChainLink[] = [];
  let current = leaf;
  let anchor: X509Certificate | null = null;
  for (let step = 0; step < MAX_CHAIN; step++) {
    anchor = roots.find((root) => issuedBy(current, root)) ?? null;
    if (anchor) {
      links.push({ certificate: current, issuer: anchor });
      break;
    }
    const parent = chain
      .slice(1)
      .find(
        (candidate) =>
          candidate.ca &&
          validAt(candidate, now) &&
          issuedBy(current, candidate),
      );
    if (!parent) return null;
    links.push({ certificate: current, issuer: parent });
    current = parent;
  }
  if (!anchor) return null;
  if (
    /Entrust/i.test(anchor.subject) &&
    Date.parse(leaf.validFrom) > ENTRUST_CUTOFF
  ) {
    return null;
  }
  const svg = logotypeSvg(leaf);
  return svg ? { svg, links } : null;
}

/**
 * BIMI の証明書を確かめ、中のロゴ (SVG、未加工) を返す。checkMarkCertificate に加えて、
 * 連なりの各証明書が失効していないことを、証明書に書かれた失効リスト (CRL) で確かめる。
 * - 本人の証明書に失効リストの場所が無ければ使わない (Mark Certificate には必ず書かれる)。
 *   途中の証明書は、場所が書かれていれば確かめる。
 * - 失効していれば null。失効リストを取得できない、署名が合わない、古すぎるときは
 *   "error" (しばらくしてから確かめ直す。その間はロゴを出さない)。
 * OCSP は使わない (失効リストで足りるため)。
 */
export async function verifyMarkCertificate(
  pem: string,
  domain: string,
  options: {
    now?: number;
    roots?: X509Certificate[];
    /** 失効リスト (DER) を取得する。取得できなければ null。 */
    fetchCrl: (url: string) => Promise<Buffer | null>;
  },
): Promise<string | null | "error"> {
  const now = options.now ?? Date.now();
  const checked = checkMarkCertificate(pem, domain, { ...options, now });
  if (!checked) return null;
  for (const [index, link] of checked.links.entries()) {
    const urls = crlDistributionPoints(link.certificate);
    if (urls.length === 0) {
      if (index === 0) return null;
      continue;
    }
    const status = await revocationStatus(link, urls, now, options.fetchCrl);
    if (status !== "good") return status === "revoked" ? null : "error";
  }
  return checked.svg;
}
