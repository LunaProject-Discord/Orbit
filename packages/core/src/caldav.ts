import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { Agent } from "undici";
import { isPrivateAddress, resolvesToPrivateAddress } from "./host-check.js";

/**
 * CalDAV (RFC 4791) と WebDAV の同期 (RFC 6578) の薄いクライアント。iCloud と一般の CalDAV サーバーで使う。
 * PROPFIND / REPORT / GET / PUT / DELETE だけを扱い、iCalendar の中身は扱わない
 * (読み取りは icalendar.ts、書き出しは icalendar-write.ts)。
 *
 * 利用者が入れた URL にサーバーが接続するので、すべての接続先 (リダイレクト先と、サーバーが返す href の先を含む)
 * について、内部ネットワークを指していないかを確かめる (allowPrivateHosts が true のときを除く)。
 * 名前解決は、接続のときにもう一度 (undici の Agent の connect.lookup で) 確かめ、その結果の IP に接続する
 * (検査と接続の間に名前の向き先を変える DNS rebinding を防ぐ)。
 * https で始めた接続は、http の URL (リダイレクト先、href) へは移らない (allowPrivateHosts のときを除く)。
 */

/** iCloud の CalDAV の起点。推測: Apple の公式資料では確かめられていない (広く使われている値)。 */
export const ICLOUD_CALDAV_URL = "https://caldav.icloud.com/";

const DAV = "DAV:";
const CALDAV = "urn:ietf:params:xml:ns:caldav";
const CALSERVER = "http://calendarserver.org/ns/";
const APPLE_ICAL = "http://apple.com/ns/ical/";

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 60_000;
/** 1 回の応答の大きさの上限。 */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const USER_AGENT = "Orbit-Calendar/1.0";

// ---------------------------------------------------------------------------
// XML (WebDAV の応答を読むための小さな読み取り。名前空間に対応する)

export type XmlElement = {
  /** 名前空間の URI (無ければ "")。 */
  ns: string;
  /** 接頭辞を除いた名前。 */
  local: string;
  /** 属性 (接頭辞を除いた名前 → 値)。名前空間の宣言は含めない。 */
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (match, body: string) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      return ENTITIES[body.toLowerCase()] ?? match;
    },
  );
}

export class CaldavXmlError extends Error {}

/** XML を読む。DTD と処理命令は読み飛ばす (外部実体は展開しない)。 */
export function parseXml(input: string): XmlElement {
  type Open = {
    element: XmlElement;
    qname: string;
    scope: Map<string, string>;
  };
  const rootHolder: XmlElement = {
    ns: "",
    local: "",
    attrs: {},
    children: [],
    text: "",
  };
  const stack: Open[] = [
    { element: rootHolder, qname: "", scope: new Map([["xml", "xml"]]) },
  ];
  let index = 0;
  const length = input.length;
  while (index < length) {
    const lt = input.indexOf("<", index);
    const top = stack[stack.length - 1] as Open;
    if (lt < 0) {
      top.element.text += decodeEntities(input.slice(index));
      break;
    }
    if (lt > index) top.element.text += decodeEntities(input.slice(index, lt));
    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      if (end < 0) throw new CaldavXmlError("コメントが閉じていません。");
      index = end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", lt)) {
      const end = input.indexOf("]]>", lt + 9);
      if (end < 0) throw new CaldavXmlError("CDATA が閉じていません。");
      top.element.text += input.slice(lt + 9, end);
      index = end + 3;
      continue;
    }
    if (input.startsWith("<?", lt)) {
      const end = input.indexOf("?>", lt + 2);
      if (end < 0) throw new CaldavXmlError("処理命令が閉じていません。");
      index = end + 2;
      continue;
    }
    if (input.startsWith("<!", lt)) {
      // DOCTYPE。中の [ ... ] も含めて読み飛ばす。
      let depth = 0;
      let cursor = lt + 2;
      for (; cursor < length; cursor++) {
        const char = input[cursor];
        if (char === "[") depth++;
        else if (char === "]") depth--;
        else if (char === ">" && depth <= 0) break;
      }
      index = cursor + 1;
      continue;
    }
    // タグの終わりを探す (属性値の中の > は飛ばす)。
    let cursor = lt + 1;
    let quote: string | null = null;
    for (; cursor < length; cursor++) {
      const char = input[cursor];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (cursor >= length) throw new CaldavXmlError("タグが閉じていません。");
    const body = input.slice(lt + 1, cursor);
    index = cursor + 1;
    if (body.startsWith("/")) {
      const qname = body.slice(1).trim();
      if (stack.length <= 1 || top.qname !== qname) {
        throw new CaldavXmlError(`閉じタグが合いません: ${qname}`);
      }
      stack.pop();
      continue;
    }
    const selfClosing = body.endsWith("/");
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameMatch = /^([^\s/>]+)/.exec(inner);
    if (!nameMatch?.[1]) throw new CaldavXmlError("タグ名がありません。");
    const qname = nameMatch[1];
    const scope = new Map(top.scope);
    const attrs: Record<string, string> = {};
    for (const attr of inner
      .slice(qname.length)
      .matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const name = attr[1] ?? "";
      const value = decodeEntities(attr[3] ?? attr[4] ?? "");
      if (name === "xmlns") scope.set("", value);
      else if (name.startsWith("xmlns:")) scope.set(name.slice(6), value);
      else attrs[name.slice(name.indexOf(":") + 1)] = value;
    }
    const colon = qname.indexOf(":");
    const prefix = colon >= 0 ? qname.slice(0, colon) : "";
    const local = colon >= 0 ? qname.slice(colon + 1) : qname;
    const element: XmlElement = {
      ns: scope.get(prefix) ?? "",
      local,
      attrs,
      children: [],
      text: "",
    };
    top.element.children.push(element);
    if (!selfClosing) stack.push({ element, qname, scope });
  }
  if (stack.length > 1) throw new CaldavXmlError("要素が閉じていません。");
  const root = rootHolder.children[0];
  if (!root) throw new CaldavXmlError("要素がありません。");
  return root;
}

