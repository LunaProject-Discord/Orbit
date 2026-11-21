import type {
  Account,
  Address,
  MessageDetail,
  OutgoingMail,
  RecipientField,
  SaveDraftInput,
  ServerDraft,
  UploadedAttachment,
} from "@/lib/api";
import { splitAttachments } from "@/lib/attachments";
import { addressFull, formatFullDate } from "@/lib/format";

/** 作成画面の種類。reply と replyAll は、送信時にはどちらも「返信」として扱う。 */
export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

export type { RecipientField };

/** 作成中のメール。 */
export type ComposeDraft = {
  /**
   * 下書きの ID で、送信ごとの一意な ID にもなる。
   * 同じ下書きを送り直しても、別の端末から送っても、二重に送られない。
   */
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
  /**
   * 転送する元のメールの添付ファイルのうち、まだ送信用に複製してもらっていないもの。
   * 作成画面が複製を頼み、終わったら attachments へ移す。
   */
  forwardAttachments?: {
    messageId: string;
    files: UploadedAttachment[];
  } | null;
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

const EMPTY_LINE = "<div><br></div>";
const EMPTY_LINES = `${EMPTY_LINE}${EMPTY_LINE}`;
const field = (list: Address[] = []): RecipientField => ({ list, text: "" });

/** 署名を持つアカウント (作成画面で使う分だけ)。 */
type SignatureAccount = Pick<Account, "id" | "email"> & {
  signatureHtml?: string | null;
};

/**
 * 本文に入れる署名。data-signature は、差出人を変えたときに署名を入れ替える目印。
 * 署名が無ければ空文字列。
 */
function signatureBlock(signatureHtml: string | null | undefined): string {
  const html = signatureHtml ? sanitizeHtml(signatureHtml) : "";
  if (!htmlHasContent(html)) return "";
  return `<div data-signature="">${html}</div>`;
}

/** 文字が 1 つでもあるか (空行だけの HTML は中身なしとして扱う)。 */
export function htmlHasContent(html: string): boolean {
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;|\s/g, "") !== "";
}

/** 書き始める場所 (空行) と署名。署名は 1 行あけて入れる。 */
function draftHead(signatureHtml: string | null | undefined): string {
  const signature = signatureBlock(signatureHtml);
  return signature ? `${EMPTY_LINES}${signature}` : "";
}

export function newDraft(
  accountId: string,
  signatureHtml?: string | null,
): ComposeDraft {
  return {
    idempotencyKey: crypto.randomUUID(),
    accountId,
    to: field(),
    cc: field(),
    bcc: field(),
    subject: "",
    html: draftHead(signatureHtml),
    attachments: [],
    mode: "new",
    sourceMessageId: null,
  };
}

/** 引用や転送に入れる、元のメールの本文 (書式付き)。 */
function quotedBodyOf(message: MessageDetail): string {
  if (message.bodyHtml?.trim()) {
    const html = sanitizeHtml(message.bodyHtml);
    if (htmlHasContent(html)) return html;
  }
  return linesToHtml(message.bodyText ?? "");
}

/**
 * 返信・全員に返信・転送の下書きを作る。
 * 元のメールが HTML なら書式を保ったまま引用し、テキストだけなら 1 行ずつ引用する。
 * 並びは「書き始める空行、署名、元のメール」。
 */
