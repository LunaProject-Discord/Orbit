import type {
  Account,
  Address,
  MessageDetail,
  OutgoingMail,
  UploadedAttachment,
} from "@/lib/api";
import { addressFull, formatFullDate } from "@/lib/format";

/** 作成画面の種類。reply と replyAll は、送信時にはどちらも「返信」として扱う。 */
export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

/** 宛先の欄 1 つ分。確定した宛先と、入力途中の文字列。 */
export type RecipientField = { list: Address[]; text: string };

/** 作成中のメール。 */
export type ComposeDraft = {
  /** 送信ごとに作る一意な ID。同じ下書きを送り直しても二重に送られない。 */
  idempotencyKey: string;
  accountId: string;
  to: RecipientField;
  cc: RecipientField;
  bcc: RecipientField;
  subject: string;
  /** 本文 (書式付き)。送信するときにテキスト版も作る。 */
  html: string;
  /** サーバーに受け取ってもらった添付ファイル。 */
  attachments: UploadedAttachment[];
  mode: "new" | "reply" | "forward";
  /** 返信・転送の元になったメッセージ。 */
  sourceMessageId: string | null;
};

/** 1 通あたりの添付ファイルの合計の上限 (サーバー側と同じ値)。 */
export const MAX_ATTACHMENTS_BYTES = 25 * 1024 * 1024;
/** Microsoft のアカウントで送る場合の上限。 */
export const MAX_GRAPH_ATTACHMENTS_BYTES = 3 * 1024 * 1024;
export const MAX_ATTACHMENT_COUNT = 20;

export function attachmentLimit(account: Pick<Account, "protocol">): number {
  return account.protocol === "graph"
    ? MAX_GRAPH_ATTACHMENTS_BYTES
    : MAX_ATTACHMENTS_BYTES;
}

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
 * 宛先の入力を解釈する。「名前 <a@example.com>」と「a@example.com」の形を受け付ける。
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