function child(
  element: XmlElement | undefined,
  ns: string,
  local: string,
): XmlElement | undefined {
  return element?.children.find(
    (entry) => entry.ns === ns && entry.local === local,
  );
}

function childrenOf(
  element: XmlElement | undefined,
  ns: string,
  local: string,
): XmlElement[] {
  return (
    element?.children.filter(
      (entry) => entry.ns === ns && entry.local === local,
    ) ?? []
  );
}

function textOf(element: XmlElement | undefined): string | null {
  if (!element) return null;
  const value = element.text.trim();
  return value.length > 0 ? value : null;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** multistatus の 1 つの response。プロパティは 200 の propstat のものだけを持つ。 */
type DavResponse = {
  href: string;
  /** response 自体の status (sync-collection の 404 など)。無ければ null。 */
  status: number | null;
  props: XmlElement | null;
  /** 200 以外の propstat に入っていたプロパティ (local 名)。 */
  missing: Set<string>;
};

function statusCode(element: XmlElement | undefined): number | null {
  const value = textOf(element);
  const match = value && /^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(value);
  return match ? Number(match[1]) : null;
}

function parseMultistatus(xml: string): {
  responses: DavResponse[];
  syncToken: string | null;
} {
  const root = parseXml(xml);
  if (root.ns !== DAV || root.local !== "multistatus") {
    throw new CaldavXmlError("multistatus の応答ではありません。");
  }
  const responses: DavResponse[] = [];
  for (const response of childrenOf(root, DAV, "response")) {
    const status = statusCode(child(response, DAV, "status"));
    const props: XmlElement = {
      ns: DAV,
      local: "prop",
      attrs: {},
      children: [],
      text: "",
    };
    const missing = new Set<string>();
    for (const propstat of childrenOf(response, DAV, "propstat")) {
      const code = statusCode(child(propstat, DAV, "status"));
      const prop = child(propstat, DAV, "prop");
      if (code !== null && code >= 200 && code < 300) {
        props.children.push(...(prop?.children ?? []));
      } else {
        for (const entry of prop?.children ?? []) missing.add(entry.local);
      }
    }
    for (const href of childrenOf(response, DAV, "href")) {
      const value = textOf(href);
      if (!value) continue;
      responses.push({
        href: value,
        status,
        props: props.children.length > 0 ? props : null,
        missing,
      });
    }
  }
  return { responses, syncToken: textOf(child(root, DAV, "sync-token")) };
}

// ---------------------------------------------------------------------------
// エラー

/** 認証に失敗した (401)。パスワードの誤りなど。 */
export class CaldavAuthError extends Error {
  constructor(message = "CalDAV サーバーにログインできませんでした。") {
    super(message);
    this.name = "CaldavAuthError";
  }
}

/** 接続先が内部ネットワークを指している、または名前を解決できない。 */
export class CaldavHostError extends Error {
  readonly reason: "host_not_allowed" | "host_not_found" | "invalid_url";
  constructor(
    reason: "host_not_allowed" | "host_not_found" | "invalid_url",
    message: string,
  ) {
    super(message);
    this.name = "CaldavHostError";
    this.reason = reason;
  }
}

/** 想定外の HTTP の応答。retryAfterMs は 429 / 503 の Retry-After。 */
export class CaldavHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  constructor(status: number, message: string, retryAfterMs: number | null) {
    super(message);
    this.name = "CaldavHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** sync-collection の同期の位置が無効になった (RFC 6578 の valid-sync-token)。全件か比較で取り直す。 */
export class CaldavSyncTokenError extends Error {
  constructor() {
    super("同期の位置が無効になりました。");
    this.name = "CaldavSyncTokenError";
  }
}

/** Retry-After (秒か HTTP の日付) をミリ秒にする。 */
export function retryAfterMs(
  value: string | null,
  now = Date.now(),
): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

// ---------------------------------------------------------------------------
// クライアント

export type CaldavClientOptions = {
  username: string;
  password: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  /** 開発用。true なら内部ネットワークへの接続を許す (検査しない)。 */
  allowPrivateHosts?: boolean;
  /** 名前解決の差し替え (テスト用)。既定は resolvesToPrivateAddress。 */
  isPrivateHost?: (host: string) => Promise<boolean>;
  /** 1 回の応答の大きさの上限 (バイト、テスト用)。既定は 32 MiB。 */
  maxResponseBytes?: number;
};

export type CaldavResponse = {
  status: number;
  headers: Headers;
  body: string;
  /** リダイレクトの後の URL。 */
  url: string;
};

export type CaldavCalendar = {
  /** コレクションの URL (絶対 URL)。 */
  url: string;
  displayName: string | null;
  description: string | null;
  /** "#rrggbb"。 */
  color: string | null;
  /** calendar-timezone の VTIMEZONE の TZID。 */
  timeZone: string | null;
  ctag: string | null;
  syncToken: string | null;
  /** sync-collection の REPORT に対応している。 */
  supportsSyncCollection: boolean;
  /** 書き込みの権限が無い。 */
  readOnly: boolean;
  /** 予定 (VEVENT) を入れられる。supported-calendar-component-set が無ければ true。 */
  supportsEvents: boolean;
};

export type CaldavResourceRef = { href: string; etag: string | null };
export type CaldavResource = {
  href: string;
  etag: string | null;
  data: string;
};

export type CaldavPutResult =
  | { status: "ok"; etag: string | null }
  /** 412。If-Match / If-None-Match が合わなかった。 */
  | { status: "precondition_failed" }
  | { status: "not_found" }
  | { status: "rejected"; httpStatus: number; reason: string };

export type CaldavSyncResult = {
  changed: CaldavResourceRef[];
  removed: string[];
  syncToken: string | null;
};

/** URL を比べられる形にする (フラグメントを外す)。 */
function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.toString();
}

function withTrailingSlash(url: string): string {
  const parsed = new URL(url);
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed.toString();
}

/** 2 つの URL が同じパスを指すか (末尾の / とパーセントエンコードの違いを無視する)。 */
export function sameDavPath(a: string, b: string): boolean {
  const norm = (value: string) => {
    let path = value;
    try {
      path = decodeURIComponent(value);
    } catch {
      // そのまま比べる。
    }
    return path.replace(/\/+$/, "");
  };
  return norm(a) === norm(b);
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, "$1");
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;
type Resolver = (
  hostname: string,
  callback: (error: Error | null, addresses: LookupAddress[]) => void,
) => void;

const systemResolver: Resolver = (hostname, callback) =>
  dnsLookup(hostname, { all: true }, (error, addresses) =>
    callback(error, addresses ?? []),
  );

/**
 * 接続のときの名前解決 (net.connect の lookup の形)。解決した IP がひとつでも内部ネットワークなら
 * CaldavHostError で失敗させ、そうでなければその IP をそのまま接続に使わせる。
 */
export function createPinnedLookup(resolver: Resolver = systemResolver) {
  return (
    hostname: string,
    options: { all?: boolean; family?: number | string },
    callback: LookupCallback,
  ): void => {
    resolver(hostname, (error, resolved) => {
      if (error) {
        callback(error as NodeJS.ErrnoException, []);
        return;
      }
      const family =
        options.family === 4 || options.family === "IPv4"
          ? 4
          : options.family === 6 || options.family === "IPv6"
            ? 6
            : 0;
      const addresses = resolved.filter(
        (entry) => family === 0 || entry.family === family,
      );
      if (
        addresses.length === 0 ||
        addresses.some((entry) => isPrivateAddress(entry.address))
      ) {
        callback(
          new CaldavHostError(
            addresses.length === 0 ? "host_not_found" : "host_not_allowed",
            addresses.length === 0
              ? `ホスト (${hostname}) が見つかりません。`
              : `内部ネットワークのホスト (${hostname}) には接続できません。`,
          ) as unknown as NodeJS.ErrnoException,
          [],
        );
        return;
      }
      if (options.all) {
        callback(null, addresses);
        return;
      }
      const first = addresses[0] as LookupAddress;
      callback(null, first.address, first.family);
    });
  };
}

let pinnedAgent: Agent | null = null;

/** 接続のときに名前解決を確かめる dispatcher (プロセスで 1 つを使い回す)。 */
function pinnedDispatcher(): Agent {
  pinnedAgent ??= new Agent({ connect: { lookup: createPinnedLookup() } });
  return pinnedAgent;
}

/** fetch の失敗の原因をたどり、CaldavHostError があればそれを返す。 */
function hostErrorIn(error: unknown): CaldavHostError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current instanceof CaldavHostError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** 本文を上限まで読む。上限を超えたら読むのをやめて例外にする。 */
async function readLimited(response: Response, limit: number): Promise<string> {
  const tooLarge = () =>
    new CaldavHttpError(response.status, "応答が大きすぎます。", null);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > limit) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export class CaldavClient {
  private readonly fetchFn: typeof fetch;
  private readonly authorization: string;
  private readonly hostChecks = new Map<string, Promise<void>>();
  /**
   * 認証情報を送ってよいサイト (スキームとホスト。iCloud だけは icloud.com の下をまとめて 1 つ)。
   * 最初の接続先で決まる。
   */
  private trustedSite: string | null = null;
  /** 最初の接続先が https だった (http の URL へは移らない)。 */
  private secureOrigin: boolean | null = null;

  constructor(private readonly options: CaldavClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.authorization = `Basic ${Buffer.from(
      `${options.username}:${options.password}`,
      "utf8",
    ).toString("base64")}`;
  }

  /**
   * 認証情報を送る単位。スキームとホスト (ポートを含む) が同じものだけを同じとみなす。
   * iCloud は caldav.icloud.com から pNN-caldav.icloud.com へ移るので、icloud.com の下をまとめる。
   * (公開サフィックスの一覧は *.github.io のような私的なものを見ないので、一般には使わない。)
   */
  private siteOf(url: URL): string {
    const host = hostOf(url).toLowerCase();
    if (!isIP(host) && (host === "icloud.com" || host.endsWith(".icloud.com")))
      return `${url.protocol}//icloud.com`;
    return `${url.protocol}//${url.host.toLowerCase()}`;
  }

  /** https で始めた接続が http の URL へ移ろうとしていたら止める。 */
  private checkScheme(url: string): void {
    if (this.options.allowPrivateHosts) return;
    const protocol = new URL(url).protocol;
    if (this.secureOrigin === null) {
      this.secureOrigin = protocol === "https:";
      return;
    }
    if (this.secureOrigin && protocol !== "https:") {
      throw new CaldavHostError(
        "host_not_allowed",
        "https で始めた接続から http の URL には移れません。",
      );
    }
  }

  /** 接続先が内部ネットワークを指していないかを確かめる (ホストごとに 1 回)。 */
  async checkUrl(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new CaldavHostError("invalid_url", "URL が正しくありません。");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new CaldavHostError(
        "invalid_url",
        "http(s) の URL ではありません。",
      );
    }
    if (parsed.username || parsed.password) {
      throw new CaldavHostError(
        "invalid_url",
        "URL に認証情報を含められません。",
      );
    }
    if (this.options.allowPrivateHosts) return;
    const host = hostOf(parsed);
    let check = this.hostChecks.get(host);
    if (!check) {
      const isPrivate = this.options.isPrivateHost ?? resolvesToPrivateAddress;
      check = isPrivate(host).then(
        (value) => {
          if (value) {
            throw new CaldavHostError(
              "host_not_allowed",
              `内部ネットワークのホスト (${host}) には接続できません。`,
            );
          }
        },
        () => {
          throw new CaldavHostError(
            "host_not_found",
            `ホスト (${host}) が見つかりません。`,
          );
        },
      );
      this.hostChecks.set(host, check);
    }
    await check;
  }

  /**
   * 1 回のリクエスト。リダイレクトは自分で追い、行き先ごとに接続先を確かめる。
   * 認証情報は、最初の接続先と同じサイト (siteOf) にだけ送る。
   */
  async request(
    method: string,
    url: string,
    init: {
      headers?: Record<string, string>;
      body?: string;
      /** リダイレクトを追うか。PUT と DELETE は追わない (別の場所に書かないため)。 */
      followRedirects?: boolean;
    } = {},
  ): Promise<CaldavResponse> {
    const follow = init.followRedirects ?? true;
    let target = normalizeUrl(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await this.checkUrl(target);
      this.checkScheme(target);
      const parsed = new URL(target);
      const site = this.siteOf(parsed);
      if (this.trustedSite === null) this.trustedSite = site;
      const headers: Record<string, string> = {
        "user-agent": USER_AGENT,
        ...init.headers,
      };
      if (site === this.trustedSite) headers.authorization = this.authorization;
      const signals = [AbortSignal.timeout(TIMEOUT_MS)];
      if (this.options.signal) signals.push(this.options.signal);
      let response: Response;
      try {
        response = await this.fetchFn(target, {
          method,
          headers,
          body: init.body,
          redirect: "manual",
          signal: AbortSignal.any(signals),
          // 接続のときの名前解決も確かめる (fetch の型に dispatcher が無いので広げて渡す)。
          ...(this.options.allowPrivateHosts
            ? {}
            : { dispatcher: pinnedDispatcher() }),
        } as RequestInit);
      } catch (error) {
        throw hostErrorIn(error) ?? error;
      }
      if (
        follow &&
        [301, 302, 303, 307, 308].includes(response.status) &&
        response.headers.get("location")
      ) {
        await response.body?.cancel();
        target = normalizeUrl(
          new URL(
            response.headers.get("location") as string,
            target,
          ).toString(),
        );
        continue;
      }
      const body = await readLimited(
        response,
        this.options.maxResponseBytes ?? MAX_RESPONSE_BYTES,
      );
      if (response.status === 401) throw new CaldavAuthError();
      return {
        status: response.status,
        headers: response.headers,
        body,
        url: target,
      };
    }
    throw new CaldavHttpError(310, "リダイレクトが多すぎます。", null);
  }

  /** 2xx 以外を例外にする (401 は request が CaldavAuthError にする)。 */
  private fail(response: CaldavResponse, what: string): never {
    throw new CaldavHttpError(
      response.status,
      `${what}に失敗しました (HTTP ${response.status})。`,
      response.status === 429 || response.status === 503
        ? retryAfterMs(response.headers.get("retry-after"))
        : null,
    );
  }

  private async davRequest(
    method: "PROPFIND" | "REPORT",
    url: string,
    depth: "0" | "1",
    body: string,
    what: string,
  ) {
    const response = await this.request(method, url, {
      headers: {
        depth,
        "content-type": 'application/xml; charset="utf-8"',
        accept: "application/xml, text/xml",
      },
      body,
    });
    if (response.status !== 207) this.fail(response, what);
    return { response, ...parseMultistatus(response.body) };
  }

  /** サーバーが返した href を絶対 URL にし、接続先を確かめる。 */
  private async resolveHref(href: string, base: string): Promise<string> {
    const url = normalizeUrl(new URL(href, base).toString());
    await this.checkUrl(url);
    this.checkScheme(url);
    return url;
  }

  /**
   * 起点の URL からカレンダーのホーム (calendar-home-set) を探す (RFC 6764 / RFC 4791 の 6.2.1)。
   * 1. 起点のパスが空なら /.well-known/caldav を先に試す。
   * 2. current-user-principal を引く。無ければ起点そのものを principal とみなす。
   * 3. principal の calendar-home-set を引く。
   * 起点がカレンダーのコレクションそのものなら、calendarUrl に入れて返す。
   */
  async discover(startUrl: string): Promise<{
    principalUrl: string | null;
    homeUrls: string[];
    calendarUrl: string | null;
  }> {
    const start = normalizeUrl(startUrl);
    const candidates: string[] = [];
    if (new URL(start).pathname === "/") {
      candidates.push(new URL("/.well-known/caldav", start).toString());
    }
    candidates.push(start);
    const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="${CALDAV}">
  <d:prop><d:current-user-principal/><d:resourcetype/><c:calendar-home-set/></d:prop>
</d:propfind>`;
    let lastError: unknown = null;
    for (const candidate of candidates) {
      let result: Awaited<ReturnType<CaldavClient["davRequest"]>>;
      try {
        result = await this.davRequest(
          "PROPFIND",
          candidate,
          "0",
          body,
          "CalDAV の探索",
        );
      } catch (error) {
        if (
          error instanceof CaldavAuthError ||
          error instanceof CaldavHostError
        ) {
          throw error;
        }
        lastError = error;
        continue;
      }
      const base = result.response.url;
      const props = result.responses[0]?.props ?? null;
      const resourceType = child(props ?? undefined, DAV, "resourcetype");
      if (child(resourceType, CALDAV, "calendar")) {
        return { principalUrl: null, homeUrls: [], calendarUrl: base };
      }
      const homes = await this.homeSetOf(props, base);
      if (homes.length > 0) {
        return { principalUrl: base, homeUrls: homes, calendarUrl: null };
      }
      const principalHref = textOf(
        child(
          child(props ?? undefined, DAV, "current-user-principal"),
          DAV,
          "href",
        ),
      );
      const principalUrl = principalHref
        ? await this.resolveHref(principalHref, base)
        : base;
      const principal = await this.davRequest(
        "PROPFIND",
        principalUrl,
        "0",
        `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="${CALDAV}"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`,
        "カレンダーのホームの取得",
      );
      const homeUrls = await this.homeSetOf(
        principal.responses[0]?.props ?? null,
        principal.response.url,
      );
      if (homeUrls.length > 0) {
        return {
          principalUrl: principal.response.url,
          homeUrls,
          calendarUrl: null,
        };
      }
      lastError = new CaldavHttpError(
        404,
        "カレンダーのホームが見つかりませんでした。",
        null,
      );
    }
    throw lastError instanceof Error
      ? lastError
      : new CaldavHttpError(
          404,
          "CalDAV サーバーが見つかりませんでした。",
          null,
        );
  }

  private async homeSetOf(props: XmlElement | null, base: string) {
    const homes: string[] = [];
    for (const href of childrenOf(
      child(props ?? undefined, CALDAV, "calendar-home-set"),
      DAV,
      "href",
    )) {
      const value = textOf(href);
      if (value)
        homes.push(withTrailingSlash(await this.resolveHref(value, base)));
    }
    return homes;
  }

  /** カレンダーの属性 (PROPFIND の prop)。一覧とコレクション 1 つの取得で共通。 */
  private static readonly CALENDAR_PROPS =
    `<d:propfind xmlns:d="DAV:" xmlns:c="${CALDAV}" xmlns:cs="${CALSERVER}" xmlns:ic="${APPLE_ICAL}">
  <d:prop>
    <d:resourcetype/><d:displayname/><d:current-user-privilege-set/><d:supported-report-set/><d:sync-token/>
    <c:calendar-description/><c:calendar-timezone/><c:supported-calendar-component-set/>
    <cs:getctag/><ic:calendar-color/>
  </d:prop>
</d:propfind>`;

  /** ホームの下のカレンダー (resourcetype に calendar を持つコレクション) を並べる。 */
  async listCalendars(homeUrl: string): Promise<CaldavCalendar[]> {
    const result = await this.davRequest(
      "PROPFIND",
      homeUrl,
      "1",
      `<?xml version="1.0" encoding="utf-8"?>\n${CaldavClient.CALENDAR_PROPS}`,
      "カレンダーの一覧の取得",
    );
    const list: CaldavCalendar[] = [];
    for (const response of result.responses) {
      const calendar = await this.calendarOf(response, result.response.url);
      if (calendar) list.push(calendar);
    }
    return list;
  }

  /** コレクション 1 つの属性を取る (起点がカレンダーそのものだったとき)。 */
  async getCalendar(url: string): Promise<CaldavCalendar | null> {
    const result = await this.davRequest(
      "PROPFIND",
      url,
      "0",
      `<?xml version="1.0" encoding="utf-8"?>\n${CaldavClient.CALENDAR_PROPS}`,
      "カレンダーの取得",
    );
    const response = result.responses[0];
    return response ? this.calendarOf(response, result.response.url) : null;
  }

  private async calendarOf(
    response: DavResponse,
    base: string,
  ): Promise<CaldavCalendar | null> {
    const props = response.props ?? undefined;
    if (!child(child(props, DAV, "resourcetype"), CALDAV, "calendar"))
      return null;
    const url = withTrailingSlash(await this.resolveHref(response.href, base));
    const componentSet = child(
      props,
      CALDAV,
      "supported-calendar-component-set",
    );
    const components = childrenOf(componentSet, CALDAV, "comp").map(
      (comp) => comp.attrs.name?.toUpperCase() ?? "",
    );
    const supportsEvents =
      components.length === 0 || components.includes("VEVENT");
    const reports = child(props, DAV, "supported-report-set");
    const supportsSyncCollection = (reports?.children ?? []).some((supported) =>
      child(child(supported, DAV, "report"), DAV, "sync-collection"),
    );
    const privileges = child(props, DAV, "current-user-privilege-set");
    const readOnly = privileges
      ? !childrenOf(privileges, DAV, "privilege").some((privilege) =>
          privilege.children.some(
            (entry) =>
              entry.ns === DAV &&
              ["write", "write-content", "all", "bind"].includes(entry.local),
          ),
        )
      : false;
    const colorText = textOf(child(props, APPLE_ICAL, "calendar-color"));
    const colorMatch =
      colorText && /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(colorText);
    const timezoneText = textOf(child(props, CALDAV, "calendar-timezone"));
    const tzid =
      timezoneText && /^TZID[^:]*:(.+)$/m.exec(timezoneText.replace(/\r/g, ""));
    return {
      url,
      displayName: textOf(child(props, DAV, "displayname")),
      description: textOf(child(props, CALDAV, "calendar-description")),
      color: colorMatch ? `#${colorMatch[1]?.toLowerCase()}` : null,
      timeZone: tzid?.[1]?.trim() || null,
      ctag: textOf(child(props, CALSERVER, "getctag")),
      syncToken: textOf(child(props, DAV, "sync-token")),
      supportsSyncCollection,
      readOnly,
      supportsEvents,
    };
  }

  /** コレクションの getctag と sync-token を取る (変わっていなければ取り直さないため)。 */
  async getCollectionState(
    calendarUrl: string,
  ): Promise<{ ctag: string | null; syncToken: string | null }> {
    const result = await this.davRequest(
      "PROPFIND",
      calendarUrl,
      "0",
      `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="${CALSERVER}"><d:prop><cs:getctag/><d:sync-token/></d:prop></d:propfind>`,
      "カレンダーの状態の取得",
    );
    const props = result.responses[0]?.props ?? undefined;
    return {
      ctag: textOf(child(props, CALSERVER, "getctag")),
      syncToken: textOf(child(props, DAV, "sync-token")),
    };
  }

  /** href をコレクションの中の正しいものとして扱えるか (同じ接続元で、コレクションの下)。 */
  private memberHref(href: string, calendarUrl: string): string | null {
    const url = new URL(href, calendarUrl);
    const collection = new URL(calendarUrl);
    if (url.origin !== collection.origin) return null;
    if (sameDavPath(url.pathname, collection.pathname)) return null;
    return url.pathname;
  }

  /**
   * コレクションの予定のリソースの href と ETag を並べる (calendar-query で VEVENT に絞る)。
   * href はパス (/calendars/.../x.ics) で返す。コレクションの外の href は捨てる。
   */
  async listEtags(calendarUrl: string): Promise<CaldavResourceRef[]> {
    const result = await this.davRequest(
      "REPORT",
      calendarUrl,
      "1",
      `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="${CALDAV}">
  <d:prop><d:getetag/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter>
</c:calendar-query>`,
      "予定の一覧の取得",
    );
    const list: CaldavResourceRef[] = [];
    for (const response of result.responses) {
      if (response.status !== null && response.status !== 200) continue;
      const href = this.memberHref(response.href, calendarUrl);
      if (!href) continue;
      list.push({
        href,
        etag: textOf(child(response.props ?? undefined, DAV, "getetag")),
      });
    }
    return list;
  }

  /**
   * sync-collection (RFC 6578)。token が null なら全件。507 (切り詰め) なら、新しい token で続きを取る。
   * token が無効なら CaldavSyncTokenError。
   */
  async syncCollection(
    calendarUrl: string,
    token: string | null,
  ): Promise<CaldavSyncResult> {
    const changed = new Map<string, string | null>();
    const removed = new Set<string>();
    let current = token;
    for (let round = 0; round < 50; round++) {
      const response = await this.request("REPORT", calendarUrl, {
        headers: {
          depth: "0",
          "content-type": 'application/xml; charset="utf-8"',
          accept: "application/xml, text/xml",
        },
        body: `<?xml version="1.0" encoding="utf-8"?>
<d:sync-collection xmlns:d="DAV:">
  <d:sync-token>${current ? escapeXml(current) : ""}</d:sync-token>
  <d:sync-level>1</d:sync-level>
  <d:prop><d:getetag/></d:prop>
</d:sync-collection>`,
      });
      if (
        (response.status === 403 || response.status === 409) &&
        /valid-sync-token/.test(response.body)
      ) {
        throw new CaldavSyncTokenError();
      }
      if (response.status !== 207) this.fail(response, "差分の取得");
      const parsed = parseMultistatus(response.body);
      let truncated = false;
      for (const entry of parsed.responses) {
        const url = new URL(entry.href, calendarUrl);
        if (
          entry.status === 507 &&
          sameDavPath(url.pathname, new URL(calendarUrl).pathname)
        ) {
          truncated = true;
          continue;
        }
        const href = this.memberHref(entry.href, calendarUrl);
        if (!href) continue;
        if (entry.status === 404) {
          changed.delete(href);
          removed.add(href);
          continue;
        }
        removed.delete(href);
        changed.set(
          href,
          textOf(child(entry.props ?? undefined, DAV, "getetag")),
        );
      }
      current = parsed.syncToken ?? current;
      if (!truncated || parsed.syncToken === null) {
        return {
          changed: [...changed].map(([href, etag]) => ({ href, etag })),
          removed: [...removed],
          syncToken: current,
        };
      }
    }
    throw new CaldavHttpError(507, "差分の取得が終わりませんでした。", null);
  }

  /** calendar-multiget で、複数のリソースの中身をまとめて取る。無いリソースは結果に入らない。 */
  async multiget(
    calendarUrl: string,
    hrefs: readonly string[],
  ): Promise<CaldavResource[]> {
    if (hrefs.length === 0) return [];
    const result = await this.davRequest(
      "REPORT",
      calendarUrl,
      "1",
      `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-multiget xmlns:d="DAV:" xmlns:c="${CALDAV}">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
${hrefs.map((href) => `  <d:href>${escapeXml(href)}</d:href>`).join("\n")}
</c:calendar-multiget>`,
      "予定の取得",
    );
    const list: CaldavResource[] = [];
    for (const response of result.responses) {
      if (response.status !== null && response.status !== 200) continue;
      const href = this.memberHref(response.href, calendarUrl);
      const data = child(
        response.props ?? undefined,
        CALDAV,
        "calendar-data",
      )?.text;
      if (!href || !data) continue;
      list.push({
        href,
        etag: textOf(child(response.props ?? undefined, DAV, "getetag")),
        data,
      });
    }
    return list;
  }

  /**
   * サーバーが招待と返事を自分で送るか (RFC 6638 の calendar-auto-schedule) を調べる。
   * urls を順に OPTIONS で試し (カレンダーのコレクション、駄目ならホーム)、最初に答えた
   * URL の DAV ヘッダーで決める。どれも答えなければ false (参加者を足せない側に倒す)。
   * 認証の失敗 (CaldavAuthError) だけは投げる。
   */
  async supportsAutoSchedule(urls: readonly string[]): Promise<boolean> {
    for (const url of urls) {
      let response: CaldavResponse;
      try {
        response = await this.request("OPTIONS", url);
      } catch (error) {
        if (error instanceof CaldavAuthError) throw error;
        continue;
      }
      if (response.status < 200 || response.status >= 300) continue;
      return hasAutoSchedule(response.headers.get("dav"));
    }
    return false;
  }

  /** リソース 1 つを取る。無ければ null。 */
  async get(url: string): Promise<CaldavResource | null> {
    const response = await this.request("GET", url, {
      headers: { accept: "text/calendar" },
    });
    if (response.status === 404 || response.status === 410) return null;
    if (response.status !== 200) this.fail(response, "予定の取得");
    return {
      href: new URL(response.url).pathname,
      etag: response.headers.get("etag"),
      data: response.body,
    };
  }

  /**
   * リソースを書く。作成は ifNoneMatch: "*"、更新は ifMatch に ETag (存在だけ確かめるなら "*")。
   * 5xx と 429 は CaldavHttpError を投げる。
   */
  async put(
    url: string,
    data: string,
    conditions: { ifMatch?: string | null; ifNoneMatch?: "*" } = {},
  ): Promise<CaldavPutResult> {
    const headers: Record<string, string> = {
      "content-type": "text/calendar; charset=utf-8",
    };
    if (conditions.ifMatch) headers["if-match"] = conditions.ifMatch;
    if (conditions.ifNoneMatch)
      headers["if-none-match"] = conditions.ifNoneMatch;
    const response = await this.request("PUT", url, {
      headers,
      body: data,
      followRedirects: false,
    });
    return this.writeResult(response, "予定の書き込み");
  }

  /** リソースを消す。etag があれば If-Match を付ける。 */
  async delete(url: string, etag: string | null): Promise<CaldavPutResult> {
    const response = await this.request("DELETE", url, {
      headers: etag ? { "if-match": etag } : {},
      followRedirects: false,
    });
    return this.writeResult(response, "予定の削除");
  }

  private writeResult(response: CaldavResponse, what: string): CaldavPutResult {
    const status = response.status;
    if (status >= 200 && status < 300) {
      return { status: "ok", etag: response.headers.get("etag") };
    }
    if (status === 412) return { status: "precondition_failed" };
    if (status === 404 || status === 410) return { status: "not_found" };
    if (status === 429 || status >= 500 || status === 408)
      this.fail(response, what);
    return {
      status: "rejected",
      httpStatus: status,
      reason: `${what}を断られました (HTTP ${status}${preconditionOf(response.body)})。`,
    };
  }
}

/**
 * OPTIONS の DAV ヘッダー ("1, 2, access-control, calendar-access, calendar-auto-schedule" の形)
 * に calendar-auto-schedule があるか。大文字と小文字は区別しない。
 */
export function hasAutoSchedule(dav: string | null): boolean {
  if (!dav) return false;
  return dav
    .split(",")
    .some((token) => token.trim().toLowerCase() === "calendar-auto-schedule");
}

/** エラーの応答の本文にある CalDAV の前提条件の名前 (valid-calendar-data など)。 */
function preconditionOf(body: string): string {
  if (!body) return "";
  try {
    const root = parseXml(body);
    if (root.ns === DAV && root.local === "error" && root.children[0]) {
      return `、${root.children[0].local}`;
    }
  } catch {
    // 本文が XML でなければ付けない。
  }
  return "";
}
