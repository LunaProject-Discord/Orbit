import type { ImapFlow } from "imapflow";
import { FolderWatcher } from "./folder-watcher.js";
import type { SpecialUse } from "./mailbox-list.js";

/**
 * 受信トレイ以外のフォルダの変化を、定期的な確認を待たずに受け取る仕組み。
 *
 * - サーバーが NOTIFY (RFC 5465) に対応していれば、接続を 1 本だけ足して全フォルダの変化を
 *   受け取る (Dovecot など)。
 * - 対応していなければ、大事なフォルダから順に、フォルダごとに接続を張って IDLE する
 *   (IDLE で通知を受けられるのは接続ごとに 1 つのフォルダだけ)。メールサーバーには同時接続数の
 *   上限がある (Gmail は 1 アカウント 15 本) ので、張る本数には上限を設ける。
 *
 * どちらも通知を受けるだけで、実際の突き合わせは同期用の接続が行う。
 */

/** フォルダ用に足す接続の本数として設定できる最大値。 */
export const MAX_PUSH_CONNECTIONS = 8;
/** 接続を張れなかったあと、本数を減らしたままにしておく時間。 */
export const PUSH_REDUCED_MS = 30 * 60_000;

const MIN_RETRY_MS = 10_000;
const MAX_RETRY_MS = 5 * 60_000;

/**
 * フォルダ用に足す接続の本数。設定 (mail_accounts.push_connections) があればそれを、
 * 無ければサービスに合わせた数を使う。
 * 同期用 1 本、開いているフォルダ用 1 本、本文や添付の取得用 1 本を別に使うので、
 * 他のメールソフトの分を残せるよう控えめにしてある。Gmail は「すべてのメール」と
 * 「迷惑メール」の 2 つで全ラベルの変化が分かる。
 */
export function pushConnectionLimit(account: {
  provider: string;
  pushConnections: number | null;
}): number {
  const value =
    account.pushConnections ?? (account.provider === "gmail" ? 2 : 3);
  return Math.min(Math.max(Math.trunc(value), 0), MAX_PUSH_CONNECTIONS);
}

export type PushCandidate = {
  path: string;
  specialUse: SpecialUse | null;
  /** いちばん新しいメールの日時。メールが無ければ null。 */
  latestAt: Date | null;
};

/**
 * IDLE する順番。迷惑メール (誤判定された新着)、送信済み (他の端末から送った分)、
 * 利用者が作ったフォルダ (サーバー側の振り分け先) を先にする。
 */
const IDLE_ORDER: (SpecialUse | null)[] = [
  "junk",
  "sent",
  null,
  "archive",
  "drafts",
  "trash",
];
/**
 * Gmail は「すべてのメール」に迷惑メールとごみ箱以外の全メールが入っているので、
 * そこを見張れば、どのラベルに届いた変化も分かる (変化があれば全フォルダを確認する)。
 */
const GMAIL_IDLE_ORDER: SpecialUse[] = ["all", "junk", "trash"];

/**
 * フォルダごとに IDLE する対象を、大事な順に並べて返す (呼び出し側が上限で切る)。
 * 受信トレイは同期用の接続が IDLE しているので含めない。
 */
export function idleTargets(
  candidates: PushCandidate[],
  provider: string,
  /** すでに見張っているフォルダ。同じ種類の中では、これを優先して張り直しを避ける。 */
  watching: ReadonlySet<string> = new Set(),
): string[] {
  const usable = candidates.filter(
    (item) =>
      item.specialUse !== "inbox" &&
      item.specialUse !== "flagged" &&
      item.path.toUpperCase() !== "INBOX",
  );
  if (
    provider === "gmail" &&
    usable.some((item) => item.specialUse === "all")
  ) {
    return GMAIL_IDLE_ORDER.flatMap((role) =>
      usable.filter((item) => item.specialUse === role),
    ).map((item) => item.path);
  }
  const rank = (item: PushCandidate) => {
    const index = IDLE_ORDER.indexOf(item.specialUse);
    return index === -1 ? IDLE_ORDER.length : index;
  };
  return usable
    .filter((item) => item.specialUse !== "all")
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        Number(watching.has(b.path)) - Number(watching.has(a.path)) ||
        // 同じ種類の中では、最近メールが届いたフォルダを先にする。
        (b.latestAt?.getTime() ?? 0) - (a.latestAt?.getTime() ?? 0) ||
        a.path.localeCompare(b.path),
    )
    .map((item) => item.path);
}

/** modified UTF-7 (RFC 3501 5.1.3) のフォルダ名を元に戻す。 */
export function decodeMailboxName(encoded: string): string {
  return encoded.replace(/&([^-]*)-/g, (whole, body: string) => {
    if (body === "") return "&";
    const bytes = Buffer.from(body.replace(/,/g, "/"), "base64");
    if (bytes.length < 2) return whole;
    let text = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      text += String.fromCharCode(bytes.readUInt16BE(i));
    }
    return text;
  });
}

type ImapToken = { type?: string; value?: unknown } | ImapToken[];
type Untagged = { attributes?: ImapToken[] };