export function buildDraftFrom(
  mode: Exclude<ComposeMode, "new">,
  message: MessageDetail,
  accounts: SignatureAccount[],
): ComposeDraft {
  const account =
    accounts.find((entry) => entry.id === message.accountId) ?? accounts[0];
  const draft = newDraft(account?.id ?? message.accountId);
  draft.sourceMessageId = message.id;
  const sender = message.from[0];
  const date = formatFullDate(message.sentAt ?? message.receivedAt);
  const head = draftHead(account?.signatureHtml) || EMPTY_LINE;
  const body = quotedBodyOf(message);

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
    // 本文に埋め込まれた画像 (署名のロゴなど) は、引用した本文には入らないので付けない。
    const files = splitAttachments(
      message.bodyHtml,
      message.attachments,
    ).listed.map((file) => ({
      id: file.id,
      filename: file.filename || "attachment",
      contentType: file.contentType,
      size: file.size,
    }));
    return {
      ...draft,
      mode: "forward",
      forwardAttachments:
        files.length > 0 ? { messageId: message.id, files } : null,
      subject: withPrefix(message.subject, "Fwd"),
      html: `${head}${EMPTY_LINE}<div data-quote="">${linesToHtml(header)}${EMPTY_LINE}${body}</div>`,
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
    html: `${head}${EMPTY_LINE}<div data-quote=""><div>${escapeHtml(attribution)}</div><blockquote>${body}</blockquote></div>`,
  };
}

/**
 * 本文の署名を入れ替える (差出人を変えたとき)。
 * 署名が入っていなければ、引用の前 (引用が無ければ末尾) に入れる。
 */
export function replaceSignature(
  html: string,
  signatureHtml: string | null | undefined,
): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const next = signatureBlock(signatureHtml);
  const current = doc.body.querySelector("[data-signature]");
  if (current) {
    current.outerHTML = next;
    return doc.body.innerHTML;
  }
  if (!next) return html;
  const quote = doc.body.querySelector("[data-quote]");
  if (quote) {
    quote.insertAdjacentHTML("beforebegin", `${next}${EMPTY_LINE}`);
    return doc.body.innerHTML;
  }
  return `${html || EMPTY_LINE}${EMPTY_LINE}${next}`;
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
    // 整形済みの文 (pre) は、改行をそのまま行にする。
    let inner =
      tag === "pre"
        ? (element.textContent ?? "").replace(/\r\n?/g, "\n").split("\n")
        : linesOf(element);
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

/**
 * 送信する本文に残すタグ。これ以外は、タグだけ外して中身を残す。
 * 見出しや表は作成画面では作れないが、引用した元のメールの形を保つために残す。
 */
const ALLOWED = new Set(
  "a,b,blockquote,br,code,div,em,h1,h2,h3,h4,h5,h6,hr,i,li,ol,p,pre,s,span,strong,sub,sup,table,tbody,td,tfoot,th,thead,tr,u,ul".split(
    ",",
  ),
);
const VOID = new Set(["br", "hr"]);
const QUOTE_STYLE =
  "margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex;color:#555";

const CELL_STYLE = "padding:0 1em 0 0;vertical-align:top";

/**
 * 残す style の項目。色は残さない (暗い画面の作成画面で読めなくなるため)。
 * 値は決まった語だけを通すので、url() などは入らない。
 */
const STYLE_VALUES: Record<string, RegExp> = {
  "font-weight": /^(normal|bold|bolder|lighter|[1-9]00)$/,
  "font-style": /^(normal|italic|oblique)$/,
  "text-decoration": /^(none|underline|line-through)$/,
  "text-decoration-line": /^(none|underline|line-through)$/,
  "text-align": /^(left|right|center|justify|start|end)$/,
};

function declarationsOf(element: Element): [string, string][] {
  return (element.getAttribute("style") ?? "")
    .split(";")
    .map((part): [string, string] => {
      const index = part.indexOf(":");
      if (index < 0) return ["", ""];
      return [
        part.slice(0, index).trim().toLowerCase(),
        part
          .slice(index + 1)
          .replace(/!important/i, "")
          .trim()
          .toLowerCase(),
      ];
    })
    .filter(([name]) => name !== "");
}

/** 受信者に見せないために隠してある要素 (プレビュー用の文など)。引用には入れない。 */
function isHidden(declarations: [string, string][]): boolean {
  return declarations.some(
    ([name, value]) =>
      (name === "display" && value === "none") ||
      (name === "visibility" && value === "hidden") ||
      (name === "opacity" && /^0(\.0+)?$/.test(value)) ||
      ((name === "font-size" || name === "max-height") &&
        /^0+(\.0+)?(px|pt|em|rem|%)?$/.test(value)),
  );
}

