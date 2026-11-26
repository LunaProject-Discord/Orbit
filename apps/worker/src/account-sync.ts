import {
  type BodyFetchPriority,
  decryptCredentials,
  GoogleAccessTokenSource,
  type GoogleOAuthConfig,
  GoogleOAuthError,
  legacyTlsOptions,
} from "@orbit/core";
import { type Database, mailAccounts, mailboxes } from "@orbit/db";
import { and, eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import {
  AttachmentRequests,
  ImapAttachmentDownloader,
} from "./attachment-fetch.js";
import {
  BodyRequests,
  imapBodyFetcher,
  imapHeaderFetcher,
} from "./body-fetch.js";
import { recordChanges } from "./changes.js";
import { imapDraftRemote } from "./draft-imap.js";
import { dbDraftStore, processDrafts } from "./draft-sync.js";
import {
  FolderPush,
  type NotifyEvent,
  pushConnectionLimit,
} from "./folder-push.js";
import { FolderWatcher } from "./folder-watcher.js";
import { createRejectionLogger } from "./imap-rejection.js";
import { isTemporaryLoginRefusal } from "./login-refusal.js";
import {
  isSelectable,
  type MailboxStatus,
  needsSync,
  type SpecialUse,
  syncPriority,
} from "./mailbox-list.js";
import { renameMailboxPaths } from "./mailbox-operations.js";
import {
  fetchBodies,
  fetchHeaders,
  loadMailboxStates,
  mailboxesWithPendingBodies,
  mailboxesWithPendingHeaders,
  STATUS_QUERY,
  syncMailbox,
  syncMailboxList,
} from "./mailbox-sync.js";
import { headerBackfillPause } from "./message-headers.js";
import { processOutbox } from "./outbox.js";
import { applyImapOperation } from "./outbox-imap.js";
import { processSends, type SendOutcome } from "./send.js";
import { sendViaSmtp } from "./send-smtp.js";

const INBOX = "INBOX";
const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** IDLE の通知を取りこぼした場合に備えた、定期的な突き合わせの間隔。 */
const PERIODIC_SYNC_MS = 10 * 60_000;
/**
 * 受信トレイ以外のフォルダを確認する間隔。通知を受ける接続 (FolderPush) を張れていない
 * フォルダは、定期的に件数や変更番号を確認する。
 */
const FOLDER_POLL_MS = 2 * 60_000;
/** NOTIFY で全フォルダの通知を受けられている間の、取りこぼしに備えた確認の間隔。 */
const NOTIFY_FOLDER_POLL_MS = 10 * 60_000;
/**
 * 受信トレイ以外のフォルダの作業 (初回の取り込みや本文の取得) を続けてよい時間。
 * その間は受信トレイの通知を受け取れないので、これを過ぎたら受信トレイを確認しに戻る。
 */
const BACKGROUND_SLICE_MS = 15_000;
/**
 * 利用者が画面を開いているとみなす時間。端末は 30 秒ごとに知らせてくるので、
 * 知らせが 2 回続けて届かなければ、開いていない扱いに戻す。
 */
const PRESENCE_TTL_MS = 75_000;
/**
 * 開いているフォルダ用の接続 (IDLE) を張れないときに、そのフォルダの状態を確認する間隔。
 * フォルダを開かずに件数や変更番号 (STATUS) を見るだけなので、短くしても負荷は小さい。
 */
const FOCUS_POLL_MS = 10_000;
/** 多くのサーバーは 30 分ほどで IDLE を切るので、その前に張り直す。 */
const MAX_IDLE_MS = 25 * 60_000;
/** 最後のコマンドから IDLE に入るまでの待ち時間。 */
const AUTO_IDLE_DELAY_MS = 1_000;

/**
 * 画面に出すエラーの説明。IMAP サーバーの応答文があればそれを使う。
 * DB のエラーは SQL や値を含むので、利用者には見せずログにだけ残す。
 */
function describeError(
  error: Error & { responseText?: string; query?: unknown },
): string {
  if (error.responseText) return error.responseText;
  if (error.query !== undefined || error.message.startsWith("Failed query")) {
    return "サーバー内部でエラーが発生しました。";
  }
  return error.message;
}

type AccountRow = typeof mailAccounts.$inferSelect;
type Status = AccountRow["status"];

/**
 * メールアカウント 1 件分の同期。IMAP に常時接続して全フォルダを同期する。
 * 受信トレイは IDLE で新着や既読の変化をすぐに受け取る。他のフォルダは、NOTIFY に対応した
 * サーバーなら接続を 1 本足して全フォルダの変化を、そうでなければ大事なフォルダだけ
 * フォルダごとの接続 (IDLE、本数に上限あり) で変化を受け取り、残りは定期的に確認する。
 * 利用者が受信トレイ以外のフォルダを開いている間は、そのフォルダ用にもう 1 本接続を張って
 * IDLE で変化を受け取る (すでに通知を受けていれば張らず、張れなければ 10 秒ごとの確認に切り替える)。
 * 切断されたら間隔を空けて再接続する。
 */
export class AccountSync {
  private stopped = false;
  private client: ImapFlow | null = null;
  private syncRequested = false;
  /** 受信トレイ以外のフォルダを確認する時刻になった。 */
  private foldersDue = true;
  /** 変更番号の無いサーバー向けに、次の確認では全フォルダを開いて突き合わせる。 */
  private forceFolders = false;
  /** 利用者が開いているフォルダ (受信トレイ以外)。開いていなければ null。 */
  private focus: { mailboxId: string; path: string } | null = null;
  private focusUntil = 0;
  /** 開いているフォルダを同期する。forced は、変化の通知を受けたので必ず突き合わせる。 */
  private focusDue: "check" | "forced" | null = null;
  private readonly watcher: FolderWatcher;
  /** 受信トレイ以外のフォルダの通知を受ける接続。 */
  private readonly push: FolderPush;
  /** 通知で変化が分かった、これから突き合わせるフォルダ (パス)。 */
  private readonly pushDue = new Set<string>();
  private foldersCheckedAt = 0;
  private wake: (() => void) | null = null;
  private backoff = MIN_BACKOFF_MS;
  private sending: Promise<void> = Promise.resolve();
  private readonly attachmentDownloader: ImapAttachmentDownloader;
  private readonly attachmentRequests: AttachmentRequests;
  private readonly bodyRequests: BodyRequests;
  /** OAuth2 のアカウント (Gmail) のアクセストークン。最初に使うときに用意する。 */
  private tokens: GoogleAccessTokenSource | null = null;
  /** 書く手が止まるのを待っている下書きを、メールサーバーへ置きに戻るためのタイマー。 */
  private draftTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Database,
    private readonly encryptionKey: Buffer,
    readonly account: AccountRow,
    /** 暗号化されていない SMTP 接続を許す (開発用のローカルサーバー向け)。 */
    private readonly allowInsecureSmtp = false,
    /** Gmail の OAuth2 用。未設定なら、OAuth2 の Gmail アカウントはエラーになる。 */
    private readonly google: GoogleOAuthConfig | null = null,
  ) {
    this.watcher = new FolderWatcher(
      () => this.createClient(),
      () => this.requestFocusSync("forced"),
      (message) => this.log(message),
    );
    this.push = new FolderPush({
      createClient: () => this.createClient(),
      onEvent: (event) => this.onPushEvent(event),
      log: (message) => this.log(message),
      limit: pushConnectionLimit(account),
      provider: account.provider,
    });
    this.attachmentDownloader = new ImapAttachmentDownloader(() =>
      this.createClient(),
    );
    this.attachmentRequests = new AttachmentRequests(
      db,
      account.id,
      this.attachmentDownloader.download,
      (message) => this.log(message),
    );
    this.bodyRequests = new BodyRequests(
      db,
      account,
      imapBodyFetcher(db, (task) => this.attachmentDownloader.withClient(task)),
      imapHeaderFetcher(db, (task) =>
        this.attachmentDownloader.withClient(task),
      ),
      (message) => this.log(message),
    );
  }

  /** 添付ファイルの実体を取得してほしい (利用者が開いた)。同期用とは別の接続で取得する。 */
  notifyAttachment(attachmentId: string) {
    if (!this.stopped) this.attachmentRequests.request(attachmentId);
  }

  /**
   * 利用者が見ているメールの本文を、取り込みの順番を待たずに取得してほしい。
   * 同期用の接続は一覧の取り込みで長く塞がることがあるので、別の接続で 1 通ずつ取得する。
   */
  notifyBody(messageIds: string[], priority: BodyFetchPriority) {
    if (!this.stopped) this.bodyRequests.request(messageIds, priority);
  }

  private log(message: string, error?: unknown) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    console.log(`[${this.account.email}] ${message}${detail}`);
  }

  /** 停止されるか、再ログインが必要になるまで動き続ける。 */
  async run() {
    while (!this.stopped) {
      try {
        await this.session();
      } catch (error) {
        if (this.stopped) break;
        const err = error as Error & {
          authenticationFailed?: boolean;
          responseText?: string;
        };
        const reason = describeError(err);
        if (error instanceof GoogleOAuthError && error.needsReauth) {
          // リフレッシュトークンの取り消しや期限切れ。ログインし直すまで同期できない。
          this.log(`Google へのログインし直しが必要です: ${reason}`);
          await this.setStatus(
            "auth_required",
            "Google へのログインの有効期限が切れたか、アクセスが取り消されました。",
          );
          return;
        }
        if (err.authenticationFailed && isTemporaryLoginRefusal(err)) {
          // 同時接続数の上限や混雑で、ログインを断られた。パスワードの誤りではないので、
          // 再ログインは求めない。フォルダ用に足した接続を手放して、間隔を空けてつなぎ直す。
          this.log(
            `サーバーが接続を受け付けませんでした (接続数の上限など)。フォルダ用の接続を減らしてつなぎ直します: ${reason}`,
          );
          this.push.suspend();
          this.watcher.close();
          await this.setStatus("error", reason);
        } else if (err.authenticationFailed && this.tokens?.invalidate()) {
          // 古くなったアクセストークンが拒否された。取り直してつなぎ直す。
          this.log("アクセストークンを取り直して再接続します");
        } else if (err.authenticationFailed) {
          // パスワードが変わった場合など。繰り返すとロックされかねないので止める。
          this.log(`認証に失敗しました。再ログインが必要です: ${reason}`);
          await this.setStatus("auth_required", reason);
          return;
        } else {
          this.log(`同期中にエラーが発生しました: ${err.message}`);
          await this.setStatus("error", reason);
        }
      }
      if (this.stopped) break;
      const delay = this.backoff * (0.75 + Math.random() * 0.5);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      await this.sleep(delay);
    }
  }

  stop() {
    this.stopped = true;
    this.wake?.();
    this.watcher.close();
    this.push.close();
    this.attachmentDownloader.close();
    this.client?.close();
  }

  /**
   * 利用者が画面を開いている。mailboxId は開いているフォルダ (受信トレイなら null)。
   * refresh は、利用者がフォルダの更新を指示したこと。開いているフォルダをすぐに確認し直す。
   */
  notifyFocus(mailboxId: string | null, refresh = false) {
    this.focusUntil = Date.now() + PRESENCE_TTL_MS;
    if (mailboxId === (this.focus?.mailboxId ?? null)) {
      if (!refresh) return;
      // 受信トレイ (見張っているフォルダが無い) は、通常の同期で確認する。
      if (this.focus) this.requestFocusSync("forced");
      else this.requestSync();
      return;
    }
    // フォルダが変わったときは、切り替えた直後に確認する (setFocus)。
    // 受信トレイは見張りの対象にならないので、更新の指示なら通常の同期で確認する。
    void this.setFocus(mailboxId);
    if (refresh) this.requestSync();
  }

  private async setFocus(mailboxId: string | null) {
    let focus: typeof this.focus = null;
    if (mailboxId) {
      try {
        const [row] = await this.db
          .select({ path: mailboxes.path, specialUse: mailboxes.specialUse })
          .from(mailboxes)
          .where(
            and(
              eq(mailboxes.id, mailboxId),
              eq(mailboxes.accountId, this.account.id),
            ),
          );
        // 受信トレイは同期用の接続が IDLE しているので、別に見張る必要は無い。
        if (row && row.specialUse !== "inbox" && row.path !== INBOX) {
          focus = { mailboxId, path: row.path };
        }
      } catch (error) {
        this.log("開いているフォルダを確認できませんでした", error);
      }
    }
    if (this.stopped || Date.now() > this.focusUntil) focus = null;
    this.focus = focus;
    this.watchFocus();
    // 開いた直後のフォルダは、定期的な確認を待たずに同期する。
    if (focus) this.requestFocusSync("forced");
  }

  /**
   * 開いているフォルダ用の接続を張る。フォルダの通知をすでに別の接続で受けている場合は、
   * 同じフォルダに 2 本張らない。
   */
  private watchFocus() {
    const path = this.focus?.path ?? null;
    this.watcher.watch(
      path !== null && this.push.isWatching(path) ? null : path,
    );
  }

  /** 受信トレイ以外のフォルダに変化があったという通知が届いた。 */
  private onPushEvent(event: NotifyEvent) {
    if (this.stopped) return;
    if (event.kind === "folders") this.foldersDue = true;
    else if (event.path !== INBOX) this.pushDue.add(event.path);
    this.wake?.();
  }

  private requestFocusSync(kind: "check" | "forced") {
    if (this.focusDue !== "forced") this.focusDue = kind;
    this.wake?.();
  }

  /** 画面が閉じられた (知らせが途絶えた) ら見張りをやめ、IDLE できない間は定期的に確認させる。 */
  private tickFocus() {
    if (!this.focus) return;
    if (Date.now() > this.focusUntil) {
      this.focus = null;
      this.watcher.close();
      return;
    }
    this.watchFocus();
    if (!this.watcher.active && !this.push.isActive(this.focus.path)) {
      this.requestFocusSync("check");
    }
  }

  /** 送信待ちキューに操作が積まれた。すぐに反映する。 */
  notifyOutbox() {
    this.requestSync();
    this.flushSends();
  }

  /**
   * 送信待ちのメールを SMTP で送る。IMAP の接続とは別なので、同期が止まっていても送れる。
   * 同時には 1 回だけ走らせる。
   */
  private flushSends() {
    this.sending = this.sending
      .then(async () => {
        if (this.stopped) return;
        const result = await processSends(
          this.db,
          this.account,
          (message) => this.sendMessage(message),
          (message) => this.log(message),
        );
        if (result.sent > 0) this.log(`メールを ${result.sent} 通送信しました`);
        // 送信済みフォルダへの保存などを、同期の接続で反映させる。
        if (result.queued) this.requestSync();
      })
      .catch((error) =>
        this.log("送信待ちのメールを処理できませんでした", error),
      );
  }

  private async sendMessage(
    message: Parameters<typeof sendViaSmtp>[1],
  ): Promise<SendOutcome> {
    const { smtpHost, smtpPort } = this.account;
    if (!smtpHost || !smtpPort) {
      return {
        status: "failed",
        reason: "SMTP サーバーが設定されていません。",
      };
    }
    let auth: Awaited<ReturnType<AccountSync["credentials"]>>;
    try {
      auth = await this.credentials();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // 取り消されたログインは、やり直しても通らない。それ以外 (通信の不調など) は待ってやり直す。
      return error instanceof GoogleOAuthError && !error.needsReauth
        ? { status: "retry", reason }
        : {
            status: "failed",
            reason: `メールアカウントにログインできませんでした: ${reason}`,
          };
    }
    return sendViaSmtp(
      {
        host: smtpHost,
        port: smtpPort,
        secure: this.account.smtpSecure,
        username: this.account.username,
        ...auth,
        allowInsecure: this.allowInsecureSmtp,
        allowLegacyTls: this.account.allowLegacyTls,
      },
      message,
    );
  }

  /**
   * IMAP / SMTP のログインに使う認証情報。パスワード、または OAuth2 のアクセストークン
   * (XOAUTH2)。アクセストークンは期限が近づいたら取り直す。
   */
  private async credentials(): Promise<
    { password: string } | { accessToken: string }
  > {
    const credentials = decryptCredentials(
      this.account.credentialsEncrypted,
      this.encryptionKey,
      this.account.userId,
    );
    if (credentials.type === "password") {
      return { password: credentials.password };
    }
    if (this.account.provider !== "gmail") {
      throw new Error("このサービスの OAuth2 にはまだ対応していません。");
    }
    if (!this.google) {
      throw new Error(
        "サーバーに Google のログイン (GOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET) が設定されていません。",
      );
    }
    this.tokens ??= new GoogleAccessTokenSource(
      this.google,
      credentials.refreshToken,
    );
    return { accessToken: await this.tokens.get() };
  }

  private requestSync() {
    this.syncRequested = true;
    this.wake?.();
  }

  /**
   * まだメールサーバーへ置いていない下書きを、下書きフォルダへ置く。
   * フォルダを選択し直すので、他のフォルダのロックを取る前に行う。
   */
  private async syncDrafts(client: ImapFlow) {
    const result = await processDrafts(
      dbDraftStore(this.db, this.account),
      this.account,
      imapDraftRemote(client, async () => {
        const [row] = await this.db
          .select({ path: mailboxes.path })
          .from(mailboxes)
          .where(
            and(
              eq(mailboxes.accountId, this.account.id),
              eq(mailboxes.specialUse, "drafts"),
            ),
          );
        return row?.path ?? null;
      }),
      (message) => this.log(message),
    );
    if (result.saved > 0) {
      this.log(`下書きを ${result.saved} 件、メールサーバーへ保存しました`);
      // 置いた控えを、下書きフォルダの同期で取り込む。
      this.foldersDue = true;
    }
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer =
      result.nextDueAt === null
        ? null
        : setTimeout(
            () => this.requestSync(),
            Math.max(0, result.nextDueAt - Date.now()) + 100,
          );
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(timer);
        self.wake = null;
        resolve();
      }
      this.wake = done;
    });
  }

  private async setStatus(status: Status, lastError: string | null = null) {
    try {
      await this.db.transaction(async (tx) => {
        const [row] = await tx
          .update(mailAccounts)
          .set({ status, lastError })
          .where(eq(mailAccounts.id, this.account.id))
          .returning({ id: mailAccounts.id });
        if (row) {
          await recordChanges(tx, this.account.userId, "account", "upsert", [
            row.id,
          ]);
        }
      });
    } catch (error) {
      this.log("状態を保存できませんでした", error);
    }
  }

  private async createClient() {
    const auth = await this.credentials();
    if (!this.account.imapHost || !this.account.imapPort) {
      throw new Error("IMAP サーバーが設定されていません。");
    }
    // サーバーに拒否された命令の応答だけを覚える (失敗の理由として利用者に見せる)。
    const rejections = createRejectionLogger();
    const client = new ImapFlow({
      host: this.account.imapHost,
      port: this.account.imapPort,
      secure: this.account.imapSecure,
      tls: legacyTlsOptions(this.account.allowLegacyTls),
      auth:
        "accessToken" in auth
          ? { user: this.account.username, accessToken: auth.accessToken }
          : { user: this.account.username, pass: auth.password },
      logger: rejections.logger,
      // 既定の 15 秒だと、同期直後に起きた変化の通知がその分だけ遅れる。
      autoIdleDelay: AUTO_IDLE_DELAY_MS,
      maxIdleTime: MAX_IDLE_MS,
    });
    rejections.attach(client);
    return client;
  }

  /** 受信トレイ 1 回分の同期。 */
  private async syncInbox(client: ImapFlow) {
    const lock = await client.getMailboxLock(INBOX);
    try {
      const result = await syncMailbox(this.db, client, this.account, INBOX);
      if (result.added > 0 || result.removed > 0) {
        this.log(
          `受信トレイを同期しました (追加 ${result.added} 件、削除 ${result.removed} 件)`,
        );
      }
    } finally {
      lock.release();
    }
  }

  /**
   * フォルダを開く。サーバーに拒否された場合 (消された直後など) は null を返し、
   * 接続の問題はそのまま投げる。
   */
  private async openMailbox(client: ImapFlow, path: string) {
    try {
      return await client.getMailboxLock(path);
    } catch (error) {
      const err = error as Error & { responseStatus?: string };
      if (err.responseStatus !== "NO" && err.responseStatus !== "BAD") {
        throw error;
      }
      this.log(`フォルダ ${path} を開けませんでした`, err);
      return null;
    }
  }

  /**
   * 受信トレイ以外のフォルダを同期する。フォルダ一覧と各フォルダの状態 (STATUS) を
   * 取得し、変化のあったフォルダだけを開いて突き合わせる。
   * 受信トレイに変化があるか、一定時間が過ぎたら切り上げて false を返す
   * (残りは受信トレイを確認したあとで続ける)。
   */
  private async syncOtherFolders(client: ImapFlow): Promise<boolean> {
    const force = this.forceFolders;
    const deadline = Date.now() + BACKGROUND_SLICE_MS;
    const shouldStop = () =>
      this.stopped ||
      this.syncRequested ||
      this.focusDue !== null ||
      this.pushDue.size > 0 ||
      Date.now() > deadline;
    const listed = await syncMailboxList(this.db, client, this.account, true);
    const states = await loadMailboxStates(this.db, this.account.id);
    this.push.configure(
      [...states.values()],
      client.capabilities.has("NOTIFY"),
    );
    const targets = listed
      .filter((entry) => isSelectable(entry) && entry.path !== INBOX)
      .flatMap((entry) => {
        const state = states.get(entry.path);
        return state ? [{ entry, state }] : [];
      })
      .sort(
        (a, b) =>
          syncPriority(a.state.specialUse) - syncPriority(b.state.specialUse),
      );

    for (const { entry, state } of targets) {
      if (shouldStop()) return false;
      const status = entry.status as MailboxStatus | undefined;
      if (!needsSync(state, status, force)) continue;
      const lock = await this.openMailbox(client, entry.path);
      if (!lock) continue;
      try {
        const result = await syncMailbox(
          this.db,
          client,
          this.account,
          entry.path,
          shouldStop,
        );
        if (result.added > 0 || result.removed > 0) {
          this.log(
            `${entry.path} を同期しました (追加 ${result.added} 件、削除 ${result.removed} 件)`,
          );
        }
        if (!result.complete) return false;
      } finally {
        lock.release();
      }
    }
    this.forceFolders = false;
    this.foldersCheckedAt = Date.now();
    return true;
  }

  /**
   * 通知で変化が分かったフォルダを、定期的な確認を待たずに突き合わせる。
   * 通知ではフラグの変化も届くので、件数などを見比べずに必ず開く。
   */
  private async syncPushed(client: ImapFlow) {
    const paths = [...this.pushDue];
    this.pushDue.clear();
    const states = await loadMailboxStates(this.db, this.account.id);
    for (const [index, path] of paths.entries()) {
      const state = states.get(path);
      if (!state) {
        // まだ知らないフォルダ。フォルダ一覧から取り直す。
        this.foldersDue = true;
        continue;
      }
      // Gmail の「すべてのメール」の変化は、どのラベルの変化か分からない。全フォルダを確認する。
      if (state.specialUse === "all") this.foldersDue = true;
      const lock = await this.openMailbox(client, path);
      if (!lock) continue;
      let complete = true;
      try {
        const result = await syncMailbox(
          this.db,
          client,
          this.account,
          path,
          () => this.stopped || this.syncRequested,
        );
        if (result.added > 0 || result.removed > 0) {
          this.log(
            `${path} を同期しました (追加 ${result.added} 件、削除 ${result.removed} 件)`,
          );
        }
        complete = result.complete;
      } finally {
        lock.release();
      }
      if (!complete || this.stopped || this.syncRequested) {
        // 受信トレイを確認してから続ける。
        const rest = complete ? paths.slice(index + 1) : paths.slice(index);
        for (const item of rest) this.pushDue.add(item);
        return;
      }
    }
  }

  /**
   * 利用者が開いているフォルダを同期する。変化の通知を受けた場合 (forced) は必ず開いて
   * 突き合わせ、定期的な確認 (check) では件数や変更番号が変わったときだけ開く。
   */
  private async syncFocused(client: ImapFlow, kind: "check" | "forced") {
    const focus = this.focus;
    if (!focus) return;
    if (kind === "check") {
      let status: MailboxStatus;
      try {
        const result = await client.status(focus.path, STATUS_QUERY);
        if (!result) return;
        status = result;
      } catch (error) {
        const err = error as Error & { responseStatus?: string };
        if (err.responseStatus !== "NO" && err.responseStatus !== "BAD") {
          throw error;
        }
        return;
      }
      const state = (
        await loadMailboxStates(this.db, this.account.id, focus.mailboxId)
      ).get(focus.path);
      if (!state || !needsSync(state, status, false)) return;
    }
    const lock = await this.openMailbox(client, focus.path);
    if (!lock) return;
    try {
      const result = await syncMailbox(
        this.db,
        client,
        this.account,
        focus.path,
        () => this.stopped || this.syncRequested,
      );
      if (result.added > 0 || result.removed > 0) {
        this.log(
          `${focus.path} を同期しました (追加 ${result.added} 件、削除 ${result.removed} 件)`,
        );
      }
      // 取り込みを途中で切り上げた場合は、受信トレイを確認してから続ける。
      if (!result.complete) this.requestFocusSync("forced");
    } finally {
      lock.release();
    }
  }

  /**
   * 本文をまだ取得していないメッセージの本文を、フォルダごとに取得する。
   * 時間がかかるので、新しい変化が来たら中断して同期を優先する。
   * priorityOnly は、他のフォルダの一覧の取り込みがまだ残っている間の呼び出し。
   * 利用者が開いているフォルダと受信トレイの分だけを、一定時間だけ進める。
   */
  private async fetchPendingBodies(client: ImapFlow, priorityOnly = false) {
    const deadline = Date.now() + BACKGROUND_SLICE_MS;
    const interrupted = () =>
      this.stopped ||
      this.syncRequested ||
      (!priorityOnly && this.foldersDue) ||
      this.focusDue !== null ||
      this.pushDue.size > 0;
    // 利用者が開いているフォルダを最初に、あとは決まった順に取得する。
    const rank = (mailbox: { id: string; specialUse: SpecialUse | null }) =>
      mailbox.id === this.focus?.mailboxId
        ? -1
        : syncPriority(mailbox.specialUse);
    const pending = (await mailboxesWithPendingBodies(this.db, this.account.id))
      .filter(
        (mailbox) =>
          !priorityOnly ||
          mailbox.id === this.focus?.mailboxId ||
          mailbox.path === INBOX,
      )
      .sort((a, b) => rank(a) - rank(b));
    for (const mailbox of pending) {
      if (interrupted()) return;
      // 受信トレイを開いている間は通知が届くので、時間で区切らなくてよい
      // (他のフォルダの一覧の取り込みが残っている場合は、そちらへ戻るために区切る)。
      const expired = () =>
        (priorityOnly || mailbox.path !== INBOX) && Date.now() > deadline;
      const lock = await this.openMailbox(client, mailbox.path);
      if (!lock) continue;
      let remaining = true;
      try {
        while (remaining && !interrupted() && !expired()) {
          remaining = await fetchBodies(
            this.db,
            client,
            this.account,
            mailbox.id,
          );
        }
      } finally {
        lock.release();
      }
      if (remaining && expired()) {
        // 受信トレイを確認してから続きを取得する。
        if (!priorityOnly) this.syncRequested = true;
        return;
      }
    }
  }

  /**
   * 代理送信やメーリングリストの情報を、これらの項目を足す前に取り込んだメールへ補う。
   * 急がない作業なので、本文の取得がすべて終わってから、他の作業の合間に進める。
   */
  private async fetchPendingHeaders(client: ImapFlow) {
    const deadline = Date.now() + BACKGROUND_SLICE_MS;
    const interrupted = () =>
      this.stopped ||
      this.syncRequested ||
      this.foldersDue ||
      this.focusDue !== null ||
      this.pushDue.size > 0;
    const pending = await mailboxesWithPendingHeaders(this.db, this.account.id);
    for (const mailbox of pending) {
      if (interrupted()) return;
      const lock = await this.openMailbox(client, mailbox.path);
      if (!lock) continue;
      let remaining = true;
      try {
        while (remaining && !interrupted() && Date.now() <= deadline) {
          remaining = await fetchHeaders(
            this.db,
            client,
            this.account,
            mailbox.id,
          );
          if (remaining) await headerBackfillPause();
        }
      } finally {
        lock.release();
      }
      if (remaining && Date.now() > deadline) {
        // 受信トレイを確認してから続きを取得する。
        this.syncRequested = true;
        return;
      }
    }
  }

  /** 接続 1 回分。切断されると戻る (エラーなら投げる)。 */
  private async session() {
    const client = await this.createClient();
    if (this.stopped) {
      client.close();
      return;
    }
    this.client = client;
    let connectionError: Error | null = null;
    const closed = new Promise<void>((resolve) => client.on("close", resolve));
    client.on("error", (error) => {
      connectionError = error;
    });
    // 選択中のフォルダ (受信トレイ) の変化。コマンドの合間は ImapFlow が自動で IDLE に入り、
    // サーバーからの通知がここに届く。他のフォルダを開いている間の通知は無視する。
    const onChange = (event?: { path?: string }) => {
      if (event?.path === undefined || event.path === INBOX) {
        this.requestSync();
      }
    };
    client.on("exists", onChange);
    client.on("expunge", onChange);
    client.on("flags", onChange);
    client.on("highestModseq", onChange);

    const periodic = setInterval(() => {
      this.forceFolders = true;
      this.requestSync();
    }, PERIODIC_SYNC_MS);
    const folderPoll = setInterval(() => {
      // NOTIFY で全フォルダの通知が届いている間は、取りこぼしに備えた確認だけにする。
      if (
        this.push.notifyActive &&
        Date.now() - this.foldersCheckedAt < NOTIFY_FOLDER_POLL_MS
      ) {
        return;
      }
      this.foldersDue = true;
      this.wake?.();
    }, FOLDER_POLL_MS);
    const focusPoll = setInterval(() => this.tickFocus(), FOCUS_POLL_MS);
    try {
      await client.connect();
      if (this.stopped) return;
      this.log("IMAP に接続しました");
      await syncMailboxList(this.db, client, this.account);
      this.foldersDue = true;
      // つなぎ直せたので、接続を張れずに減らしていた本数を元に戻す。
      this.push.reset();
      let healthy = false;

      while (!this.stopped && client.usable) {
        this.syncRequested = false;
        // 既読や移動などの操作を先にサーバーへ反映してから、同期で突き合わせる。
        // 対象のフォルダを選択し直すので、他のフォルダのロックを取る前に行う。
        const outbox = await processOutbox(
          this.db,
          this.account.id,
          async (operation) => {
            const result = await applyImapOperation(client, operation);
            if (result.ok && operation.kind === "mailbox_rename") {
              await renameMailboxPaths(
                this.db,
                this.account,
                operation.payload,
              );
            }
            return result;
          },
          (message) => this.log(message),
        );
        // 移動先のフォルダなど、受信トレイ以外にも変化がある。
        if (outbox.done > 0 || outbox.failed > 0) this.foldersDue = true;
        await this.syncDrafts(client);

        await this.syncInbox(client);
        if (!healthy) {
          healthy = true;
          this.backoff = MIN_BACKOFF_MS;
          await this.setStatus("active");
        }
        if (this.focusDue && !this.syncRequested) {
          const kind = this.focusDue;
          this.focusDue = null;
          await this.syncFocused(client, kind);
        }
        if (this.pushDue.size > 0 && !this.syncRequested && !this.focusDue) {
          await this.syncPushed(client);
        }
        let foldersRemain = false;
        if (
          this.foldersDue &&
          !this.syncRequested &&
          !this.focusDue &&
          this.pushDue.size === 0
        ) {
          // 確認中に次の時刻が来た場合に取りこぼさないよう、先に下ろしておく。
          this.foldersDue = false;
          if (!(await this.syncOtherFolders(client))) {
            this.foldersDue = true;
            foldersRemain = true;
          }
        }
        const pending = () =>
          this.syncRequested ||
          this.foldersDue ||
          this.focusDue !== null ||
          this.pushDue.size > 0;
        if (!pending()) await this.fetchPendingBodies(client);
        else if (
          foldersRemain &&
          !this.syncRequested &&
          !this.focusDue &&
          this.pushDue.size === 0
        ) {
          // メールの多いアカウントでは、他のフォルダの一覧の取り込みに長くかかる。
          // その間も、開いているフォルダと受信トレイの本文は交互に少しずつ進める。
          await this.fetchPendingBodies(client, true);
        }
        if (!this.stopped && !pending()) await this.fetchPendingHeaders(client);
        if (this.stopped || pending()) continue;

        // IDLE で通知を受けるフォルダを受信トレイに戻す。
        if (client.mailbox === false || client.mailbox.path !== INBOX) {
          await client.mailboxOpen(INBOX);
        }
        if (pending()) continue;
        await Promise.race([
          closed,
          new Promise<void>((resolve) => {
            this.wake = resolve;
          }),
        ]);
        this.wake = null;
      }
      if (connectionError) throw connectionError;
      if (!this.stopped) this.log("接続が切れました。再接続します");
    } finally {
      clearInterval(periodic);
      clearInterval(folderPoll);
      clearInterval(focusPoll);
      if (this.draftTimer) clearTimeout(this.draftTimer);
      this.draftTimer = null;
      this.wake = null;
      this.client = null;
      client.close();
    }
  }
}