/** NOTIFY で届いた STATUS 応答から、フォルダのパスを取り出す。 */
export function notifiedPath(untagged: Untagged, utf8: boolean): string | null {
  const first = untagged.attributes?.[0];
  if (!first || Array.isArray(first)) return null;
  const value =
    typeof first.value === "string"
      ? first.value
      : Buffer.isBuffer(first.value)
        ? first.value.toString()
        : null;
  if (!value) return null;
  const path = utf8 ? value : decodeMailboxName(value);
  return path.toUpperCase() === "INBOX" ? "INBOX" : path;
}

export type NotifyEvent =
  /** フォルダの中身 (メールの追加・削除・フラグ) が変わった。 */
  | { kind: "mailbox"; path: string }
  /** フォルダが作られた・消された・名前が変わった、または通知を受け始めた。 */
  | { kind: "folders" };

/** ImapFlow の、型に出ていない部分。 */
type RawClient = ImapFlow & {
  untaggedHandlers: Record<
    string,
    ((untagged: Untagged) => unknown) | null | undefined
  >;
  exec(
    command: string,
    attributes: unknown,
    options?: unknown,
  ): Promise<{ next: () => void }>;
};

const atom = (value: string) => ({ type: "ATOM", value });

/**
 * NOTIFY (RFC 5465) で、全フォルダの変化を 1 本の接続で受け取る。
 * 接続では NOTIFY を設定したあと受信トレイを読み取り専用で開いて IDLE に入り
 * (接続の維持は ImapFlow に任せる)、他のフォルダの変化を STATUS 応答で受け取る。
 * ほかのコマンドは流さない (STATUS などの応答と通知が混ざらないようにするため)。
 * サーバーが NOTIFY を断った場合は onUnsupported を呼んで終わる。
 */
export class NotifyWatcher {
  private client: ImapFlow | null = null;
  private closed = false;
  private connected = false;
  private wakeRetry: (() => void) | null = null;

  constructor(
    private readonly createClient: () => Promise<ImapFlow>,
    private readonly onEvent: (event: NotifyEvent) => void,
    private readonly onUnsupported: (reason: string) => void,
    private readonly log: (message: string) => void,
  ) {
    void this.run();
  }

  /** いま通知を受けられているか。 */
  get active() {
    return this.connected;
  }

  close() {
    this.closed = true;
    this.connected = false;
    this.client?.close();
    this.client = null;
    this.wakeRetry?.();
  }

  private async run() {
    let retry = MIN_RETRY_MS;
    let warned = false;
    while (!this.closed) {
      let client: RawClient | null = null;
      try {
        const created = (await this.createClient()) as RawClient;
        client = created;
        if (this.closed) return;
        this.client = created;
        const closed = new Promise<void>((resolve) =>
          created.on("close", resolve),
        );
        created.on("error", () => {});
        await created.connect();
        if (this.closed) return;
        if (!created.capabilities.has("NOTIFY")) {
          this.giveUp("サーバーが NOTIFY に対応していません");
          return;
        }
        const utf8 = created.enabled.has("UTF8=ACCEPT");
        created.untaggedHandlers.STATUS = (untagged) => {
          const path = notifiedPath(untagged, utf8);
          if (path && !this.closed) this.onEvent({ kind: "mailbox", path });
        };
        created.untaggedHandlers.LIST = () => {
          if (!this.closed) this.onEvent({ kind: "folders" });
        };
        try {
          // 個人用の全フォルダについて、メールの追加・削除・フラグの変化と、
          // フォルダの作成・削除・名前の変更を知らせてもらう。
          const response = await created.exec("NOTIFY", [
            atom("SET"),
            [
              atom("personal"),
              [
                atom("MessageNew"),
                atom("MessageExpunge"),
                atom("FlagChange"),
                atom("MailboxName"),
              ],
            ],
          ]);
          response.next();
        } catch (error) {
          const err = error as Error & {
            responseStatus?: string;
            responseText?: string;
          };
          if (err.responseStatus === "NO" || err.responseStatus === "BAD") {
            this.giveUp(err.responseText || err.message);
            return;
          }
          throw error;
        }
        await created.mailboxOpen("INBOX", { readOnly: true });
        if (this.closed) return;
        this.connected = true;
        retry = MIN_RETRY_MS;
        warned = false;
        // 接続までの間に起きた変化を取りこぼさないよう、一度確認させる。
        this.onEvent({ kind: "folders" });
        await closed;
      } catch (error) {
        if (!this.closed && !warned) {
          warned = true;
          const reason = error instanceof Error ? error.message : String(error);
          this.log(
            `フォルダの変化を受け取る接続 (NOTIFY) を張れませんでした。定期的な確認で同期を続けます: ${reason}`,
          );
        }
      } finally {
        this.connected = false;
        client?.close();
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, retry);
        this.wakeRetry = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wakeRetry = null;
      retry = Math.min(retry * 2, MAX_RETRY_MS);
    }
  }

  private giveUp(reason: string) {
    this.closed = true;
    this.connected = false;
    this.onUnsupported(reason);
  }
}

