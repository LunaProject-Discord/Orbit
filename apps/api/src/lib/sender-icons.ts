import { createHash } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { addressDomain, organizationalDomain } from "@orbit/core";
import { type Database, senderIcons } from "@orbit/db";
import { eq, sql } from "drizzle-orm";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { resolvesToPrivateAddress } from "./host-check.js";
import { verifyMarkCertificate } from "./mark-certificate.js";

/**
 * 差出人のアイコンを、サーバーが外部から取得してキャッシュする。
 *
 * 端末から直接取りに行くと、メールを開いたことが相手 (やドメインの持ち主) に伝わるので、
 * 取得はすべてサーバーで行い、結果 (見つからなかったことも含む) を sender_icons に覚える。
 * 探す順は、BIMI のロゴ → Gravatar → ドメインのファビコン。連絡先の写真は、連絡先の機能が
 * できたときに BIMI より前に足す。
 */

/** 探す取得元。端末が、差出人の確認結果と設定から選んで渡す。 */
export type IconSource = "bimi" | "gravatar" | "favicon";

export const ICON_SOURCES: IconSource[] = ["bimi", "gravatar", "favicon"];

export type IconImage = { contentType: string; data: Buffer };

/** 見つかった画像と、その取得元。 */
export type FoundIcon = IconImage & { source: IconSource };

/** 見つかったものを覚えておく期間。 */
const FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** BIMI のロゴを覚えておく期間。証明書の失効を確かめ直す間隔でもある。 */
const BIMI_FOUND_TTL_MS = 24 * 60 * 60 * 1000;
/** 失効リストの大きさの上限。 */
const MAX_CRL_BYTES = 2 * 1024 * 1024;

/** キャッシュの扱い。 */
type LookupOptions = {
  /** 見つかったものを覚えておく期間。 */
  foundTtl?: number;
  /** 取得に失敗したとき、前に取れていた画像を使い続けるか (標準は使う)。 */
  keepOnError?: boolean;
};
/** 見つからなかったことを覚えておく期間。 */
const MISSING_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** 通信の失敗などで分からなかったときに、取り直すまでの期間。 */
const ERROR_TTL_MS = 6 * 60 * 60 * 1000;

/** BIMI の証明書 (PEM、中にロゴを含む) の大きさの上限。 */
const MAX_MARK_CERTIFICATE_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 256 * 1024;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 6_000;

/**
 * 個人向けのメールサービスのドメイン。これらのファビコン (Gmail のロゴなど) は、
 * 差出人が誰かを表さないので使わない。
 */
const PERSONAL_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.jp",
  "hotmail.com",
  "hotmail.co.jp",
  "live.com",
  "live.jp",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "yahoo.com",
  "yahoo.co.jp",
  "ymail.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "mail.ru",
  "qq.com",
  "163.com",
  "126.com",
  "naver.com",
  "docomo.ne.jp",
  "ezweb.ne.jp",
  "au.com",
  "softbank.ne.jp",
  "i.softbank.jp",
  "ymobile.ne.jp",
  "y-mobile.ne.jp",
  "rakumail.jp",
  "uqmobile.jp",
  "nifty.com",
  "biglobe.ne.jp",
  "so-net.ne.jp",
  "ocn.ne.jp",
  "plala.or.jp",
  "dion.ne.jp",
  "infoseek.jp",
  "excite.co.jp",
]);

/** 個人向けのメールサービスのアドレスか (ファビコンを使わない)。 */
export function isPersonalMailDomain(domain: string): boolean {
  return (
    PERSONAL_MAIL_DOMAINS.has(domain) ||
    PERSONAL_MAIL_DOMAINS.has(organizationalDomain(domain))
  );
}

// ---------------------------------------------------------------------------
// 取得
// ---------------------------------------------------------------------------

export type FetchResult = {
  contentType: string;
  body: Buffer;
  /** 転送後の URL。 */
  url: string;
};

/**
 * HTTPS で取得する。見つからない、大きすぎる、内部ネットワークを指すなどの場合は null。
 * allowHttp なら http (ポート 80) も使う (中身が署名で守られている失効リスト用)。
 */
export type FetchBytes = (
  url: string,
  options: { maxBytes: number; accept: string; allowHttp?: boolean },
) => Promise<FetchResult | null>;

