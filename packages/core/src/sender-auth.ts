import { getDomain, parse } from "tldts";

/**
 * 送信元の認証 (SPF・DKIM・DMARC) の結果と、なりすましの疑いの判定。
 *
 * 結果は、つなぎ先のメールサーバー (Gmail なら mx.google.com) がメールに付けた
 * Authentication-Results ヘッダー (RFC 8601) を読むだけで、Orbit 自身は検証しない。
 * 差出人もこのヘッダーを書けるので、アカウントごとに「信頼する判定サーバーの名前 (authserv-id)」
 * を決め (authTrustRules)、その名前のヘッダーだけを使う (selectAuthResults)。
 */

/** 認証の 1 つの方式 (SPF など) の結果。 */
export type AuthMethodResult = {
  /** pass / fail / softfail / neutral / none / temperror / permerror など (小文字)。 */
  result: string;
  /** 確認したドメイン (SPF は smtp.mailfrom、DKIM は header.d、DMARC は header.from)。 */
  domain: string | null;
};

/** メールサーバーが付けた認証結果。 */
export type AuthResults = {
  /** 判定したサーバー (Authentication-Results の先頭の名前)。省かれていれば空。 */
  authservId: string;
  spf: AuthMethodResult | null;
  /** DKIM の署名ごとの結果 (署名が複数あれば複数)。 */
  dkim: AuthMethodResult[];
  dmarc: AuthMethodResult | null;
  /** Microsoft 365 / Outlook.com の総合判定 (compauth)。無ければ null。 */
  compauth: AuthMethodResult | null;
};

/** 差出人について画面に出す注意。 */
export type SenderWarning =
  /** DMARC に不合格 (送信元のドメインが認めていない送り方)。 */
  | "dmarc_fail"
  /** DMARC の結果は無いが、SPF に失敗し DKIM にも合格していない。 */
  | "auth_fail"
  /** 表示名に書かれた会社名やアドレスと、実際のアドレスのドメインが違う。 */
  | "name_mismatch";

/** 一覧と詳細で使う、差出人の確認結果。 */
export type SenderCheck = {
  /** DMARC に合格し、合格したドメインが差出人のアドレスのドメインと一致している。 */
  verified: boolean;
  warnings: SenderWarning[];
  /** name_mismatch のとき、表示名から読み取った相手 (「Amazon」や「example.com」)。 */
  claimed: string | null;
  /**
   * 判定の決まりの版 (SENDER_CHECK_VERSION)。信頼する判定サーバーとの照合を入れる前に
   * 保存した結果には無い。版が古い結果は使わず、まだ確認していないもの (null) として扱う。
   */
  version?: number;
};

/**
 * 判定の決まりの版。2 = 信頼する判定サーバー (authserv-id) のヘッダーだけを使う。
 * これより古い保存済みの結果 (差出人が書いた偽のヘッダーを拾っていたかもしれない) は、
 * 画面・招待の判定では「確認中」として扱い、開いたときや一覧に見えたときに取り直す。
 */
export const SENDER_CHECK_VERSION = 2;

/** 保存済みの確認結果が、いまの決まりで作ったものか。 */
export function isCurrentSenderCheck(
  check: SenderCheck | null | undefined,
): check is SenderCheck {
  return !!check && check.version === SENDER_CHECK_VERSION;
}

const MAX_HEADER = 8000;
const MAX_TOKEN = 255;

