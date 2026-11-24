/**
 * 通知の返信欄から送る返信を組み立てる。
 * スマホアプリの通知の返信欄は、アプリを開かずにサーバーへ文章だけを送ってくるので、
 * 宛先・件名・署名・引用はサーバーが決める。画面の返信欄 (Web の quick-reply) と同じく、
 * 並びは「書いた文章、署名、元のメールの引用」にする。
 *
 * 元のメールの引用は、テキストだけにする (サーバーには HTML を安全に整える仕組みが無いため。
 * 画面からの返信では書式を保った引用になる)。
 */

export type ReplyAddress = { name?: string; address: string };

/** 返信の元になるメール。 */
export type ReplySource = {
  from: ReplyAddress[];
  to: ReplyAddress[];
  replyTo: ReplyAddress[];
  subject: string;
  /** 本文 (テキスト)。無ければ HTML から作る。どちらも無ければ引用しない。 */
  bodyText: string | null;
  bodyHtml: string | null;
  sentAt: Date | null;
  receivedAt: Date;
};

export type NotificationReply = {
  to: ReplyAddress[];
  subject: string;
  text: string;
  html: string;
};

/** 引用する本文の長さの上限 (長いメールへの返信が膨らみすぎないようにする)。 */
const MAX_QUOTE_LENGTH = 20_000;

export function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeLines(text: string): string {
  return text.replace(/\r\n?/g, "\n").trimEnd();
}

/** テキストを、1 行ずつの <div> にする (空行は <div><br></div>)。画面の作成画面と同じ形。 */
function linesToHtml(text: string): string {
  return normalizeLines(text)
    .split("\n")
    .map((line) => `<div>${line ? escapeHtmlText(line) : "<br>"}</div>`)
    .join("");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** HTML を、おおまかなテキストにする (署名と、テキストの無いメールの引用に使う)。 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (name.startsWith("#x") || name.startsWith("#X")) {
        const code = Number.parseInt(name.slice(2), 16);
        return Number.isFinite(code) ? safeChar(code, entity) : entity;
      }
      if (name.startsWith("#")) {
        const code = Number.parseInt(name.slice(1), 10);
        return Number.isFinite(code) ? safeChar(code, entity) : entity;
      }
      return ENTITIES[name.toLowerCase()] ?? entity;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeChar(code: number, fallback: string): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/**
 * 署名の HTML から、動く中身 (スクリプト、埋め込み、on〜 属性、javascript: のリンク) を除く。
 * 署名は本人が書いたものだが、画面では整えてから入れているので、ここでも最低限は落とす。
 */
export function stripActiveContent(html: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|iframe|object|embed|link|meta)[^>]*\/?>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(
      /(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi,
      '$1="#"',
    );
}

function withRe(subject: string): string {
  return /^\s*re\s*[:：]/i.test(subject) ? subject : `Re: ${subject}`.trimEnd();
}

function addressFull(entry: ReplyAddress): string {
  return entry.name ? `${entry.name} <${entry.address}>` : entry.address;
}

const DATE_FORMAT = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * 返信の宛先。画面の返信 (lib/compose.ts の buildDraftFrom) と同じ決め方:
 * 自分が送ったメールへの返信は元の宛先へ、それ以外は返信先 (Reply-To)、無ければ差出人へ。
 */
export function replyRecipients(
  source: Pick<ReplySource, "from" | "to" | "replyTo">,
  ownAddresses: readonly string[],
): ReplyAddress[] {
  const own = new Set(ownAddresses.map((address) => address.toLowerCase()));
  const fromSelf =
    source.from.length > 0 &&
    source.from.every((entry) => own.has(entry.address.toLowerCase()));
  if (fromSelf) return source.to;
  return source.replyTo.length > 0 ? source.replyTo : source.from;
}

export function buildNotificationReply(input: {
  source: ReplySource;
  /** 利用者のメールアカウントのアドレス (自分宛ての返信を見分ける)。 */
  ownAddresses: readonly string[];
  /** 返信に付ける署名 (書式付き)。無ければ null。 */
  signatureHtml: string | null;
  /** 通知の返信欄に書いた文章。 */
  text: string;
}): NotificationReply {
  const { source } = input;
  const text = normalizeLines(input.text);
  const signatureHtml = input.signatureHtml?.trim()
    ? stripActiveContent(input.signatureHtml)
    : "";
  const signatureText = signatureHtml ? htmlToPlainText(signatureHtml) : "";
  const quoted = (
    source.bodyText?.trim()
      ? normalizeLines(source.bodyText)
      : source.bodyHtml
        ? htmlToPlainText(source.bodyHtml)
        : ""
  ).slice(0, MAX_QUOTE_LENGTH);
  const sender = source.from[0];
  const attribution =
    `${DATE_FORMAT.format(source.sentAt ?? source.receivedAt)} ${
      sender ? addressFull(sender) : ""
    }:`.trimEnd();

  const empty = "<div><br></div>";
  const htmlParts = [linesToHtml(text)];
  const textParts = [text];
  if (signatureText) {
    htmlParts.push(empty, `<div data-signature="">${signatureHtml}</div>`);
    textParts.push("", signatureText);
  }
  if (quoted) {
    htmlParts.push(
      empty,
      `<div data-quote=""><div>${escapeHtmlText(attribution)}</div><blockquote>${linesToHtml(quoted)}</blockquote></div>`,
    );
    textParts.push(
      "",
      attribution,
      ...quoted.split("\n").map((line) => (line ? `> ${line}` : ">")),
    );
  }
  return {
    to: replyRecipients(source, input.ownAddresses),
    subject: withRe(source.subject),
    text: textParts.join("\n"),
    html: htmlParts.join(""),
  };
}
