import type { Account, Address, MessageDetail, OutgoingMail } from "@/lib/api";
import { addressFull, formatFullDate } from "@/lib/format";

/** 作成画面の種類。reply と replyAll は、送信時にはどちらも「返信」として扱う。 */
export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

/** 作成中のメール。宛先は入力欄の文字列のまま持ち、送信するときに解釈する。 */
export type ComposeDraft = {
  /** 送信ごとに作る一意な ID。同じ下書きを送り直しても二重に送られない。 */
  idempotencyKey: string;
  accountId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  mode: "new" | "reply" | "forward";
  /** 返信・転送の元になったメッセージ。 */
  sourceMessageId: string | null;
};

const ADDRESS = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** 区切り文字 (, ; 改行) で分ける。引用符と <> の中の区切り文字は無視する。 */
function splitList(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;
  for (const char of input) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === "<") angle = true;
    else if (!quoted && char === ">") angle = false;
    if (!quoted && !angle && (char === "," || char === ";" || char === "\n")) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * 宛先の入力欄を解釈する。「名前 <a@example.com>」と「a@example.com」の形を受け付ける。
 * 解釈できなかったものは invalid に入れて返す。
 */
export function parseAddressList(input: string): {
  addresses: Address[];
  invalid: string[];
} {
  const addresses: Address[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const part of splitList(input)) {
    const match = /^(.*)<([^<>]+)>$/.exec(part);
    const address = (match?.[2] ?? part).trim();
    const name = (match?.[1] ?? "")
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .trim();
    if (!ADDRESS.test(address)) {
      invalid.push(part);
      continue;
    }
    // 同じ宛先を 2 回入れても、送るのは 1 通にする。
    if (seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    addresses.push(name ? { name, address } : { address });
  }
  return { addresses, invalid };
}

/** 宛先の一覧を、入力欄に入れる文字列にする。 */
export function formatAddressList(addresses: Address[]): string {
  return addresses
    .map((entry) => {
      const name = entry.name?.trim();
      if (!name) return entry.address;
      // 区切り文字を含む名前は、引用符で囲まないと別の宛先として解釈されてしまう。
      const label = /[,;<>"]/.test(name) ? `"${name.replace(/"/g, "")}"` : name;
      return `${label} <${entry.address}>`;
    })
    .join(", ");
}

function withPrefix(subject: string, prefix: "Re" | "Fwd"): string {
  const pattern =
    prefix === "Re" ? /^\s*re\s*[:：]/i : /^\s*(fwd?|fw)\s*[:：]/i;
  return pattern.test(subject) ? subject : `${prefix}: ${subject}`.trimEnd();
}

function quote(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .trimEnd()
    .split("\n")
    .map((line) => (line.startsWith(">") ? `>${line}` : `> ${line}`))
    .join("\n");
}

export function newDraft(accountId: string): ComposeDraft {
  return {
    idempotencyKey: crypto.randomUUID(),
    accountId,
    to: "",
    cc: "",
    bcc: "",
    subject: "",
    text: "",
    mode: "new",
    sourceMessageId: null,
  };
}

/**
 * 返信・全員に返信・転送の下書きを作る。
 * bodyText は元のメールの本文 (HTML だけのメールでは、テキストに直したもの)。
 */
export function buildDraftFrom(
  mode: Exclude<ComposeMode, "new">,
  message: MessageDetail,
  bodyText: string,
  accounts: Pick<Account, "id" | "email">[],
): ComposeDraft {
  const account =
    accounts.find((entry) => entry.id === message.accountId) ?? accounts[0];
  const draft = newDraft(account?.id ?? message.accountId);
  draft.sourceMessageId = message.id;
  const sender = message.from[0];
  const date = formatFullDate(message.sentAt ?? message.receivedAt);

  if (mode === "forward") {
    const header = [
      "---------- 転送メッセージ ----------",
      `差出人: ${message.from.map(addressFull).join(", ")}`,
      `日時: ${date}`,
      `件名: ${message.subject}`,
      `宛先: ${message.to.map(addressFull).join(", ")}`,
      ...(message.cc.length > 0
        ? [`Cc: ${message.cc.map(addressFull).join(", ")}`]
        : []),
    ].join("\n");
    return {
      ...draft,
      mode: "forward",
      subject: withPrefix(message.subject, "Fwd"),
      text: `\n\n${header}\n\n${bodyText.trimEnd()}\n`,
    };
  }

  const own = new Set(accounts.map((entry) => entry.email.toLowerCase()));
  const isOwn = (entry: Address) => own.has(entry.address.toLowerCase());
  // 自分が送ったメールへの返信は、元の宛先へ送る。
  const fromSelf = message.from.length > 0 && message.from.every(isOwn);
  const to = fromSelf
    ? message.to
    : message.replyTo.length > 0
      ? message.replyTo
      : message.from;
  let cc: Address[] = [];
  if (mode === "replyAll") {
    const taken = new Set(to.map((entry) => entry.address.toLowerCase()));
    const rest = fromSelf ? message.cc : [...message.to, ...message.cc];
    cc = rest.filter((entry) => {
      const key = entry.address.toLowerCase();
      if (isOwn(entry) || taken.has(key)) return false;
      taken.add(key);
      return true;
    });
  }
  const attribution = `${date} ${sender ? addressFull(sender) : ""} のメッセージ:`;
  return {
    ...draft,
    mode: "reply",
    to: formatAddressList(to),
    cc: formatAddressList(cc),
    subject: withPrefix(message.subject, "Re"),
    text: `\n\n${attribution}\n${quote(bodyText)}\n`,
  };
}

/** 送信できなかったメールを、編集して送り直すための下書きに戻す。 */
export function draftFromOutgoing(mail: OutgoingMail): ComposeDraft {
  return {
    // 前回の送信とは別の依頼として扱ってもらうため、ID は作り直す。
    idempotencyKey: crypto.randomUUID(),
    accountId: mail.accountId,
    to: formatAddressList(mail.to),
    cc: formatAddressList(mail.cc),
    bcc: formatAddressList(mail.bcc),
    subject: mail.subject,
    text: mail.text,
    mode: mail.mode,
    sourceMessageId: mail.sourceMessageId,
  };
}

const BLOCKS =
  "address,article,blockquote,div,dd,dl,dt,h1,h2,h3,h4,h5,h6,hr,li,ol,p,pre,section,table,tr,ul";

/**
 * HTML の本文を、引用に使うテキストへ直す (ブラウザーでのみ動く)。
 * 文書は解釈するだけで画面には挿入しないので、スクリプトや画像の読み込みは起きない。
 */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const node of doc.querySelectorAll("script,style,head,title")) {
    node.remove();
  }
  for (const node of doc.querySelectorAll("br")) node.replaceWith("\n");
  for (const node of doc.querySelectorAll(BLOCKS)) node.append("\n");
  return (doc.body.textContent ?? "")
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 引用や転送に使う、元のメールの本文。 */
export function bodyTextOf(message: MessageDetail): string {
  if (message.bodyText?.trim()) return message.bodyText;
  if (message.bodyHtml) return htmlToText(message.bodyHtml);
  return "";
}