/** ( ) で囲んだコメントを取り除く (入れ子と、引用符の中のかっこに対応)。 */
function stripComments(value: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      if (depth === 0) out += ch + value[i + 1];
      i++;
      continue;
    }
    if (depth === 0 && ch === '"') quoted = !quoted;
    if (!quoted && ch === "(") {
      depth++;
      continue;
    }
    if (!quoted && ch === ")" && depth > 0) {
      depth--;
      // コメントは区切りとして扱う (前後の語がくっつかないように)。
      if (depth === 0) out += " ";
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

/** 引用符の外にある ; で区切る。 */
function splitStatements(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (ch === ";" && !quoted) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return trimmed;
}

/** ドメインらしい値だけを小文字で返す (アドレスなら @ の後ろ)。 */
function domainOf(value: string | undefined): string | null {
  if (!value) return null;
  const raw = unquote(value).toLowerCase();
  const host = raw.includes("@") ? raw.slice(raw.lastIndexOf("@") + 1) : raw;
  const cleaned = host.replace(/\.$/, "");
  if (!cleaned || cleaned.length > MAX_TOKEN) return null;
  if (!/^[a-z0-9.-]+$/.test(cleaned) || !cleaned.includes(".")) return null;
  return cleaned;
}

type Statement = { method: string; result: string; props: Map<string, string> };

/** 「dkim=pass header.d=example.com header.s=sel」の形の 1 文を読む。 */
function parseStatement(text: string): Statement | null {
  const tokens = text.match(/(?:[^\s"]+|"(?:[^"\\]|\\.)*")+/g) ?? [];
  const head = tokens[0];
  if (!head) return null;
  const eq = head.indexOf("=");
  if (eq <= 0) return null;
  // 「dkim/1=pass」のように版が付くことがある。
  const method = head.slice(0, eq).split("/")[0]?.toLowerCase() ?? "";
  const result = head
    .slice(eq + 1)
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (!method || !result) return null;
  const props = new Map<string, string>();
  for (const token of tokens.slice(1)) {
    const at = token.indexOf("=");
    if (at <= 0) continue;
    const key = token.slice(0, at).toLowerCase();
    if (!props.has(key)) props.set(key, token.slice(at + 1));
  }
  return { method, result, props };
}

/**
 * Authentication-Results ヘッダーの値を読む。読めなければ null。
 * 同じヘッダーが複数あるときは、いちばん上 (最後に受け取ったサーバーが付けたもの) を渡す。
 */
export function parseAuthenticationResults(
  value: string | null | undefined,
): AuthResults | null {
  if (!value) return null;
  const text = stripComments(value.slice(0, MAX_HEADER).replace(/\s+/g, " "));
  const statements = splitStatements(text);
  const first = statements[0];
  if (!first) return null;
  // 先頭は「判定したサーバー [版]」。Microsoft 365 / Outlook.com はこれを省き、
  // いきなり「spf=pass ...」で始めるので、その場合は判定したサーバーを空にする。
  const head = unquote(first.split(" ")[0] ?? "").toLowerCase();
  const omitted = /^[a-z][a-z0-9-]*(\/\d+)?=/.test(head);
  const authservId = omitted ? "" : head;
  if ((!omitted && !authservId) || authservId.length > MAX_TOKEN) return null;
  const rest = omitted ? statements : statements.slice(1);
  const results: AuthResults = {
    authservId,
    spf: null,
    dkim: [],
    dmarc: null,
    compauth: null,
  };
  for (const part of rest) {
    const statement = parseStatement(part);
    if (!statement) continue;
    const { method, result, props } = statement;
    if (method === "spf" && !results.spf) {
      results.spf = {
        result,
        domain:
          domainOf(props.get("smtp.mailfrom")) ??
          domainOf(props.get("smtp.helo")),
      };
    } else if (method === "dkim" && results.dkim.length < 8) {
      results.dkim.push({
        result,
        domain:
          domainOf(props.get("header.d")) ?? domainOf(props.get("header.i")),
      });
    } else if (method === "dmarc" && !results.dmarc) {
      results.dmarc = { result, domain: domainOf(props.get("header.from")) };
    } else if (method === "compauth" && !results.compauth) {
      results.compauth = { result, domain: null };
    }
  }
  return results;
}

/** 組織のドメイン (「mail.example.co.jp」なら「example.co.jp」)。判断できなければそのまま。 */
export function organizationalDomain(domain: string): string {
  const lower = domain.toLowerCase().replace(/\.$/, "");
  return getDomain(lower, { allowPrivateDomains: false }) ?? lower;
}

/** アドレスのドメイン部分 (小文字)。無ければ null。 */
export function addressDomain(
  address: string | null | undefined,
): string | null {
  if (!address) return null;
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  return domainOf(address.slice(at + 1));
}

/**
 * 有名な会社やサービスの名前と、そのメールが実際に使うドメイン (組織のドメイン)。
 * 表示名がこれらの名前なのに、アドレスが別のドメインなら、なりすましを疑う。
 * 英字の名前は単語として一致したときだけ当てはめる。
 */
const BRANDS: { names: string[]; domains: string[]; label: string }[] = [
  {
    label: "Amazon",
    names: ["amazon", "アマゾン"],
    domains: [
      "amazon.co.jp",
      "amazon.com",
      "amazon.jp",
      "amazon.de",
      "amazon.co.uk",
    ],
  },
  {
    label: "Apple",
    names: ["apple", "icloud", "アップル"],
    domains: ["apple.com", "icloud.com", "me.com", "mac.com"],
  },
  {
    label: "Google",
    names: ["google", "gmail", "youtube", "グーグル"],
    domains: [
      "google.com",
      "youtube.com",
      "gmail.com",
      "googlemail.com",
      "google.co.jp",
    ],
  },
  {
    label: "Microsoft",
    names: [
      "microsoft",
      "outlook",
      "office 365",
      "microsoft 365",
      "マイクロソフト",
    ],
    domains: [
      "microsoft.com",
      "outlook.com",
      "office.com",
      "live.com",
      "hotmail.com",
      "microsoftonline.com",
      "office365.com",
      "microsoft365.com",
    ],
  },
  {
    label: "PayPal",
    names: ["paypal", "ペイパル"],
    domains: ["paypal.com", "paypal.jp", "paypal.co.jp"],
  },
  {
    label: "楽天",
    names: ["rakuten", "楽天"],
    domains: [
      "rakuten.co.jp",
      "rakuten.com",
      "rakuten.ne.jp",
      "rakuten-card.co.jp",
      "rakuten-bank.co.jp",
      "rakuten-sec.co.jp",
      "rakuten-mobile.co.jp",
      "rakuten.jp",
    ],
  },
  {
    label: "三井住友",
    names: ["三井住友", "smbc", "vpass"],
    domains: [
      "smbc.co.jp",
      "smbc-card.com",
      "vpass.ne.jp",
      "smbc-gp.co.jp",
      "smbcnikko.co.jp",
      "smbc-olive.jp",
    ],
  },
  {
    label: "三菱UFJ",
    names: ["三菱ufj", "mufg"],
    domains: [
      "mufg.jp",
      "bk.mufg.jp",
      "cr.mufg.jp",
      "mufgcard.com",
      "sc.mufg.jp",
    ],
  },
  {
    label: "みずほ",
    names: ["みずほ", "mizuho"],
    domains: ["mizuhobank.co.jp", "mizuho-fg.co.jp", "mizuho-sc.com"],
  },
  {
    label: "日本郵便",
    names: ["日本郵便", "ゆうちょ", "japan post", "郵便局"],
    domains: ["japanpost.jp", "jp-bank.japanpost.jp", "post.japanpost.jp"],
  },
  {
    label: "ヤマト運輸",
    names: ["ヤマト運輸", "クロネコ", "kuroneko"],
    domains: ["kuronekoyamato.co.jp", "yamato-hd.co.jp"],
  },
  {
    label: "佐川急便",
    names: ["佐川急便", "sagawa"],
    domains: ["sagawa-exp.co.jp"],
  },
  {
    label: "NTT ドコモ",
    names: ["docomo", "ドコモ"],
    domains: [
      "docomo.ne.jp",
      "nttdocomo.co.jp",
      "docomo.co.jp",
      "dcard.docomo.ne.jp",
      "smt.docomo.ne.jp",
    ],
  },
  {
    label: "KDDI",
    names: ["kddi"],
    domains: ["kddi.com", "au.com", "ezweb.ne.jp"],
  },
  {
    label: "ソフトバンク",
    names: ["softbank", "ソフトバンク"],
    domains: [
      "softbank.jp",
      "softbank.co.jp",
      "softbank.ne.jp",
      "mb.softbank.jp",
      "ymobile.jp",
    ],
  },
  {
    label: "Netflix",
    names: ["netflix", "ネットフリックス"],
    domains: ["netflix.com"],
  },
  {
    label: "メルカリ",
    names: ["mercari", "メルカリ"],
    domains: ["mercari.com", "mercari.jp"],
  },
  {
    label: "JCB",
    names: ["jcb"],
    domains: ["jcb.co.jp", "jcb.jp", "qa.jcb.co.jp"],
  },
  {
    label: "イオン",
    names: ["aeon", "イオンカード", "イオン銀行"],
    domains: ["aeon.co.jp", "aeon.com", "aeonbank.co.jp"],
  },
  {
    label: "Yahoo! JAPAN",
    names: ["yahoo", "ヤフー"],
    domains: ["yahoo.co.jp", "yahoo.com", "mail.yahoo.co.jp", "lycorp.co.jp"],
  },
  {
    label: "PayPay",
    names: ["paypay", "ペイペイ"],
    domains: ["paypay.ne.jp", "paypay-card.co.jp", "paypay-bank.co.jp"],
  },
  {
    label: "Facebook",
    names: ["facebook", "instagram", "フェイスブック", "インスタグラム"],
    domains: [
      "facebookmail.com",
      "facebook.com",
      "meta.com",
      "instagram.com",
      "mail.instagram.com",
    ],
  },
  { label: "GitHub", names: ["github"], domains: ["github.com"] },
  {
    label: "国税庁",
    names: ["国税庁", "e-tax"],
    domains: ["nta.go.jp", "e-tax.nta.go.jp"],
  },
  {
    label: "ETC",
    names: ["etc利用照会", "etcマイレージ"],
    domains: ["etc-meisai.jp", "smile-etc.jp"],
  },
];

function normalizeName(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

/** 英字の名前が、単語 (前後が英数字でない) として含まれているか。日本語はそのまま含むか。 */
function containsName(name: string, word: string): boolean {
  if (!/^[a-z0-9 .!-]+$/.test(word)) return name.includes(word);
  let from = 0;
  while (true) {
    const at = name.indexOf(word, from);
    if (at < 0) return false;
    const before = name[at - 1];
    const after = name[at + word.length];
    if (
      (before === undefined || !/[a-z0-9]/.test(before)) &&
      (after === undefined || !/[a-z0-9]/.test(after))
    ) {
      return true;
    }
    from = at + 1;
  }
}

/** 知られた末尾 (.com や .co.jp など、ICANN の一覧にあるもの) を持つドメインか。 */
function isKnownDomain(value: string): boolean {
  const parsed = parse(value, { allowPrivateDomains: false });
  return parsed.isIcann === true && parsed.domain !== null;
}

function sameOrganization(a: string, b: string): boolean {
  return organizationalDomain(a) === organizationalDomain(b);
}

/**
 * 表示名が名乗っている相手が、実際のアドレスのドメインと食い違っていれば、その相手を返す。
 * 例: 「Amazon <info@amaz0n-security.example>」なら「Amazon」。
 */
export function displayNameMismatch(
  displayName: string | null | undefined,
  address: string | null | undefined,
): string | null {
  const domain = addressDomain(address);
  const name = displayName?.trim();
  if (!domain || !name) return null;
  const normalized = normalizeName(name);

  // 表示名の中のメールアドレスやドメイン (「support@example.com」「example.com」)。
  const tokens =
    normalized.match(/[a-z0-9._%+-]*@?[a-z0-9-]+(?:\.[a-z0-9-]+)+/g) ?? [];
  for (const token of tokens) {
    const claimed = token.includes("@")
      ? addressDomain(token)
      : domainOf(token);
    // ドメインとして成り立つもの (知られた末尾を持つもの) だけを比べる。
    // アドレスの形ならそのまま比べ、ドメインだけのものは、知られた末尾を持つものだけを比べる
    // (「Next.js」「v1.2」などの語を、ドメインと取り違えないように)。
    if (!claimed || (!token.includes("@") && !isKnownDomain(claimed))) continue;
    if (!sameOrganization(claimed, domain)) return token;
  }

  for (const brand of BRANDS) {
    if (!brand.names.some((word) => containsName(normalized, word))) continue;
    const own = brand.domains.some((item) => sameOrganization(item, domain));
    if (!own) return brand.label;
  }
  return null;
}

/** DMARC の合格が、差出人のアドレスのドメインについてのものか。ドメインが書かれていなければ一致とみなさない。 */
function dmarcAligned(dmarc: AuthMethodResult, fromDomain: string): boolean {
  if (!dmarc.domain) return false;
  return dmarc.domain === fromDomain;
}

/** 差出人 (From の先頭) と認証結果から、画面に出す確認結果を決める。 */
export function checkSender(
  from: { name?: string | null; address: string } | null | undefined,
  auth: AuthResults | null,
): SenderCheck {
  const warnings: SenderWarning[] = [];
  const fromDomain = addressDomain(from?.address);
  let verified = false;
  if (auth && fromDomain) {
    const dmarc = auth.dmarc;
    if (dmarc?.result === "pass" && dmarcAligned(dmarc, fromDomain)) {
      verified = true;
    } else if (dmarc?.result === "fail") {
      warnings.push("dmarc_fail");
    } else if (auth.compauth?.result === "fail") {
      // Microsoft は DMARC の記録が無いドメインでも、独自の総合判定で失敗を付ける。
      warnings.push("auth_fail");
    } else if (
      auth.spf?.result === "fail" &&
      !auth.dkim.some((item) => item.result === "pass")
    ) {
      warnings.push("auth_fail");
    }
  }
  const claimed = displayNameMismatch(from?.name, from?.address);
  if (claimed) warnings.push("name_mismatch");
  return { verified, warnings, claimed, version: SENDER_CHECK_VERSION };
}

/* ------------------------------------------------------------------ */
/* 信頼する判定サーバー (authserv-id)                                    */
/* ------------------------------------------------------------------ */

/** アカウントの種類と受信サーバー。どのヘッダーを信頼するかを決める。 */
export type AuthTrust = {
  provider: "gmail" | "microsoft" | "icloud" | "generic";
  /** 受信 (IMAP / POP3) のホスト名。Microsoft Graph など、無ければ null。 */
  host: string | null;
};

type TrustRule =
  | { kind: "gmail" }
  | { kind: "microsoft" }
  | { kind: "icloud" }
  /** 一般のサーバー: 受信ホストと組織のドメイン (登録ドメイン) が同じ名前。 */
  | { kind: "domain"; domain: string }
  | { kind: "none" };

/** 受信ホストの組織のドメインから、大手のサービスかを見分ける (一般の設定で足したアカウント)。 */
const HOST_PROVIDERS: Record<string, "gmail" | "microsoft" | "icloud"> = {
  "gmail.com": "gmail",
  "googlemail.com": "gmail",
  "office365.com": "microsoft",
  "outlook.com": "microsoft",
  "hotmail.com": "microsoft",
  "live.com": "microsoft",
  "me.com": "icloud",
  "icloud.com": "icloud",
};

function hostDomain(host: string | null): string | null {
  if (!host) return null;
  const lower = host.trim().toLowerCase().replace(/\.$/, "");
  // IP アドレスや、公開サフィックスの下に無い名前 (localhost など) は比べられない。
  if (/^[0-9.]+$/.test(lower) || lower.includes(":")) return null;
  const parsed = parse(lower, { allowPrivateDomains: false });
  if (parsed.isIcann !== true || !parsed.domain) return null;
  return parsed.domain;
}

function trustRule(trust: AuthTrust | null | undefined): TrustRule {
  if (!trust) return { kind: "none" };
  if (trust.provider !== "generic") return { kind: trust.provider };
  const domain = hostDomain(trust.host);
  if (!domain) return { kind: "none" };
  const known = HOST_PROVIDERS[domain];
  return known ? { kind: known } : { kind: "domain", domain };
}

/**
 * その判定サーバーの名前 (authserv-id、小文字) を信頼するか。
 * - Gmail: mx.google.com だけ (Gmail が受け取ったメールに付ける名前)。
 * - Microsoft (Graph、Outlook.com / Exchange Online の IMAP・POP3): 名前を省いた形 (空) か、
 *   .outlook.com で終わる名前。Exchange Online は名前を省いて付ける (公開資料のヘッダーの例)。
 *   .outlook.com は推測 (保護のサーバー *.protection.outlook.com が付けることがある)。
 * - iCloud: .icloud.com で終わる名前。iCloud は dmarc.icloud.com / dkim-verifier.icloud.com /
 *   spf.icloud.com / bimi.icloud.com のように方式ごとに分けて付ける (レビューの記憶と、
 *   公開されているヘッダーの例による。推測を含む)。
 * - 一般の IMAP / POP3: 受信ホストと組織のドメイン (登録ドメイン) が同じ名前だけ。
 *   例: imap.example.net なら mx.example.net を信頼し、mx.small.example は信頼しない。
 */
export function isTrustedAuthservId(
  trust: AuthTrust | null | undefined,
  authservId: string,
): boolean {
  const id = authservId.toLowerCase();
  const rule = trustRule(trust);
  switch (rule.kind) {
    case "gmail":
      return id === "mx.google.com";
    case "microsoft":
      return id === "" || id.endsWith(".outlook.com");
    case "icloud":
      return id.endsWith(".icloud.com");
    case "domain": {
      const domain = domainOf(id);
      return domain !== null && organizationalDomain(domain) === rule.domain;
    }
    default:
      return false;
  }
}

/** 読むヘッダーの数の上限 (中継が多いメールでも、上の数本だけを見る)。 */
const MAX_AUTH_HEADERS = 16;

/**
 * 同じメールの Authentication-Results (上から順) のうち、信頼する判定サーバーが付けたものだけを
 * まとめて返す。使うのは、いちばん上から続く信頼するヘッダーで、信頼しない名前・読めない
 * ヘッダー・同じ名前の 2 本目に当たったらそこでやめる (それより下は差出人が書いた可能性がある)。
 * iCloud のように方式ごとに分かれていれば、方式ごとに上のものを使う。
 * 信頼するヘッダーが無ければ null (認証の結果は無いものとして扱う = unknown)。
 */
export function selectAuthResults(
  values: readonly string[],
  trust: AuthTrust | null | undefined,
): AuthResults | null {
  const picked: AuthResults[] = [];
  const seen = new Set<string>();
  for (const value of values.slice(0, MAX_AUTH_HEADERS)) {
    const parsed = parseAuthenticationResults(value);
    if (!parsed) break;
    if (!isTrustedAuthservId(trust, parsed.authservId)) break;
    if (seen.has(parsed.authservId)) break;
    seen.add(parsed.authservId);
    picked.push(parsed);
  }
  const head = picked[0];
  if (!head) return null;
  return {
    authservId: head.authservId,
    spf: picked.find((item) => item.spf)?.spf ?? null,
    dkim: picked.flatMap((item) => item.dkim).slice(0, 8),
    dmarc: picked.find((item) => item.dmarc)?.dmarc ?? null,
    compauth: picked.find((item) => item.compauth)?.compauth ?? null,
  };
}