function styleAttribute(declarations: [string, string][]): string {
  const kept = declarations.filter(([name, value]) =>
    STYLE_VALUES[name]?.test(value),
  );
  if (kept.length === 0) return "";
  return ` style="${kept.map(([name, value]) => `${name}:${value}`).join(";")}"`;
}

function spanAttribute(element: Element, name: string): string {
  const value = element.getAttribute(name) ?? "";
  return /^[1-9][0-9]{0,2}$/.test(value) ? ` ${name}="${value}"` : "";
}

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
    const declarations = declarationsOf(element);
    if (isHidden(declarations)) continue;
    if (tag === "img") {
      // 画像は持ち込まない (外部の画像は開封の追跡に使われる)。説明の文字だけ残す。
      const alt = element.getAttribute("alt")?.trim();
      if (alt) html += escapeHtml(`[画像: ${alt}]`);
      continue;
    }
    const inner = sanitizeNode(element);
    if (!ALLOWED.has(tag)) {
      html += inner;
    } else if (VOID.has(tag)) {
      html += `<${tag}>`;
    } else if (tag === "a") {
      const href = element.getAttribute("href") ?? "";
      html += /^(https?:|mailto:)/i.test(href)
        ? `<a href="${escapeHtml(href)}">${inner}</a>`
        : inner;
    } else if (tag === "blockquote") {
      html += `<blockquote style="${QUOTE_STYLE}">${inner}</blockquote>`;
    } else if (tag === "td" || tag === "th") {
      const attributes = `${spanAttribute(element, "colspan")}${spanAttribute(element, "rowspan")}`;
      // 相手のメールソフトでも列がくっつかないよう、余白を付ける。
      const kept = declarations
        .filter(([name, value]) => STYLE_VALUES[name]?.test(value))
        .map(([name, value]) => `;${name}:${value}`)
        .join("");
      html += `<${tag}${attributes} style="${CELL_STYLE}${kept}">${inner}</${tag}>`;
    } else if (tag === "span") {
      // 何も付かない span は、中身だけにする。
      const style = styleAttribute(declarations);
      html += style ? `<span${style}>${inner}</span>` : inner;
    } else if (tag === "div") {
      // 署名と引用の目印は、差出人を変えたときに署名を入れ替えるために残す。
      const mark = element.hasAttribute("data-signature")
        ? ' data-signature=""'
        : element.hasAttribute("data-quote")
          ? ' data-quote=""'
          : "";
      html += `<div${mark}${styleAttribute(declarations)}>${inner}</div>`;
    } else {
      html += `<${tag}${styleAttribute(declarations)}>${inner}</${tag}>`;
    }
  }
  return html;
}

/**
 * 作成画面の本文を、送信してよい HTML に整える。
 * 太字・斜体・下線・箇条書き・リンク・引用・見出し・表だけを残し、
 * スクリプト、画像、色や大きさの指定は落とす。元のメールを引用するときにも使う。
 */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return sanitizeNode(doc.body);
}

// ---------------------------------------------------------------------------
// 下書きの保存
// 下書きはサーバーに保存し、どの端末からも続きを書けるようにする。
// サーバーへ保存し終えるまでの間だけ、この端末のブラウザーの中にも置いておく
// (保存の前にページを閉じたり、通信できなかったりしても内容を失わないため)。
// ---------------------------------------------------------------------------

/** サーバーにある下書きを、作成画面で開く形にする。 */
export function draftFromServer(draft: ServerDraft): ComposeDraft {
  return {
    idempotencyKey: draft.id,
    accountId: draft.accountId,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    html: draft.html,
    attachments: draft.attachments,
    mode: draft.mode,
    sourceMessageId: draft.sourceMessageId,
  };
}