export type IconDeps = {
  fetchBytes: FetchBytes;
  resolveTxt: (name: string) => Promise<string[][]>;
  /**
   * BIMI の証明書を確かめ、中のロゴを返す (テストで差し替える)。省略時は verifyMarkCertificate
   * (失効リストは fetchBytes で取得する)。
   */
  verifyMark?: (
    pem: string,
    domain: string,
  ) => Promise<string | null | "error">;
};

export function createFetchBytes({
  allowPrivate,
  fetchImpl = fetch,
}: {
  allowPrivate: boolean;
  fetchImpl?: typeof fetch;
}): FetchBytes {
  return async (url, { maxBytes, accept, allowHttp = false }) => {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const parsed = new URL(target);
      const http = allowHttp && parsed.protocol === "http:";
      if (parsed.protocol !== "https:" && !http) return null;
      if (parsed.port && parsed.port !== (http ? "80" : "443")) return null;
      if (!allowPrivate) {
        const isPrivate = await resolvesToPrivateAddress(parsed.hostname).catch(
          () => null,
        );
        if (isPrivate !== false) return null;
      }
      const response = await fetchImpl(target, {
        headers: { accept, "user-agent": "Orbit-Mail-IconFetcher/1.0" },
        redirect: "manual",
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) return null;
        target = new URL(location, target).toString();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length > maxBytes) {
        await response.body?.cancel();
        return null;
      }
      const reader = response.body?.getReader();
      if (!reader) return null;
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
      return {
        contentType:
          (response.headers.get("content-type") ?? "")
            .split(";")[0]
            ?.trim()
            .toLowerCase() ?? "",
        body: Buffer.concat(chunks),
        url: target,
      };
    }
    return null;
  };
}

export function defaultIconDeps(allowPrivate: boolean): IconDeps {
  return {
    fetchBytes: createFetchBytes({ allowPrivate }),
    resolveTxt: (name) => resolveTxt(name),
  };
}

// ---------------------------------------------------------------------------
// 画像の確認と SVG の無害化
// ---------------------------------------------------------------------------

/** 中身から画像の種類を決める (サーバーが返す Content-Type は信用しない)。画像でなければ null。 */
export function sniffImage(data: Buffer): string | null {
  if (data.length < 4) return null;
  if (data[0] === 0x89 && data.subarray(1, 4).toString("latin1") === "PNG")
    return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return "image/jpeg";
  if (data.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("latin1") === "RIFF" &&
    data.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  if (data[0] === 0 && data[1] === 0 && data[2] === 1 && data[3] === 0)
    return "image/x-icon";
  const head = data
    .subarray(0, 512)
    .toString("utf8")
    .replace(/^﻿/, "")
    .trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head))
    return "image/svg+xml";
  return null;
}

/** SVG で残す要素 (BIMI が使う SVG Tiny PS の範囲)。これ以外は中身ごと捨てる。 */
const SVG_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "title",
  "desc",
  "defs",
  "lineargradient",
  "radialgradient",
  "stop",
  "use",
  "clippath",
  "mask",
  "pattern",
  "symbol",
  "solidcolor",
]);

/** 属性の値に、外部の資源やスクリプトを指すものが含まれているか。 */
function unsafeValue(value: string): boolean {
  const lower = value.toLowerCase().replace(/\s+/g, "");
  if (/(javascript|vbscript|data):/.test(lower)) return true;
  if (lower.includes("@import") || lower.includes("expression(")) return true;
  // url(#id) だけを許す。
  for (const match of lower.matchAll(/url\(([^)]*)\)/g)) {
    const inner = (match[1] ?? "").replace(/^['"]|['"]$/g, "");
    if (!inner.startsWith("#")) return true;
  }
  return false;
}

type XmlNode = Record<string, unknown>;

function cleanAttributes(
  attrs: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!attrs) return undefined;
  const kept: Record<string, string> = {};
  for (const [key, raw] of Object.entries(attrs)) {
    const name = key.slice(2); // "@_" を外す
    const lower = name.toLowerCase();
    const value = String(raw);
    if (lower.startsWith("on")) continue;
    if (lower === "href" || lower === "xlink:href") {
      if (!value.trim().startsWith("#")) continue;
    } else if (
      lower.includes(":") &&
      !["xmlns:xlink", "xml:space", "xml:lang"].includes(lower)
    ) {
      continue;
    }
    if (unsafeValue(value)) continue;
    kept[key] = value;
  }
  return kept;
}

