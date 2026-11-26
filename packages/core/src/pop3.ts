import net from "node:net";
import tls from "node:tls";
import { legacyTlsOptions } from "./legacy-tls.js";

/**
 * POP3 (RFC 1939) の小さなクライアント。受信に要るコマンドだけを持つ。
 * USER / PASS でログインし、UIDL・LIST・RETR・DELE・QUIT を使う。
 * secure が false のときは STLS (RFC 2595) で暗号化してからログインする。
 */

export type Pop3Settings = {
  host: string;
  port: number;
  /** true なら最初から TLS (995 番など)、false なら STLS で切り替える (110 番など)。 */
  secure: boolean;
  username: string;
  password: string;
  /** 安全な再ネゴシエーションに対応していない古いサーバーへの接続を許す。 */
  allowLegacyTls?: boolean;
  /** STLS に対応していないサーバーへ、パスワードを平文で送ってよい (開発用)。 */
  allowInsecure?: boolean;
  /** 接続してから最初の応答までの上限 (ミリ秒)。 */
  connectionTimeout?: number;
  /** 応答を待つ上限 (ミリ秒)。大きなメールの受け取り中も、データが届いていれば延びる。 */
  socketTimeout?: number;
};

/**
 * POP3 の失敗。kind が auth ならログインを断られた (パスワードの誤りなど)、
 * rejected ならログイン後のコマンドを断られた、connection なら接続や通信の問題。
 */
export class Pop3Error extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "rejected" | "connection",
    /** サーバーの応答 (-ERR の後ろ)。無ければ null。 */
    readonly responseText: string | null = null,
  ) {
    super(message);
    this.name = "Pop3Error";
  }

  get authenticationFailed() {
    return this.kind === "auth";
  }
}

/** 複数行の応答の終わり (CRLF . CRLF)。 */
const TERMINATOR = Buffer.from("\r\n.\r\n");
/** 1 行の応答の上限。これを超えたらサーバーの異常として切る。 */
const MAX_LINE = 64 * 1024;

type Pending = {
  multiline: boolean;
  resolve: (value: { line: string; body: Buffer | null }) => void;
  reject: (error: Error) => void;
};

/** 複数行の応答の本文から、行頭のドットの重ね (dot-stuffing) を外す。 */
export function unstuff(body: Buffer): Buffer {
  // 本文は「先頭の行」か「CRLF の直後」で始まる行に ".." があれば 1 つ外す。
  const parts: Buffer[] = [];
  let start = 0;
  let lineStart = 0;
  while (lineStart < body.length) {
    if (body[lineStart] === 0x2e && body[lineStart + 1] === 0x2e) {
      parts.push(body.subarray(start, lineStart));
      start = lineStart + 1;
    }
    const next = body.indexOf("\r\n", lineStart);
    if (next === -1) break;
    lineStart = next + 2;
  }
  if (start === 0) return body;
  parts.push(body.subarray(start));
  return Buffer.concat(parts);
}

export class Pop3Client {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private queue: Pending[] = [];
  private closedError: Error | null = null;
  /** CAPA で分かったサーバーの機能 (大文字)。 */
  capabilities = new Set<string>();

  constructor(private readonly settings: Pop3Settings) {}

