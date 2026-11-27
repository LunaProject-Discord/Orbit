import { resolveMx, resolveSrv } from "node:dns/promises";
import { isIP } from "node:net";
import { resolvesToPrivateAddress } from "@orbit/core";
import { XMLParser } from "fast-xml-parser";

/**
 * メールアドレスのドメインから、受信 (IMAP、無ければ POP3) と送信 (SMTP) の設定を自動で見つける。
 * Thunderbird と同じ順で、次の場所を調べる。
 *
 * 1. よく使われるサービス (Gmail、iCloud、Outlook.com) の決まった設定
 * 2. https://autoconfig.<ドメイン>/mail/config-v1.1.xml (Thunderbird 形式)
 * 3. https://<ドメイン>/.well-known/autoconfig/mail/config-v1.1.xml
 * 4. Mozilla の ISPDB (https://autoconfig.thunderbird.net/v1.1/<ドメイン>)
 * 5. MX レコードの指すドメインで 2 と 4 (Google Workspace や Microsoft 365 の独自ドメイン)
 * 6. https://autodiscover.<ドメイン>/autodiscover/autodiscover.xml と
 *    https://<ドメイン>/autodiscover/autodiscover.xml (Outlook 形式)
 * 7. SRV レコード (RFC 6186 / 8314 の _imaps._tcp、_pop3s._tcp、_submission._tcp など)
 *
 * どれも並べて同時に問い合わせ、上の順で最初に見つかったものを使う。
 * パスワードはどこにも送らない (Outlook 形式の問い合わせでも認証は付けない)。
 */

export type Security = "ssl" | "starttls" | "plain";

/** 設定ファイルが求める認証の方式。password は通常のパスワード認証。 */
export type AuthMethod = "password" | "oauth2" | "other";

export type DiscoveredServer = {
  host: string;
  port: number;
  security: Security;
  username: string;
  auth: AuthMethod;
};

export type DiscoverySource =
  | "preset"
  | "autoconfig"
  | "well-known"
  | "ispdb"
  | "mx"
  | "autodiscover"
  | "srv";

/** 受信の方式。IMAP が使えるサービスでは IMAP を選び、POP3 しかないときだけ pop3 にする。 */
export type IncomingProtocol = "imap" | "pop3";

/** 見つかった受信と送信の接続先。imap は受信の接続先で、POP3 のときもここに入る。 */
export type FoundServers = {
  imap: DiscoveredServer;
  smtp: DiscoveredServer;
  incomingProtocol: IncomingProtocol;
};

export type DiscoveredSettings = {
  source: DiscoverySource;
  /** 見つかった接続先のサービス。gmail と microsoft は、それぞれのログインを勧める。 */
  provider: "gmail" | "microsoft" | "icloud" | "generic";
} & FoundServers;

export type SrvRecord = {
  name: string;
  port: number;
  priority: number;
  weight: number;
};

export type DiscoveryDeps = {
  /**
   * HTTPS で取得した本文を返す。見つからない、または取得できなければ null。
   * 内部ネットワークへの接続を断るのもここの役目。
   */
  fetchText: (
    url: string,
    init?: { method: "POST"; body: string; contentType: string },
  ) => Promise<string | null>;
  /** MX レコードのホスト名を、優先度の高い順に返す。 */
  resolveMx: (domain: string) => Promise<string[]>;
  resolveSrv: (name: string) => Promise<SrvRecord[]>;
};

const PRESET_DOMAINS: Record<string, "gmail" | "icloud" | "microsoft"> = {
  "gmail.com": "gmail",
  "googlemail.com": "gmail",
  "icloud.com": "icloud",
  "me.com": "icloud",
  "mac.com": "icloud",
  "outlook.com": "microsoft",
  "outlook.jp": "microsoft",
  "hotmail.com": "microsoft",
  "hotmail.co.jp": "microsoft",
  "live.com": "microsoft",
  "live.jp": "microsoft",
  "msn.com": "microsoft",
};

const PRESETS = {
  gmail: {
    imap: { host: "imap.gmail.com", port: 993, security: "ssl" },
    smtp: { host: "smtp.gmail.com", port: 465, security: "ssl" },
    auth: "oauth2",
  },
  icloud: {
    imap: { host: "imap.mail.me.com", port: 993, security: "ssl" },
    smtp: { host: "smtp.mail.me.com", port: 587, security: "starttls" },
    auth: "password",
  },
  microsoft: {
    imap: { host: "outlook.office365.com", port: 993, security: "ssl" },
    smtp: { host: "smtp.office365.com", port: 587, security: "starttls" },
    auth: "oauth2",
  },
} as const;

