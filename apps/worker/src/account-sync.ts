import { decryptCredentials } from "@mail/core";
import { type Database, mailAccounts } from "@mail/db";
import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { recordChanges } from "./changes.js";
import { fetchBodies, syncMailbox, syncMailboxList } from "./mailbox-sync.js";
import { processOutbox } from "./outbox.js";
import { applyImapOperation } from "./outbox-imap.js";
import { processSends, type SendOutcome } from "./send.js";
import { sendViaSmtp } from "./send-smtp.js";

const INBOX = "INBOX";
const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** IDLE の通知を取りこぼした場合に備えた、定期的な突き合わせの間隔。 */
const PERIODIC_SYNC_MS = 10 * 60_000;
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
 * メールアカウント 1 件分の同期。IMAP に常時接続して受信トレイを同期し、
 * IDLE で新着や既読の変化を受け取る。切断されたら間隔を空けて再接続する。
 */
export class AccountSync {
  private stopped = false;
  private client: ImapFlow | null = null;
  private syncRequested = false;
  private wake: (() => void) | null = null;
  private backoff = MIN_BACKOFF_MS;
  private sending: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Database,
    private readonly encryptionKey: Buffer,
    readonly account: AccountRow,
    /** 暗号化されていない SMTP 接続を許す (開発用のローカルサーバー向け)。 */
    private readonly allowInsecureSmtp = false,
  ) {}

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
        if (err.authenticationFailed) {
          // パスワードが変わった場合など。繰り返すとロックされかねないので止める。
          this.log(`認証に失敗しました。再ログインが必要です: ${reason}`);
          await this.setStatus("auth_required", reason);
          return;
        }
        this.log(`同期中にエラーが発生しました: ${err.message}`);
        await this.setStatus("error", reason);
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
    this.client?.close();
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
    const credentials = decryptCredentials(
      this.account.credentialsEncrypted,
      this.encryptionKey,
      this.account.userId,
    );
    if (credentials.type !== "password") {
      return {
        status: "failed",
        reason: "SMTP の OAuth2 にはまだ対応していません。",
      };
    }
    return sendViaSmtp(
      {
        host: smtpHost,
        port: smtpPort,
        secure: this.account.smtpSecure,
        username: this.account.username,
        password: credentials.password,
        allowInsecure: this.allowInsecureSmtp,
      },
      message,
    );
  }

  private requestSync() {
    this.syncRequested = true;
    this.wake?.();
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

  private createClient() {
    const credentials = decryptCredentials(
      this.account.credentialsEncrypted,
      this.encryptionKey,
      this.account.userId,
    );
    if (credentials.type !== "password") {
      throw new Error("IMAP の OAuth2 にはまだ対応していません。");
    }
    if (!this.account.imapHost || !this.account.imapPort) {
      throw new Error("IMAP サーバーが設定されていません。");
    }
    return new ImapFlow({
      host: this.account.imapHost,
      port: this.account.imapPort,
      secure: this.account.imapSecure,
      auth: { user: this.account.username, pass: credentials.password },
      logger: false,
      // 既定の 15 秒だと、同期直後に起きた変化の通知がその分だけ遅れる。
      autoIdleDelay: AUTO_IDLE_DELAY_MS,
      maxIdleTime: MAX_IDLE_MS,
    });
  }

  /** 接続 1 回分。切断されると戻る (エラーなら投げる)。 */
  private async session() {
    const client = this.createClient();
    this.client = client;
    let connectionError: Error | null = null;
    const closed = new Promise<void>((resolve) => client.on("close", resolve));
    client.on("error", (error) => {
      connectionError = error;
    });
    // 選択中のフォルダの変化。コマンドの合間は ImapFlow が自動で IDLE に入り、
    // サーバーからの通知がここに届く。
    const onChange = () => this.requestSync();
    client.on("exists", onChange);
    client.on("expunge", onChange);
    client.on("flags", onChange);
    client.on("highestModseq", onChange);

    const periodic = setInterval(onChange, PERIODIC_SYNC_MS);
    try {
      await client.connect();
      if (this.stopped) return;
      this.log("IMAP に接続しました");
      await syncMailboxList(this.db, client, this.account);
      await client.mailboxOpen(INBOX);
      let healthy = false;

      while (!this.stopped && client.usable) {
        this.syncRequested = false;
        // 既読や移動などの操作を先にサーバーへ反映してから、同期で突き合わせる。
        // 対象のフォルダを選択し直すので、受信トレイのロックを取る前に行う。
        await processOutbox(
          this.db,
          this.account.id,
          (operation) => applyImapOperation(client, operation),
          (message) => this.log(message),
        );
        const lock = await client.getMailboxLock(INBOX);
        try {
          const result = await syncMailbox(
            this.db,
            client,
            this.account,
            INBOX,
          );
          if (result.added > 0 || result.removed > 0) {
            this.log(
              `受信トレイを同期しました (追加 ${result.added} 件、削除 ${result.removed} 件)`,
            );
          }
          if (!healthy) {
            healthy = true;
            this.backoff = MIN_BACKOFF_MS;
            await this.setStatus("active");
          }
          // 本文の取得は時間がかかるので、新しい変化が来たら中断して同期を優先する。
          while (
            !this.stopped &&
            !this.syncRequested &&
            (await fetchBodies(this.db, client, this.account, result.mailboxId))
          ) {
            // 続きを取得する
          }
        } finally {
          lock.release();
        }
        if (this.stopped || this.syncRequested) continue;
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
      this.wake = null;
      this.client = null;
      client.close();
    }
  }
}