type PushOptions = {
  createClient: () => Promise<ImapFlow>;
  onEvent: (event: NotifyEvent) => void;
  log: (message: string) => void;
  /** フォルダ用に足してよい接続の本数。0 なら何も張らない。 */
  limit: number;
  provider: string;
  now?: () => number;
};

/**
 * 受信トレイ以外のフォルダの通知を受ける接続をまとめて管理する。
 * NOTIFY が使えればそれを、使えなければ上限までフォルダごとの IDLE を張る。
 */
export class FolderPush {
  private notify: NotifyWatcher | null = null;
  private notifyUnsupported = false;
  private readonly watchers = new Map<string, FolderWatcher>();
  private candidates: PushCandidate[] = [];
  private notifySupported = false;
  private reducedLimit: number | null = null;
  private reducedUntil = 0;
  private suspendedUntil = 0;
  private closed = false;
  private readonly now: () => number;

  constructor(private readonly options: PushOptions) {
    this.now = options.now ?? Date.now;
  }

  /** NOTIFY で全フォルダの通知を受けられているか。 */
  get notifyActive() {
    return this.notify?.active ?? false;
  }

  /** そのフォルダの通知を、いま受けられているか。 */
  isActive(path: string) {
    return this.notifyActive || (this.watchers.get(path)?.active ?? false);
  }

  /** そのフォルダの通知を受ける接続を、張っているか張ろうとしているか。 */
  isWatching(path: string) {
    return this.notify !== null || this.watchers.has(path);
  }

  /** フォルダごとの IDLE で見張っているフォルダ。 */
  get idlePaths() {
    return [...this.watchers.keys()];
  }

  /**
   * フォルダの一覧が分かるたびに呼ぶ。張る接続を、いまの一覧と上限に合わせる。
   * notifySupported は、サーバーが NOTIFY を名乗っているか。
   */
  configure(candidates: PushCandidate[], notifySupported: boolean) {
    this.candidates = candidates;
    this.notifySupported = notifySupported;
    this.reconcile();
  }

  /** 同期用の接続をつなぎ直したとき。一時的な不調で減らした本数を元に戻す。 */
  reset() {
    this.reducedLimit = null;
    this.reducedUntil = 0;
  }

  /**
   * 同期用の接続がログインを断られた (同時接続数の上限など)。フォルダ用の接続をすべて
   * 手放し、しばらくは張らない。同期用の接続を優先するためで、つなぎ直しても解除しない。
   */
  suspend() {
    this.suspendedUntil = this.now() + PUSH_REDUCED_MS;
    this.release();
  }

  close() {
    this.closed = true;
    this.release();
  }

  private release() {
    this.notify?.close();
    this.notify = null;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  private reconcile() {
    if (this.closed) return;
    const { limit } = this.options;
    if (limit <= 0 || this.now() < this.suspendedUntil) return;

    if (this.notifySupported && !this.notifyUnsupported) {
      for (const watcher of this.watchers.values()) watcher.close();
      this.watchers.clear();
      this.notify ??= new NotifyWatcher(
        this.options.createClient,
        this.options.onEvent,
        (reason) => {
          this.options.log(
            `NOTIFY を使えないので、フォルダごとの接続 (IDLE) に切り替えます: ${reason}`,
          );
          this.notify = null;
          this.notifyUnsupported = true;
          this.reconcile();
        },
        this.options.log,
      );
      return;
    }

    if (this.reducedLimit !== null && this.now() >= this.reducedUntil) {
      this.reducedLimit = null;
    }
    const allowed = Math.min(limit, this.reducedLimit ?? limit);
    const wanted = idleTargets(
      this.candidates,
      this.options.provider,
      new Set(this.watchers.keys()),
    ).slice(0, allowed);
    for (const [path, watcher] of this.watchers) {
      if (!wanted.includes(path)) {
        watcher.close();
        this.watchers.delete(path);
      }
    }
    for (const path of wanted) {
      if (this.watchers.has(path)) continue;
      const watcher = new FolderWatcher(
        this.options.createClient,
        (changed) => this.options.onEvent({ kind: "mailbox", path: changed }),
        this.options.log,
        (failed, reason) => this.onGiveUp(failed, reason),
      );
      this.watchers.set(path, watcher);
      watcher.watch(path);
    }
  }

  /**
   * フォルダ用の接続を張れなかった。同時接続数の上限に当たったとみなして、
   * しばらくは、いま張れている本数までに抑える (他のメールソフトの分を奪わないため)。
   */
  private onGiveUp(path: string, reason: string) {
    if (this.closed) return;
    const watcher = this.watchers.get(path);
    if (!watcher) return;
    this.watchers.delete(path);
    this.reducedLimit = this.watchers.size;
    this.reducedUntil = this.now() + PUSH_REDUCED_MS;
    this.options.log(
      `フォルダ用の接続 (${path}) を張れませんでした。しばらくは ${this.watchers.size} 本に抑え、ほかのフォルダは定期的な確認で同期します: ${reason}`,
    );
  }
}