/** 接続先のホスト名からサービスを判別する。 */
export function providerOfHost(host: string): DiscoveredSettings["provider"] {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name === "imap.gmail.com" || name === "imap.googlemail.com") {
    return "gmail";
  }
  if (name === "imap.mail.me.com") return "icloud";
  if (
    name === "outlook.office365.com" ||
    name === "imap-mail.outlook.com" ||
    name === "outlook.office.com"
  ) {
    return "microsoft";
  }
  return "generic";
}

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i;

/** メールアドレスのドメイン部分。ホスト名として使えなければ null。 */
export function domainOfEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (isIP(domain) || !HOSTNAME.test(domain)) return null;
  return domain;
}

/** 2 階層の公開サフィックス (co.jp など) をおおまかに見分けるための第 2 レベル。 */
const SECOND_LEVELS = new Set([
  "ac",
  "ad",
  "co",
  "com",
  "ed",
  "edu",
  "go",
  "gov",
  "gr",
  "lg",
  "ne",
  "net",
  "or",
  "org",
]);

/**
 * MX のホスト名から、そのサービスのドメインを取り出す (aspmx.l.google.com → google.com)。
 * 公開サフィックスの一覧は持たないので、2 文字の国別ドメインの co.jp などだけを見分ける。
 */
export function baseDomainOf(host: string): string | null {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length < 2) return null;
  const tld = labels.at(-1) ?? "";
  const second = labels.at(-2) ?? "";
  const count =
    tld.length === 2 && SECOND_LEVELS.has(second) && labels.length >= 3 ? 3 : 2;
  return labels.slice(-count).join(".");
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
});

type XmlNode = Record<string, unknown>;

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in value) {
    return text((value as XmlNode)["#text"]);
  }
  return null;
}

function parseXml(body: string): XmlNode | null {
  try {
    const parsed = parser.parse(body) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as XmlNode) : null;
  } catch {
    return null;
  }
}

function fillPlaceholders(template: string, email: string): string {
  const at = email.lastIndexOf("@");
  return template
    .replaceAll("%EMAILADDRESS%", email)
    .replaceAll("%EMAILLOCALPART%", email.slice(0, at))
    .replaceAll("%EMAILDOMAIN%", email.slice(at + 1));
}

function validServer(host: string | null, port: number): host is string {
  return (
    host !== null &&
    HOSTNAME.test(host) &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535
  );
}

const SECURITY_RANK: Record<Security, number> = {
  ssl: 0,
  starttls: 1,
  plain: 2,
};
const AUTH_RANK: Record<AuthMethod, number> = {
  password: 0,
  oauth2: 1,
  other: 2,
};

/** パスワードで使えるもの、暗号化の強いものを先に。同じなら設定ファイルの順。 */
function pickBest(servers: DiscoveredServer[]): DiscoveredServer | null {
  const sorted = servers
    .map((server, index) => ({ server, index }))
    .sort(
      (a, b) =>
        AUTH_RANK[a.server.auth] - AUTH_RANK[b.server.auth] ||
        SECURITY_RANK[a.server.security] - SECURITY_RANK[b.server.security] ||
        a.index - b.index,
    );
  return sorted[0]?.server ?? null;
}

function authOfThunderbird(values: unknown[]): AuthMethod {
  const methods = values.map((value) => text(value)?.toLowerCase() ?? "");
  if (methods.length === 0) return "password";
  if (
    methods.some((method) =>
      ["password-cleartext", "password-encrypted", "plain", "secure"].includes(
        method,
      ),
    )
  ) {
    return "password";
  }
  if (methods.includes("oauth2")) return "oauth2";
  return "other";
}

function securityOfSocketType(value: string | null): Security | null {
  switch (value?.toUpperCase()) {
    case "SSL":
      return "ssl";
    case "STARTTLS":
      return "starttls";
    case "PLAIN":
      return "plain";
    default:
      return null;
  }
}