/** 下書きを、サーバーへ保存する形にする (ブラウザーでのみ動く)。 */
export function draftSaveInput(
  draft: ComposeDraft,
  baseRevision: number | null,
): SaveDraftInput {
  const html = sanitizeHtml(draft.html);
  return {
    accountId: draft.accountId,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    html,
    text: htmlToText(html),
    attachmentIds: draft.attachments.map((file) => file.id),
    mode: draft.mode,
    sourceMessageId: draft.sourceMessageId,
    baseRevision,
  };
}

/** まだサーバーへ保存し終えていない下書きと、それが元にしたサーバー側の revision。 */
export type UnsavedDraft = { draft: ComposeDraft; baseRevision: number | null };

const UNSAVED_KEY = "mail.unsaved-drafts.v1";
/** 以前の版が、書きかけのメールを 1 通だけ置いていた場所。 */
const LEGACY_KEY = "mail.compose-draft.v1";

function isField(value: unknown): value is RecipientField {
  const record = value as RecipientField | null;
  return (
    !!record && Array.isArray(record.list) && typeof record.text === "string"
  );
}

function isDraft(value: unknown): value is ComposeDraft {
  const draft = value as ComposeDraft | null;
  return (
    !!draft &&
    typeof draft.idempotencyKey === "string" &&
    typeof draft.accountId === "string" &&
    typeof draft.subject === "string" &&
    typeof draft.html === "string" &&
    isField(draft.to) &&
    isField(draft.cc) &&
    isField(draft.bcc) &&
    Array.isArray(draft.attachments)
  );
}

function readUnsaved(): Record<string, UnsavedDraft> {
  const result: Record<string, UnsavedDraft> = {};
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(UNSAVED_KEY) ?? "{}",
    );
    for (const entry of Object.values(value ?? {})) {
      const { draft, baseRevision } = (entry ?? {}) as Partial<UnsavedDraft>;
      if (!isDraft(draft)) continue;
      result[draft.idempotencyKey] = {
        draft,
        baseRevision: typeof baseRevision === "number" ? baseRevision : null,
      };
    }
    const legacy: unknown = JSON.parse(
      window.localStorage.getItem(LEGACY_KEY) ?? "null",
    );
    if (isDraft(legacy)) {
      result[legacy.idempotencyKey] ??= { draft: legacy, baseRevision: null };
    }
  } catch {
    // 読めなければ、置いてあるものは無い扱いにする。
  }
  return result;
}

function writeUnsaved(entries: Record<string, UnsavedDraft>): boolean {
  try {
    if (Object.keys(entries).length > 0) {
      window.localStorage.setItem(UNSAVED_KEY, JSON.stringify(entries));
    } else {
      window.localStorage.removeItem(UNSAVED_KEY);
    }
    window.localStorage.removeItem(LEGACY_KEY);
    return true;
  } catch {
    return false;
  }
}

/** この端末に置いてある、サーバーへ保存し終えていない下書き。 */
export function loadUnsavedDrafts(): UnsavedDraft[] {
  return Object.values(readUnsaved());
}

/** サーバーへ保存し終えるまでの間、下書きをこの端末に置く。置けたら true。 */
export function storeUnsavedDraft(entry: UnsavedDraft): boolean {
  return writeUnsaved({
    ...readUnsaved(),
    [entry.draft.idempotencyKey]: entry,
  });
}

/** サーバーへ保存し終えた (または破棄・送信した) 下書きを、この端末から消す。 */
export function removeUnsavedDraft(id: string): void {
  const entries = readUnsaved();
  if (!(id in entries)) {
    // 以前の版の置き場だけが残っている場合も、ここで片付ける。
    try {
      window.localStorage.removeItem(LEGACY_KEY);
    } catch {
      // 消せなくても支障は無い。
    }
    return;
  }
  delete entries[id];
  writeUnsaved(entries);
}
