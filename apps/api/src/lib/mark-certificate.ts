import { X509Certificate } from "node:crypto";
import { gunzipSync } from "node:zlib";
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

/** DER の 1 つの要素 (タグ、中身の範囲)。読めなければ null。 */
function readElement(
  data: Buffer,
  offset: number,
): { tag: number; start: number; end: number } | null {
  if (offset + 2 > data.length) return null;
  const tag = data[offset] as number;
  let length = data[offset + 1] as number;
  let start = offset + 2;
  if (length & 0x80) {
    const bytes = length & 0x7f;
    if (bytes === 0 || bytes > 4 || start + bytes > data.length) return null;
    length = 0;
    for (let i = 0; i < bytes; i++) {
      length = length * 256 + (data[start + i] as number);
    }
    start += bytes;
  }
  const end = start + length;
  return end <= data.length ? { tag, start, end } : null;
}

/** DER の中の IA5String (タグ 0x16) を、入れ子もたどってすべて集める。 */
function collectIa5Strings(
  data: Buffer,
  start: number,
  end: number,
  found: string[],
  depth = 0,
) {
  if (depth > 16) return;
  let offset = start;
  while (offset < end) {
    const element = readElement(data, offset);
    if (!element || element.end > end) return;
    if (element.tag === 0x16) {
      found.push(data.subarray(element.start, element.end).toString("latin1"));
    } else if (element.tag & 0x20) {
      // 構造型 (SEQUENCE や文脈タグ付きのもの) は中を見る。
      collectIa5Strings(data, element.start, element.end, found, depth + 1);
    }
    offset = element.end;
  }
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
      collectIa5Strings(der, element.start, element.end, strings);
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

/**
 * BIMI の証明書を確かめ、中のロゴ (SVG、未加工) を返す。確かめられなければ null。
 * - 本人の証明書の用途が BIMI のロゴで、期限内であること。
 * - 証明書の名前 (subjectAltName) に、BIMI のレコードを置いたドメインがあること。
 * - 信頼する発行元 (mark-roots.ts) まで、署名をたどれること。
 * 失効 (CRL・OCSP) は確かめていない。
 */
export function verifyMarkCertificate(
  pem: string,
  domain: string,
  options: { now?: number; roots?: X509Certificate[] } = {},
): string | null {
  const now = options.now ?? Date.now();
  const roots = options.roots ?? defaultRoots();
  const chain = parsePemChain(pem);
  const leaf = chain[0];
  if (!leaf || leaf.ca) return null;
  if (!(leaf.keyUsage ?? []).includes(BIMI_EKU)) return null;
  if (!validAt(leaf, now)) return null;
  if (!dnsNames(leaf).includes(domain.toLowerCase())) return null;

  let current = leaf;
  let anchor: X509Certificate | null = null;
  for (let step = 0; step < MAX_CHAIN && !anchor; step++) {
    anchor = roots.find((root) => issuedBy(current, root)) ?? null;
    if (anchor) break;
    const parent = chain
      .slice(1)
      .find(
        (candidate) =>
          candidate.ca &&
          validAt(candidate, now) &&
          issuedBy(current, candidate),
      );
    if (!parent) return null;
    current = parent;
  }
  if (!anchor) return null;
  if (
    /Entrust/i.test(anchor.subject) &&
    Date.parse(leaf.validFrom) > ENTRUST_CUTOFF
  ) {
    return null;
  }
  return logotypeSvg(leaf);
}