/** Thunderbird 形式 (config-v1.1.xml) の設定を読む。 */
export function parseThunderbirdConfig(
  body: string,
  email: string,
): FoundServers | null {
  const root = parseXml(body)?.clientConfig as XmlNode | undefined;
  if (!root || typeof root !== "object") return null;
  const imaps: DiscoveredServer[] = [];
  const pops: DiscoveredServer[] = [];
  const smtps: DiscoveredServer[] = [];
  for (const provider of asArray(root.emailProvider)) {
    if (!provider || typeof provider !== "object") continue;
    const node = provider as XmlNode;
    for (const [key, list, type] of [
      ["incomingServer", imaps, "imap"],
      ["incomingServer", pops, "pop3"],
      ["outgoingServer", smtps, "smtp"],
    ] as const) {
      for (const item of asArray(node[key])) {
        if (!item || typeof item !== "object") continue;
        const server = item as XmlNode;
        if (String(server["@_type"] ?? "").toLowerCase() !== type) continue;
        const rawHost = text(server.hostname);
        const host = rawHost
          ? fillPlaceholders(rawHost, email).toLowerCase()
          : null;
        const port = Number(text(server.port));
        const security = securityOfSocketType(text(server.socketType));
        if (!validServer(host, port) || !security) continue;
        const username = text(server.username);
        list.push({
          host,
          port,
          security,
          username: username ? fillPlaceholders(username, email) : email,
          auth: authOfThunderbird(asArray(server.authentication)),
        });
      }
    }
  }
  return combine(imaps, pops, smtps);
}

/**
 * 受信と送信の候補から、使う接続先を選ぶ。受信は IMAP を優先し (フォルダや既読を
 * どの端末とも合わせられる)、IMAP が無いときだけ POP3 を使う。
 */
function combine(
  imaps: DiscoveredServer[],
  pops: DiscoveredServer[],
  smtps: DiscoveredServer[],
): FoundServers | null {
  const smtp = pickBest(smtps);
  if (!smtp) return null;
  const imap = pickBest(imaps);
  if (imap) return { imap, smtp, incomingProtocol: "imap" };
  const pop = pickBest(pops);
  return pop ? { imap: pop, smtp, incomingProtocol: "pop3" } : null;
}

export type AutodiscoverResult =
  | ({ kind: "settings" } & FoundServers)
  | { kind: "redirectUrl"; url: string }
  | { kind: "redirectAddr"; email: string };

