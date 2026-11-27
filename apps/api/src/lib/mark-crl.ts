import { verify, type X509Certificate } from "node:crypto";
import {
  children,
  collectStrings,
  decodeOid,
  decodeTime,
  integerHex,
  readElement,
  wholeElement,
} from "./der.js";

// ---------------------------------------------------------------------------
// BIMI の証明書の失効の確認 (失効リスト、CRL、RFC 5280)。
// ---------------------------------------------------------------------------

/** 証明書の拡張「失効リストの場所」(2.5.29.31) の OID を DER にしたもの。 */
const CRL_DP_OID = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x1f]);
/** 次の更新日が書かれていない失効リストを、新しいとみなす期間。 */
const CRL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** 時計のずれとして許す幅。 */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** 失効リストの署名の方式 (OID) と、確かめるときのハッシュ。RSA-PSS などは扱わない。 */
const SIGNATURE_HASHES: Record<string, string> = {
  "1.2.840.113549.1.1.11": "sha256", // sha256WithRSAEncryption
  "1.2.840.113549.1.1.12": "sha384",
  "1.2.840.113549.1.1.13": "sha512",
  "1.2.840.10045.4.3.2": "sha256", // ecdsa-with-SHA256
  "1.2.840.10045.4.3.3": "sha384",
  "1.2.840.10045.4.3.4": "sha512",
};

/** 証明書に書かれた失効リストの場所 (http / https の URL)。 */
export function crlDistributionPoints(certificate: X509Certificate): string[] {
  const der = certificate.raw;
  const urls: string[] = [];
  let at = der.indexOf(CRL_DP_OID);
  while (at >= 0) {
    // 拡張は SEQUENCE { OID, [critical BOOLEAN], OCTET STRING }。
    let offset = at + CRL_DP_OID.length;
    let element = readElement(der, offset);
    if (element?.tag === 0x01) {
      offset = element.end;
      element = readElement(der, offset);
    }
    if (element?.tag === 0x04) {
      const found: string[] = [];
      // GeneralName の uniformResourceIdentifier は [6] (0x86)。
      collectStrings(der, element.start, element.end, 0x86, found);
      for (const url of found) {
        if (/^https?:\/\//i.test(url) && !urls.includes(url)) urls.push(url);
      }
    }
    at = der.indexOf(CRL_DP_OID, at + 1);
  }
  return urls;
}

/** 証明書の発行者 (issuer) の Name を、DER のまま取り出す。 */
export function certificateIssuer(certificate: X509Certificate): Buffer | null {
  const der = certificate.raw;
  const root = readElement(der, 0);
  const tbs = root && children(der, root)?.[0];
  const fields = tbs ? children(der, tbs) : null;
  if (!fields) return null;
  // [0] version があれば飛ばす。続いて serialNumber、signature、issuer。
  const offset = fields[0]?.tag === 0xa0 ? 1 : 0;
  const issuer = fields[offset + 2];
  return issuer?.tag === 0x30 ? wholeElement(der, issuer) : null;
}

export type ParsedCrl = {
  /** 署名の対象 (tbsCertList) の全体。 */
  tbs: Buffer;
  /** 発行者の Name (DER)。 */
  issuer: Buffer;
  thisUpdate: number;
  nextUpdate: number | null;
  /** 失効した証明書の通し番号 (大文字の 16 進)。 */
  revoked: Set<string>;
  signatureOid: string;
  signature: Buffer;
};

/** 失効リスト (DER、または PEM) を読む。読めなければ null。 */
export function parseCrl(input: Buffer): ParsedCrl | null {
  let der = input;
  const text = input.subarray(0, 64).toString("latin1");
  if (text.includes("-----BEGIN")) {
    const match =
      /-----BEGIN X509 CRL-----([\s\S]*?)-----END X509 CRL-----/.exec(
        input.toString("latin1"),
      );
    if (!match?.[1]) return null;
    der = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
  }
  const root = readElement(der, 0);
  if (!root || root.tag !== 0x30) return null;
  const parts = children(der, root);
  const [tbsElement, algorithm, signatureValue] = parts ?? [];
  if (!tbsElement || !algorithm || !signatureValue) return null;
  if (signatureValue.tag !== 0x03) return null;
  const algorithmParts = children(der, algorithm);
  const oid = algorithmParts?.[0];
  if (!oid || oid.tag !== 0x06) return null;

  const fields = children(der, tbsElement);
  if (!fields) return null;
  let index = fields[0]?.tag === 0x02 ? 1 : 0; // version
  index += 1; // signature
  const issuer = fields[index++];
  const thisUpdateElement = fields[index++];
  if (!issuer || issuer.tag !== 0x30 || !thisUpdateElement) return null;
  const thisUpdate = decodeTime(der, thisUpdateElement);
  if (thisUpdate === null) return null;
  let nextUpdate: number | null = null;
  const maybeNext = fields[index];
  if (maybeNext && (maybeNext.tag === 0x17 || maybeNext.tag === 0x18)) {
    nextUpdate = decodeTime(der, maybeNext);
    if (nextUpdate === null) return null;
    index += 1;
  }
  const revoked = new Set<string>();
  const list = fields[index];
  if (list && list.tag === 0x30) {
    for (const entry of children(der, list) ?? []) {
      const serial = children(der, entry)?.[0];
      if (serial?.tag !== 0x02) return null;
      revoked.add(integerHex(der.subarray(serial.start, serial.end)));
    }
  }
  return {
    tbs: wholeElement(der, tbsElement),
    issuer: wholeElement(der, issuer),
    thisUpdate,
    nextUpdate,
    revoked,
    signatureOid: decodeOid(der.subarray(oid.start, oid.end)),
    // BIT STRING の先頭 1 バイトは、使わないビットの数。
    signature: der.subarray(signatureValue.start + 1, signatureValue.end),
  };
}

/** 失効リストの署名が、発行元の鍵で付けられたものか。 */
function signedBy(crl: ParsedCrl, issuer: X509Certificate): boolean {
  const hash = SIGNATURE_HASHES[crl.signatureOid];
  if (!hash) return false;
  try {
    return verify(
      hash,
      crl.tbs,
      { key: issuer.publicKey, dsaEncoding: "der" },
      crl.signature,
    );
  } catch {
    return false;
  }
}

/**
 * 連なりの 1 段 (証明書と発行元) の失効を、失効リストで確かめる。
 * good: 失効していない。revoked: 失効している。unknown: どの場所からも、正しく署名された
 * 新しい失効リストを得られなかった。
 */
export async function revocationStatus(
  link: { certificate: X509Certificate; issuer: X509Certificate },
  urls: string[],
  now: number,
  fetchCrl: (url: string) => Promise<Buffer | null>,
): Promise<"good" | "revoked" | "unknown"> {
  const expectedIssuer = certificateIssuer(link.certificate);
  if (!expectedIssuer) return "unknown";
  const serial = integerHex(Buffer.from(link.certificate.serialNumber, "hex"));
  for (const url of urls) {
    const data = await fetchCrl(url).catch(() => null);
    const crl = data ? parseCrl(data) : null;
    if (!crl) continue;
    if (!crl.issuer.equals(expectedIssuer)) continue;
    if (!signedBy(crl, link.issuer)) continue;
    if (crl.thisUpdate > now + CLOCK_SKEW_MS) continue;
    const expires = crl.nextUpdate ?? crl.thisUpdate + CRL_MAX_AGE_MS;
    if (expires + CLOCK_SKEW_MS < now) continue;
    return crl.revoked.has(serial) ? "revoked" : "good";
  }
  return "unknown";
}