  /** 接続してログインする。失敗したら接続を閉じて Pop3Error を投げる。 */
  async connect(): Promise<void> {
    const { settings } = this;
    try {
      const greeting = await this.open();
      if (!greeting.startsWith("+OK")) {
        throw new Pop3Error(
          `POP3 サーバーが接続を断りました: ${greeting}`,
          "connection",
          greeting.replace(/^-ERR\s*/i, ""),
        );
      }
      await this.loadCapabilities();
      if (!settings.secure) {
        if (this.capabilities.has("STLS")) {
          await this.command("STLS");
          await this.upgrade();
          // 暗号化の前に聞いた機能は信用できないので、聞き直す。
          await this.loadCapabilities();
        } else if (!settings.allowInsecure) {
          throw new Pop3Error(
            "POP3 サーバーが暗号化 (STLS) に対応していないため、パスワードを送れません。SSL/TLS で接続してください。",
            "connection",
          );
        }
      }
      try {
        await this.command(`USER ${settings.username}`);
        await this.command(`PASS ${settings.password}`);
      } catch (error) {
        if (error instanceof Pop3Error && error.kind === "rejected") {
          throw new Pop3Error(
            `POP3 サーバーにログインできませんでした: ${error.responseText ?? ""}`,
            "auth",
            error.responseText,
          );
        }
        throw error;
      }
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  /** メッセージ番号ごとの一意な ID (UIDL)。 */
  async uidl(): Promise<Map<number, string>> {
    const { body } = await this.command("UIDL", true);
    const result = new Map<number, string>();
    for (const line of (body ?? Buffer.alloc(0))
      .toString("latin1")
      .split("\r\n")) {
      const match = /^(\d+)\s+(\S+)/.exec(line);
      if (match) result.set(Number(match[1]), match[2] as string);
    }
    return result;
  }

  /** メッセージ番号ごとの大きさ (バイト)。 */
  async list(): Promise<Map<number, number>> {
    const { body } = await this.command("LIST", true);
    const result = new Map<number, number>();
    for (const line of (body ?? Buffer.alloc(0))
      .toString("latin1")
      .split("\r\n")) {
      const match = /^(\d+)\s+(\d+)/.exec(line);
      if (match) result.set(Number(match[1]), Number(match[2]));
    }
    return result;
  }

  /** メッセージ 1 通をそのまま (RFC 5322 の形式で) 受け取る。 */
  async retr(messageNumber: number): Promise<Buffer> {
    const { body } = await this.command(`RETR ${messageNumber}`, true);
    return body ?? Buffer.alloc(0);
  }

  /** 削除の印を付ける。実際に消えるのは QUIT で終えたとき。 */
  async dele(messageNumber: number): Promise<void> {
    await this.command(`DELE ${messageNumber}`);
  }

  /** 終える。DELE を付けたメッセージは、ここでサーバーから消える。 */
  async quit(): Promise<void> {
    try {
      await this.command("QUIT");
    } finally {
      this.destroy();
    }
  }

  /** 終えずに切る (DELE の印は取り消される)。 */
  destroy() {
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
    this.fail(
      new Pop3Error("POP3 サーバーとの接続が切れました。", "connection"),
    );
  }

  private async loadCapabilities() {
    try {
      const { body } = await this.command("CAPA", true);
      this.capabilities = new Set(
        (body ?? Buffer.alloc(0))
          .toString("latin1")
          .split("\r\n")
          .map((line) => line.trim().split(/\s+/)[0]?.toUpperCase() ?? "")
          .filter(Boolean),
      );
    } catch (error) {
      // CAPA の無い古いサーバー。機能は分からないものとして続ける。
      if (!(error instanceof Pop3Error && error.kind === "rejected"))
        throw error;
      this.capabilities = new Set();
    }
  }

  /** 接続して、挨拶の行を返す。 */
  private open(): Promise<string> {
    const { settings } = this;
    const timeout = settings.connectionTimeout ?? 15_000;
    return new Promise<string>((resolve, reject) => {
      const socket = settings.secure
        ? tls.connect({
            host: settings.host,
            port: settings.port,
            servername: net.isIP(settings.host) ? undefined : settings.host,
            ...legacyTlsOptions(settings.allowLegacyTls === true),
          })
        : net.connect({ host: settings.host, port: settings.port });
      this.attach(socket);
      const timer = setTimeout(() => {
        reject(
          new Pop3Error(
            "POP3 サーバーから応答がありませんでした。",
            "connection",
          ),
        );
        this.destroy();
      }, timeout);
      this.queue.push({
        multiline: false,
        resolve: ({ line }) => {
          clearTimeout(timer);
          resolve(line);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  private attach(socket: net.Socket | tls.TLSSocket) {
    this.socket = socket;
    this.closedError = null;
    socket.setTimeout(this.settings.socketTimeout ?? 60_000);
    socket.on("data", (chunk: Buffer) => {
      if (this.socket !== socket) return;
      this.buffer =
        this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on("timeout", () => {
      if (this.socket !== socket) return;
      this.fail(
        new Pop3Error("POP3 サーバーの応答が途絶えました。", "connection"),
      );
      socket.destroy();
    });
    socket.on("error", (error) => {
      if (this.socket !== socket) return;
      this.fail(
        new Pop3Error(
          `POP3 サーバーに接続できませんでした: ${error.message}`,
          "connection",
        ),
      );
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.fail(
        new Pop3Error("POP3 サーバーとの接続が切れました。", "connection"),
      );
    });
  }

  /** STLS の応答を受けたあと、同じ接続を TLS に切り替える。 */
  private upgrade(): Promise<void> {
    const plain = this.socket;
    if (!plain) {
      return Promise.reject(
        new Pop3Error("POP3 サーバーとの接続が切れました。", "connection"),
      );
    }
    const { settings } = this;
    return new Promise<void>((resolve, reject) => {
      // 切り替える前の接続のイベントは、もう受け取らない。
      plain.removeAllListeners("data");
      plain.removeAllListeners("timeout");
      plain.removeAllListeners("close");
      plain.removeAllListeners("error");
      this.buffer = Buffer.alloc(0);
      const secure = tls.connect(
        {
          socket: plain,
          servername: net.isIP(settings.host) ? undefined : settings.host,
          ...legacyTlsOptions(settings.allowLegacyTls === true),
        },
        () => resolve(),
      );
      secure.once("error", (error) =>
        reject(
          new Pop3Error(
            `POP3 サーバーとの暗号化に失敗しました: ${error.message}`,
            "connection",
          ),
        ),
      );
      this.attach(secure);
    });
  }

  private command(
    line: string,
    multiline = false,
  ): Promise<{ line: string; body: Buffer | null }> {
    const socket = this.socket;
    if (!socket || this.closedError) {
      return Promise.reject(
        this.closedError ??
          new Pop3Error("POP3 サーバーとの接続が切れました。", "connection"),
      );
    }
    return new Promise((resolve, reject) => {
      this.queue.push({
        multiline,
        resolve: (response) => {
          if (response.line.startsWith("+OK")) {
            resolve(response);
            return;
          }
          const text = response.line.replace(/^-ERR\s*/i, "");
          reject(
            new Pop3Error(
              `POP3 サーバーが ${line.split(" ")[0]} を断りました: ${text}`,
              "rejected",
              text,
            ),
          );
        },
        reject,
      });
      socket.write(`${line}\r\n`);
    });
  }

  /** 届いたデータから、待っている応答を順に取り出す。 */
  private drain() {
    while (this.queue.length > 0) {
      const pending = this.queue[0] as Pending;
      const end = this.buffer.indexOf("\r\n");
      if (end === -1) {
        if (this.buffer.length > MAX_LINE) {
          this.fail(
            new Pop3Error("POP3 サーバーの応答が不正です。", "connection"),
          );
          this.socket?.destroy();
        }
        return;
      }
      const line = this.buffer.subarray(0, end).toString("utf8");
      // 失敗 (-ERR) の応答は複数行にならない。
      if (!pending.multiline || !line.startsWith("+OK")) {
        this.buffer = this.buffer.subarray(end + 2);
        this.queue.shift();
        pending.resolve({ line, body: null });
        continue;
      }
      // 本文が空なら、1 行目の直後がすぐ終わりの "." になる。
      const rest = this.buffer.subarray(end + 2);
      if (
        rest.length >= 3 &&
        rest.subarray(0, 3).equals(Buffer.from(".\r\n"))
      ) {
        this.buffer = rest.subarray(3);
        this.queue.shift();
        pending.resolve({ line, body: Buffer.alloc(0) });
        continue;
      }
      const stop = rest.indexOf(TERMINATOR);
      if (stop === -1) return;
      // 本文の最後の改行は残す (メールの最後の行の終わり)。
      const body = unstuff(rest.subarray(0, stop + 2));
      this.buffer = rest.subarray(stop + TERMINATOR.length);
      this.queue.shift();
      pending.resolve({ line, body });
    }
  }

  private fail(error: Error) {
    this.closedError ??= error;
    const queue = this.queue;
    this.queue = [];
    for (const pending of queue) pending.reject(error);
  }
}