/** Outlook 形式 (Autodiscover の POX) の応答を読む。 */
export function parseAutodiscover(
  body: string,
  email: string,
): AutodiscoverResult | null {
  const account = (
    (parseXml(body)?.Autodiscover as XmlNode | undefined)?.Response as
      | XmlNode
      | undefined
  )?.Account as XmlNode | undefined;
  if (!account || typeof account !== "object") return null;
  const action = text(account.Action)?.toLowerCase();
  if (action === "redirecturl") {
    const url = text(account.RedirectUrl);
    return url ? { kind: "redirectUrl", url } : null;
  }
  if (action === "redirectaddr") {
    const address = text(account.RedirectAddr);
    return address ? { kind: "redirectAddr", email: address } : null;
  }
  const imaps: DiscoveredServer[] = [];
  const pops: DiscoveredServer[] = [];
  const smtps: DiscoveredServer[] = [];
  for (const item of asArray(account.Protocol)) {
    if (!item || typeof item !== "object") continue;
    const protocol = item as XmlNode;
    const type = text(protocol.Type)?.toUpperCase();
    const list =
      type === "IMAP"
        ? imaps
        : type === "POP3"
          ? pops
          : type === "SMTP"
            ? smtps
            : null;
    if (!list) continue;
    const host = text(protocol.Server)?.toLowerCase() ?? null;
    const port = Number(text(protocol.Port));
    if (!validServer(host, port)) continue;
    const encryption = text(protocol.Encryption)?.toUpperCase();
    const ssl = text(protocol.SSL)?.toLowerCase() !== "off";
    // Encryption があればそれに従う (SSL は最初から TLS、TLS は STARTTLS)。
    // 無ければ SSL の on / off とよく使われるポート番号から決める。
    const security: Security =
      encryption === "SSL"
        ? "ssl"
        : encryption === "TLS"
          ? "starttls"
          : encryption === "NONE"
            ? "plain"
            : !ssl
              ? "plain"
              : port === 993 || port === 995 || port === 465
                ? "ssl"
                : "starttls";
    list.push({
      host,
      port,
      security,
      username: text(protocol.LoginName) ?? email,
      auth: "password",
    });
  }
  const found = combine(imaps, pops, smtps);
  return found ? { kind: "settings", ...found } : null;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function autodiscoverRequest(email: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006">
  <Request>
    <EMailAddress>${escapeXml(email)}</EMailAddress>
    <AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema>
  </Request>
</Autodiscover>`;
}

function srvSorted(records: SrvRecord[]): SrvRecord[] {
  return [...records]
    .filter((record) => record.name && record.name !== ".")
    .sort((a, b) => a.priority - b.priority || b.weight - a.weight);
}

async function firstSrv(
  deps: DiscoveryDeps,
  names: [string, Security][],
): Promise<{ host: string; port: number; security: Security } | null> {
  const results = await Promise.all(
    names.map(async ([name, security]) => {
      const records = srvSorted(await deps.resolveSrv(name).catch(() => []));
      const record = records[0];
      if (!record) return null;
      const host = record.name.toLowerCase().replace(/\.$/, "");
      return validServer(host, record.port)
        ? { host, port: record.port, security }
        : null;
    }),
  );
  return results.find((result) => result !== null) ?? null;
}

/** RFC 6186 の SRV レコードから設定を作る。 */
async function discoverSrv(
  domain: string,
  email: string,
  deps: DiscoveryDeps,
): Promise<FoundServers | null> {
  const [imap, pop, smtp] = await Promise.all([
    firstSrv(deps, [
      [`_imaps._tcp.${domain}`, "ssl"],
      [`_imap._tcp.${domain}`, "starttls"],
    ]),
    firstSrv(deps, [
      [`_pop3s._tcp.${domain}`, "ssl"],
      [`_pop3._tcp.${domain}`, "starttls"],
    ]),
    firstSrv(deps, [
      [`_submissions._tcp.${domain}`, "ssl"],
      [`_submission._tcp.${domain}`, "starttls"],
    ]),
  ]);
  const incoming = imap ?? pop;
  if (!incoming || !smtp) return null;
  return {
    imap: { ...incoming, username: email, auth: "password" },
    smtp: { ...smtp, username: email, auth: "password" },
    incomingProtocol: imap ? "imap" : "pop3",
  };
}

async function discoverThunderbird(
  url: string,
  email: string,
  deps: DiscoveryDeps,
) {
  const body = await deps.fetchText(url).catch(() => null);
  return body ? parseThunderbirdConfig(body, email) : null;
}

async function discoverAutodiscover(
  domain: string,
  email: string,
  deps: DiscoveryDeps,
): Promise<FoundServers | null> {
  const post = (url: string, address: string) =>
    deps
      .fetchText(url, {
        method: "POST",
        body: autodiscoverRequest(address),
        contentType: "text/xml; charset=utf-8",
      })
      .catch(() => null);
  const urls = [
    `https://autodiscover.${domain}/autodiscover/autodiscover.xml`,
    `https://${domain}/autodiscover/autodiscover.xml`,
  ];
  for (const url of urls) {
    let address = email;
    let target = url;
    // 転送先の案内は 2 回までたどる。
    for (let hop = 0; hop < 3; hop++) {
      const body = await post(target, address);
      const result = body ? parseAutodiscover(body, address) : null;
      if (!result) break;
      if (result.kind === "settings") {
        const { kind: _, ...found } = result;
        return found;
      }
      if (result.kind === "redirectUrl") {
        if (!result.url.startsWith("https://")) break;
        target = result.url;
      } else {
        // 別のアドレスとして問い合わせ直す。ドメインが変わっても同じ URL へ送る。
        if (!domainOfEmail(result.email)) break;
        address = result.email;
      }
    }
  }
  return null;
}

function withProvider(
  source: DiscoverySource,
  found: FoundServers,
): DiscoveredSettings {
  return {
    source,
    // POP3 で受け取るなら、どのサービスでも汎用のアカウントとして扱う。
    provider:
      found.incomingProtocol === "pop3"
        ? "generic"
        : providerOfHost(found.imap.host),
    ...found,
  };
}

function presetFor(
  provider: "gmail" | "icloud" | "microsoft",
  email: string,
): DiscoveredSettings {
  const preset = PRESETS[provider];
  return {
    source: "preset",
    provider,
    imap: { ...preset.imap, username: email, auth: preset.auth },
    smtp: { ...preset.smtp, username: email, auth: preset.auth },
    incomingProtocol: "imap",
  };
}

/**
 * 設定を探す。deadlineMs を過ぎたら、それまでに見つかったもののうち優先度の高いものを返す
 * (応答の遅いサーバーを待ち続けない)。
 */