/** 宛先を足す。すでにある宛先は足さない。 */
export function mergeAddresses(
  current: Address[],
  added: Address[],
): Address[] {
  const seen = new Set(current.map((entry) => entry.address.toLowerCase()));
  const result = [...current];
  for (const entry of added) {
    const key = entry.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

/**
 * 宛先の欄を確定する。入力途中の文字列も宛先として解釈し、
 * 解釈できないものが残っていれば invalid に入れて返す。
 */
export function resolveRecipients(field: RecipientField): {
  addresses: Address[];
  invalid: string[];
} {
  const parsed = parseAddressList(field.text);
  return {
    addresses: mergeAddresses(field.list, parsed.addresses),
    invalid: parsed.invalid,
  };
}

function withPrefix(subject: string, prefix: "Re" | "Fwd"): string {
  const pattern =
    prefix === "Re" ? /^\s*re\s*[:：]/i : /^\s*(fwd?|fw)\s*[:：]/i;
  return pattern.test(subject) ? subject : `${prefix}: ${subject}`.trimEnd();
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** テキストを、1 行ずつの <div> にする (空行は <div><br></div>)。 */
function linesToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .trimEnd()
    .split("\n")
    .map((line) => `<div>${line ? escapeHtml(line) : "<br>"}</div>`)
    .join("");
}

const EMPTY_LINES = "<div><br></div><div><br></div>";
const field = (list: Address[] = []): RecipientField => ({ list, text: "" });

export function newDraft(accountId: string): ComposeDraft {
  return {
    idempotencyKey: crypto.randomUUID(),
    accountId,
    to: field(),
    cc: field(),
    bcc: field(),
    subject: "",
    html: "",
    attachments: [],
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
      html: `${EMPTY_LINES}${linesToHtml(`${header}\n\n${bodyText}`)}`,
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
  const attribution = `${date} ${sender ? addressFull(sender) : ""}:`;
  return {
    ...draft,
    mode: "reply",
    to: field(to),
    cc: field(cc),
    subject: withPrefix(message.subject, "Re"),
    html: `${EMPTY_LINES}<blockquote>${linesToHtml(`${attribution}\n${bodyText}`)}</blockquote>`,
  };
}

/** 送信できなかったメールを、編集して送り直すための下書きに戻す。 */
export function draftFromOutgoing(mail: OutgoingMail): ComposeDraft {
  return {
    // 前回の送信とは別の依頼として扱ってもらうため、ID は作り直す。
    idempotencyKey: crypto.randomUUID(),
    accountId: mail.accountId,
    to: field(mail.to),
    cc: field(mail.cc),
    bcc: field(mail.bcc),
    subject: mail.subject,
    html: mail.html ?? linesToHtml(mail.text),
    attachments: mail.attachments,
    mode: mail.mode,
    sourceMessageId: mail.sourceMessageId,
  };
}

// ---------------------------------------------------------------------------
// HTML の扱い (ブラウザーでのみ動く)
// 文書は解釈するだけで画面には挿入しないので、スクリプトや画像の読み込みは起きない。
// ---------------------------------------------------------------------------

const DROPPED = new Set(["script", "style", "head", "title", "template"]);
const BLOCKS = new Set(
  "address,article,blockquote,div,dd,dl,dt,h1,h2,h3,h4,h5,h6,hr,li,ol,p,pre,section,table,tr,ul".split(
    ",",
  ),
);

function quoteLine(line: string): string {
  return line.startsWith(">") ? `>${line}` : `> ${line}`;
}

/** 要素の中身を、行の一覧にする。 */
function linesOf(parent: Node): string[] {
  const out: string[] = [];
  let current = "";
  const flush = () => {
    if (current !== "") out.push(current);
    current = "";
  };
  for (const node of parent.childNodes) {
    if (node.nodeType === 3) {
      current += (node.nodeValue ?? "").replace(/\s*\n\s*/g, " ");
      continue;
    }
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (DROPPED.has(tag)) continue;
    if (tag === "br") {
      out.push(current);
      current = "";
      continue;
    }
    if (!BLOCKS.has(tag)) {
      const inner = linesOf(element);
      const href = tag === "a" ? element.getAttribute("href") : null;
      const first = inner.shift() ?? "";
      current += first;
      for (const line of inner) {
        out.push(current);
        current = line;
      }
      // リンクは、表示と違う行き先のときだけ行き先を添える。
      if (href && /^(https?:|mailto:)/i.test(href)) {
        const label = [first, ...inner].join(" ").trim();
        const target = href.replace(/^mailto:/i, "");
        if (label !== href && label !== target) current += ` (${href})`;
      }
      if (tag === "td" || tag === "th") current += " ";
      continue;
    }
    flush();
    let inner = linesOf(element);
    if (inner.length === 0) inner = tag === "ul" || tag === "ol" ? [] : [""];
    if (tag === "blockquote") inner = inner.map(quoteLine);
    if (tag === "li") {
      inner = inner.map((line, index) =>
        index === 0 ? `- ${line}` : `  ${line}`,
      );
    }
    out.push(...inner);
  }
  flush();
  return out;
}

/** HTML をテキストに直す。引用 (blockquote) は行頭に > を付ける。 */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return linesOf(doc.body)
    .map((line) => line.replace(/ /g, " ").trimEnd())
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

/** 引用や転送に使う、元のメールの本文。 */
export function bodyTextOf(message: MessageDetail): string {
  if (message.bodyText?.trim()) return message.bodyText;
  if (message.bodyHtml) {
    return htmlToText(message.bodyHtml).replace(/\n{3,}/g, "\n\n");
  }
  return "";
}

/** 送信する本文に残すタグ。これ以外は、タグだけ外して中身を残す。 */
const ALLOWED = new Set(
  "a,b,blockquote,br,div,em,i,li,ol,p,s,strong,u,ul".split(","),
);
const QUOTE_STYLE =
  "margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex;color:#555";

function sanitizeNode(parent: Node): string {
  let html = "";
  for (const node of parent.childNodes) {
    if (node.nodeType === 3) {
      html += escapeHtml(node.nodeValue ?? "");
      continue;
    }
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (DROPPED.has(tag)) continue;
    const inner = sanitizeNode(element);
    if (!ALLOWED.has(tag)) {
      html += inner;
    } else if (tag === "br") {
      html += "<br>";
    } else if (tag === "a") {
      const href = element.getAttribute("href") ?? "";
      html += /^(https?:|mailto:)/i.test(href)
        ? `<a href="${escapeHtml(href)}">${inner}</a>`
        : inner;
    } else if (tag === "blockquote") {
      html += `<blockquote style="${QUOTE_STYLE}">${inner}</blockquote>`;
    } else {
      html += `<${tag}>${inner}</${tag}>`;
    }
  }
  return html;
}

/**
 * 作成画面の本文を、送信してよい HTML に整える。
 * 太字・斜体・下線・箇条書き・リンク・引用だけを残し、属性やスクリプトは落とす。
 */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return sanitizeNode(doc.body);
}

// ---------------------------------------------------------------------------
// 下書きの保存 (この端末のブラウザーの中)
// ---------------------------------------------------------------------------

const DRAFT_KEY = "mail.compose-draft.v1";

function isField(value: unknown): value is RecipientField {
  const record = value as RecipientField | null;
  return (
    !!record && Array.isArray(record.list) && typeof record.text === "string"
  );
}

export function loadStoredDraft(): ComposeDraft | null {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(DRAFT_KEY) ?? "null",
    );
    const draft = value as ComposeDraft | null;
    if (
      !draft ||
      typeof draft.idempotencyKey !== "string" ||
      typeof draft.accountId !== "string" ||
      typeof draft.subject !== "string" ||
      typeof draft.html !== "string" ||
      !isField(draft.to) ||
      !isField(draft.cc) ||
      !isField(draft.bcc) ||
      !Array.isArray(draft.attachments)
    ) {
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

/** 下書きを保存する。null なら消す。保存できたら true。 */
export function storeDraft(draft: ComposeDraft | null): boolean {
  try {
    if (draft) window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else window.localStorage.removeItem(DRAFT_KEY);
    return true;
  } catch {
    return false;
  }
}