function cleanNodes(nodes: XmlNode[]): XmlNode[] {
  const out: XmlNode[] = [];
  for (const node of nodes) {
    if ("#text" in node) {
      out.push(node);
      continue;
    }
    const tag = Object.keys(node).find((key) => key !== ":@");
    if (!tag || !SVG_ELEMENTS.has(tag.toLowerCase())) continue;
    const children = Array.isArray(node[tag]) ? (node[tag] as XmlNode[]) : [];
    const cleaned: XmlNode = { [tag]: cleanNodes(children) };
    const attrs = cleanAttributes(
      node[":@"] as Record<string, string> | undefined,
    );
    if (attrs) cleaned[":@"] = attrs;
    out.push(cleaned);
  }
  return out;
}

const svgParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

const svgBuilder = new XMLBuilder({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  suppressEmptyNode: true,
  processEntities: false,
});

/**
 * SVG から、スクリプト、外部の資源への参照、イベントの属性、知らない要素を取り除く。
 * 画像は <img> で出すのでスクリプトは元々動かないが、念のため無害化してから保存する。
 * 読めない、または <svg> で始まらないものは null。
 */
export function sanitizeSvg(text: string): string | null {
  // 実体の定義 (大量展開や外部ファイルの読み込みに使われる) を含むものは受け付けない。
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return null;
  let parsed: XmlNode[];
  try {
    parsed = svgParser.parse(text) as XmlNode[];
  } catch {
    return null;
  }
  const roots = cleanNodes(parsed).filter((node) => !("#text" in node));
  const root = roots[0];
  if (roots.length !== 1 || !root || !("svg" in root)) return null;
  const attrs = (root[":@"] ?? {}) as Record<string, string>;
  if (!attrs["@_xmlns"]) attrs["@_xmlns"] = "http://www.w3.org/2000/svg";
  root[":@"] = attrs;
  return svgBuilder.build([root]) as string;
}

/** 取得した画像を確かめ、保存する形にする。画像でなければ null。 */
export function acceptImage(data: Buffer): IconImage | null {
  const type = sniffImage(data);
  if (!type) return null;
  if (type === "image/svg+xml") {
    const svg = sanitizeSvg(data.toString("utf8"));
    return svg ? { contentType: type, data: Buffer.from(svg, "utf8") } : null;
  }
  return { contentType: type, data };
}

// ---------------------------------------------------------------------------
// 取得元ごとの処理
// ---------------------------------------------------------------------------

/** BIMI のレコードの中身。 */
export type BimiRecord = {
  /** l= のロゴの URL (https)。 */
  logo: string | null;
  /** a= の証明書 (VMC・CMC) の URL (https)。 */
  authority: string | null;
};

function httpsUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * BIMI の DNS レコード (「v=BIMI1; l=https://...; a=https://...」) を読む。
 * BIMI のレコードでなければ null。
 */
export function parseBimiRecord(records: string[][]): BimiRecord | null {
  for (const chunks of records) {
    const record = chunks.join("");
    if (!/^v\s*=\s*BIMI1\s*(;|$)/i.test(record.trim())) continue;
    const tags = new Map<string, string>();
    for (const part of record.split(";")) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      tags.set(
        part.slice(0, eq).trim().toLowerCase(),
        part.slice(eq + 1).trim(),
      );
    }
    return {
      logo: httpsUrl(tags.get("l")),
      authority: httpsUrl(tags.get("a")),
    };
  }
  return null;
}

/** 取得結果。error は通信の失敗などで分からなかったこと (短い間だけ覚える)。 */
type Lookup = IconImage | null | "error";

async function lookupBimiRecord(
  deps: IconDeps,
  domain: string,
): Promise<BimiRecord | null | "missing"> {
  try {
    const records = await deps.resolveTxt(`default._bimi.${domain}`);
    const hasRecord = records.some((chunks) =>
      /^v\s*=\s*BIMI1/i.test(chunks.join("").trim()),
    );
    return hasRecord ? parseBimiRecord(records) : "missing";
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return "missing";
    throw error;
  }
}

/**
 * BIMI のロゴ。ドメインに無ければ、組織のドメインのものを使う。
 * 証明書 (VMC・CMC、レコードの a=) を確かめられたときだけ、証明書に入っているロゴを使う
 * (l= のロゴは使わない)。証明書が無いと、似せたドメインに他社のロゴを置かれても
 * 見分けられないため。
 */