export async function discoverMailSettings(
  email: string,
  deps: DiscoveryDeps,
  { deadlineMs = 12_000 }: { deadlineMs?: number } = {},
): Promise<DiscoveredSettings | null> {
  const domain = domainOfEmail(email);
  if (!domain) return null;
  const preset = PRESET_DOMAINS[domain];
  if (preset) return presetFor(preset, email);

  const encodedEmail = encodeURIComponent(email);
  const ispdb = (name: string) =>
    discoverThunderbird(
      `https://autoconfig.thunderbird.net/v1.1/${name}`,
      email,
      deps,
    );

  // すべて同時に始め、優先順に結果を待つ。
  const candidates: [DiscoverySource, Promise<DiscoveredSettings | null>][] = [
    [
      "autoconfig",
      discoverThunderbird(
        `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodedEmail}`,
        email,
        deps,
      ).then((found) => found && withProvider("autoconfig", found)),
    ],
    [
      "well-known",
      discoverThunderbird(
        `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${encodedEmail}`,
        email,
        deps,
      ).then((found) => found && withProvider("well-known", found)),
    ],
    [
      "ispdb",
      ispdb(domain).then((found) => found && withProvider("ispdb", found)),
    ],
    [
      "mx",
      (async () => {
        const hosts = await deps.resolveMx(domain).catch(() => []);
        const base = hosts[0] ? baseDomainOf(hosts[0]) : null;
        if (!base || base === domain) return null;
        const known = PRESET_DOMAINS[base];
        // Google Workspace の MX は google.com、Microsoft 365 は outlook.com を指す。
        if (known === "gmail" || base === "google.com") {
          return { ...presetFor("gmail", email), source: "mx" as const };
        }
        if (known === "microsoft") {
          return { ...presetFor("microsoft", email), source: "mx" as const };
        }
        const found =
          (await ispdb(base)) ??
          (await discoverThunderbird(
            `https://autoconfig.${base}/mail/config-v1.1.xml?emailaddress=${encodedEmail}`,
            email,
            deps,
          ));
        return found && withProvider("mx", found);
      })(),
    ],
    [
      "autodiscover",
      discoverAutodiscover(domain, email, deps).then(
        (found) => found && withProvider("autodiscover", found),
      ),
    ],
    [
      "srv",
      discoverSrv(domain, email, deps).then(
        (found) => found && withProvider("srv", found),
      ),
    ],
  ];
  const settled = candidates.map(([, promise]) => {
    const state: { done: boolean; value: DiscoveredSettings | null } = {
      done: false,
      value: null,
    };
    const wait = promise
      .catch(() => null)
      .then((value) => {
        state.done = true;
        state.value = value;
        return value;
      });
    return { state, wait };
  });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), deadlineMs);
  });
  try {
    for (const { wait } of settled) {
      const found = await Promise.race([wait, deadline]);
      if (found === "deadline") break;
      if (found) return found;
    }
  } finally {
    clearTimeout(timer);
  }
  // 期限を過ぎた。上位の問い合わせが終わっていなくても、終わったものの中から選ぶ。
  return (
    settled.find(({ state }) => state.done && state.value)?.state.value ?? null
  );
}

const MAX_BODY_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;

/**
 * 実際の HTTPS 取得。allowPrivate が false なら、内部ネットワークを指すホストには
 * 接続しない (転送先も確かめる)。名前解決の結果は接続時に変わりうるので、完全な防御ではない。
 */
export function createFetchText({
  allowPrivate,
  timeoutMs = 8_000,
  fetchImpl = fetch,
}: {
  allowPrivate: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): DiscoveryDeps["fetchText"] {
  return async (url, init) => {
    const signal = AbortSignal.timeout(timeoutMs);
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const parsed = new URL(target);
      if (parsed.protocol !== "https:") return null;
      if (!allowPrivate) {
        const isPrivate = await resolvesToPrivateAddress(parsed.hostname).catch(
          () => null,
        );
        // 名前が引けない、または内部を指すホストには問い合わせない。
        if (isPrivate !== false) return null;
      }
      const response = await fetchImpl(target, {
        method: init?.method ?? "GET",
        headers: {
          accept: "application/xml, text/xml",
          ...(init ? { "content-type": init.contentType } : {}),
        },
        body: init?.body,
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
      if (length > MAX_BODY_BYTES) {
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
        if (total > MAX_BODY_BYTES) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString("utf8");
    }
    return null;
  };
}

export function defaultDiscoveryDeps(allowPrivate: boolean): DiscoveryDeps {
  return {
    fetchText: createFetchText({ allowPrivate }),
    resolveMx: async (domain) =>
      (await resolveMx(domain))
        .sort((a, b) => a.priority - b.priority)
        .map((record) => record.exchange),
    resolveSrv: (name) => resolveSrv(name),
  };
}