export async function fetchBimi(
  deps: IconDeps,
  domain: string,
): Promise<Lookup> {
  try {
    let recordDomain = domain;
    let record = await lookupBimiRecord(deps, domain);
    const org = organizationalDomain(domain);
    if (record === "missing" && org !== domain) {
      recordDomain = org;
      record = await lookupBimiRecord(deps, org);
    }
    if (record === "missing" || !record?.authority) return null;
    const result = await deps.fetchBytes(record.authority, {
      maxBytes: MAX_MARK_CERTIFICATE_BYTES,
      accept: "application/pem-certificate-chain, application/x-pem-file, */*",
    });
    if (!result) return null;
    const pem = result.body.toString("latin1");
    const svg = deps.verifyMark
      ? await deps.verifyMark(pem, recordDomain)
      : await verifyMarkCertificate(pem, recordDomain, {
          fetchCrl: async (url) =>
            (
              await deps.fetchBytes(url, {
                maxBytes: MAX_CRL_BYTES,
                accept: "application/pkix-crl, */*",
                // 失効リストは署名付きなので、http で配られるものも使う (多くは http)。
                allowHttp: true,
              })
            )?.body ?? null,
        });
    if (svg === "error") return "error";
    if (!svg) return null;
    const image = acceptImage(Buffer.from(svg, "utf8"));
    // BIMI のロゴは SVG だけ。
    return image?.contentType === "image/svg+xml" ? image : null;
  } catch {
    return "error";
  }
}

export function gravatarHash(address: string): string {
  return createHash("sha256")
    .update(address.trim().toLowerCase())
    .digest("hex");
}

export async function fetchGravatar(
  deps: IconDeps,
  hash: string,
): Promise<Lookup> {
  try {
    const result = await deps.fetchBytes(
      `https://gravatar.com/avatar/${hash}?s=128&d=404&r=g`,
      { maxBytes: MAX_IMAGE_BYTES, accept: "image/*" },
    );
    return result ? acceptImage(result.body) : null;
  } catch {
    return "error";
  }
}

type IconLink = { href: string; score: number };

/** HTML の <link rel="icon"> などから、アイコンの候補を良い順に並べる。 */
export function findIconLinks(html: string, base: string): string[] {
  const head = html.slice(0, MAX_HTML_BYTES);
  const links: IconLink[] = [];
  for (const match of head.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const attr = (name: string) =>
      new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i")
        .exec(tag)
        ?.slice(1)
        .find((value) => value !== undefined);
    const rel = (attr("rel") ?? "").toLowerCase().split(/\s+/);
    const href = attr("href");
    if (!href) continue;
    let score: number;
    if (
      rel.includes("apple-touch-icon") ||
      rel.includes("apple-touch-icon-precomposed")
    ) {
      score = 180;
    } else if (rel.includes("icon")) {
      const type = (attr("type") ?? "").toLowerCase();
      const sizes = (attr("sizes") ?? "").toLowerCase();
      if (
        type.includes("svg") ||
        href.toLowerCase().split("?")[0]?.endsWith(".svg")
      ) {
        score = 200;
      } else if (sizes === "any") {
        score = 190;
      } else {
        const largest = Math.max(
          0,
          ...sizes
            .split(/\s+/)
            .map((size) => Number(size.split("x")[0]))
            .filter((size) => Number.isFinite(size)),
        );
        score = largest || 32;
      }
      // 大きすぎる画像は、小さく出すと潰れるわけではないが、取得の上限に掛かりやすい。
      if (score > 512) score = 100;
    } else continue;
    try {
      const url = new URL(href.replace(/&amp;/g, "&"), base);
      if (url.protocol !== "https:") continue;
      links.push({ href: url.toString(), score });
    } catch {}
  }
  links.sort((a, b) => b.score - a.score);
  return [...new Set(links.map((link) => link.href))];
}

/** ドメインのサイトのアイコン。トップページの <link> を見て、無ければ /favicon.ico。 */
export async function fetchFavicon(
  deps: IconDeps,
  domain: string,
): Promise<Lookup> {
  try {
    for (const host of [domain, `www.${domain}`]) {
      const page = await deps.fetchBytes(`https://${host}/`, {
        maxBytes: MAX_HTML_BYTES,
        accept: "text/html",
      });
      const candidates = page
        ? findIconLinks(page.body.toString("utf8"), page.url).slice(0, 3)
        : [];
      const origin = page ? new URL(page.url).origin : `https://${host}`;
      candidates.push(`${origin}/favicon.ico`);
      for (const url of candidates) {
        const result = await deps.fetchBytes(url, {
          maxBytes: MAX_IMAGE_BYTES,
          accept: "image/*",
        });
        const image = result ? acceptImage(result.body) : null;
        if (image) return image;
      }
      if (page) return null;
    }
    return null;
  } catch {
    return "error";
  }
}

// ---------------------------------------------------------------------------
// キャッシュ付きの取得
// ---------------------------------------------------------------------------

export type SenderIconService = {
  /** 差出人のアドレスについて、sources の順に探し、最初に見つかったものを返す。 */
  find(address: string, sources: IconSource[]): Promise<FoundIcon | null>;
};

export function createSenderIconService(
  db: Database,
  deps: IconDeps,
  now: () => number = Date.now,
): SenderIconService {
  const inflight = new Map<string, Promise<IconImage | null>>();

  const load = async (
    key: string,
    fetcher: () => Promise<Lookup>,
    options: LookupOptions,
  ): Promise<IconImage | null> => {
    const [cached] = await db
      .select()
      .from(senderIcons)
      .where(eq(senderIcons.key, key));
    if (cached && cached.expiresAt.getTime() > now()) {
      return cached.contentType && cached.data
        ? { contentType: cached.contentType, data: cached.data }
        : null;
    }
    const result = await fetcher();
    const image = result === "error" ? null : result;
    const ttl =
      result === "error"
        ? ERROR_TTL_MS
        : image
          ? (options.foundTtl ?? FOUND_TTL_MS)
          : MISSING_TTL_MS;
    // 通信に失敗したときは、前に取れていた画像があればそれを使い続ける。
    if (
      result === "error" &&
      options.keepOnError !== false &&
      cached?.contentType &&
      cached.data
    ) {
      await db
        .update(senderIcons)
        .set({ expiresAt: new Date(now() + ttl) })
        .where(eq(senderIcons.key, key));
      return { contentType: cached.contentType, data: cached.data };
    }
    const values = {
      contentType: image?.contentType ?? null,
      data: image?.data ?? null,
      fetchedAt: new Date(now()),
      expiresAt: new Date(now() + ttl),
    };
    await db
      .insert(senderIcons)
      .values({ key, ...values })
      .onConflictDoUpdate({
        target: senderIcons.key,
        set: {
          contentType: sql`excluded.content_type`,
          data: sql`excluded.data`,
          fetchedAt: sql`excluded.fetched_at`,
          expiresAt: sql`excluded.expires_at`,
        },
      });
    return image;
  };

  const cachedLookup = (
    key: string,
    fetcher: () => Promise<Lookup>,
    options: LookupOptions = {},
  ) => {
    const running = inflight.get(key);
    if (running) return running;
    const promise = load(key, fetcher, options).finally(() =>
      inflight.delete(key),
    );
    inflight.set(key, promise);
    return promise;
  };

  return {
    async find(address, sources) {
      const domain = addressDomain(address);
      if (!domain) return null;
      for (const source of sources) {
        let image: IconImage | null = null;
        if (source === "bimi") {
          // 証明書を確かめるようにする前のキャッシュ (bimi:) は使わない。
          // 失効を早めに反映するため、覚える期間を短くし、確かめられないときは前のロゴも使わない。
          image = await cachedLookup(
            `bimi-mark:${domain}`,
            () => fetchBimi(deps, domain),
            { foundTtl: BIMI_FOUND_TTL_MS, keepOnError: false },
          );
        } else if (source === "gravatar") {
          const hash = gravatarHash(address);
          image = await cachedLookup(`gravatar:${hash}`, () =>
            fetchGravatar(deps, hash),
          );
        } else if (source === "favicon") {
          if (isPersonalMailDomain(domain)) continue;
          const org = organizationalDomain(domain);
          image = await cachedLookup(`favicon:${org}`, () =>
            fetchFavicon(deps, org),
          );
        }
        if (image) return { ...image, source };
      }
      return null;
    },
  };
}
