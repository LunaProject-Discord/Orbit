import { Readable } from "node:stream";
import {
  type BodyFetchPriority,
  decryptCredentials,
  Pop3Client,
  Pop3Error,
  type Pop3Settings,
} from "@orbit/core";
import {
  type Database,
  type mailAccounts,
  mailAccounts as mailAccountsTable,
  messageSources,
} from "@orbit/db";
import { eq } from "drizzle-orm";
import {
  type AttachmentDownloader,
  AttachmentRequests,
} from "./attachment-fetch.js";
import { recordChanges } from "./changes.js";
import { isTemporaryLoginRefusal } from "./login-refusal.js";
import { headerBackfillPause } from "./message-headers.js";
import { processOutbox } from "./outbox.js";
import { extractAttachment } from "./pop-parse.js";
import {
  applyPopOperation,
  backfillPopHeaders,
  ensurePopMailboxes,
  forgetPopRecords,
  importRawMessage,
  loadPopRecords,
  selectPopDeletions,
} from "./pop-store.js";
import { processSends, type SendOutcome } from "./send.js";
import { sendViaSmtp } from "./send-smtp.js";

const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** 画面を開いている間に、新しいメールを確かめる間隔。 */
const PRESENT_POLL_MS = 60_000;
/** 画面を開いていない間の間隔。POP3 は通知の仕組みが無いので、定期的に確かめる。 */
const IDLE_POLL_MS = 5 * 60_000;
/** 利用者が画面を開いているとみなす時間 (端末は 30 秒ごとに知らせてくる)。 */
const PRESENCE_TTL_MS = 75_000;
/** 1 通の大きさの上限。これより大きなメールは取り込まない。 */
const MAX_MESSAGE_BYTES = 50 * 1024 * 1024;
/**
 * 1 回の接続で取り込む数の上限。初回に大量のメールがあっても、接続を長く握り続けず、
 * 区切りごとにサーバーからの削除や送信待ちの操作を挟む。
 */
const IMPORT_BATCH = 100;

type AccountRow = typeof mailAccounts.$inferSelect;
type Status = AccountRow["status"];

/** 画面に出すエラーの説明。DB のエラーは SQL や値を含むので、利用者には見せない。 */
function describeError(error: Error & { query?: unknown }): string {
  if (error instanceof Pop3Error) return error.message;
  if (error.query !== undefined || error.message.startsWith("Failed query")) {
    return "サーバー内部でエラーが発生しました。";
  }
  return error.message;
}

/** 受け取りの 1 回分の結果。 */
export type PopReceiveResult = {
  imported: number;
  deleted: number;
  /** 上限に達して、取り込み残しがある。 */
  more: boolean;
};

/** テストで差し替えられるよう、POP3 の接続を作る関数を受け取る。 */
export type Pop3Factory = (
  settings: Pop3Settings,
) => Pick<
  Pop3Client,
  "connect" | "uidl" | "list" | "retr" | "dele" | "quit" | "destroy"
>;

/**
 * POP3 のサーバーからメールを受け取る (1 回分)。
 * UIDL で取り込み済みかを見分け、新しいものだけを新しい順に取り込む。
 * そのあと、設定に従ってサーバーから消し、QUIT で確定させる。
 */
export async function receivePop(
  db: Database,
  account: AccountRow,
  inboxId: string,
  client: ReturnType<Pop3Factory>,
  options: { stopped: () => boolean; log: (message: string) => void },
): Promise<PopReceiveResult> {
  await client.connect();
  try {
    const listing = await client.uidl();
    const sizes = await client.list();
    const records = await loadPopRecords(db, account.id);
    // 記録が 1 件も無ければ初回の取り込み。昔のメールまで新着として知らせない。
    const initial = records.size === 0;
    const onServer = new Map<string, number>();
    for (const [number, uidl] of listing) onServer.set(uidl, number);

    // 新しいもの (番号の大きいもの) から取り込む。
    const fresh = [...listing]
      .filter(([, uidl]) => !records.has(uidl))
      .sort((a, b) => b[0] - a[0]);
    let imported = 0;
    for (const [number, uidl] of fresh.slice(0, IMPORT_BATCH)) {
      if (options.stopped()) break;
      const size = sizes.get(number) ?? 0;
      if (size > MAX_MESSAGE_BYTES) {
        options.log(
          `大きすぎるメール (${Math.round(size / 1024 / 1024)} MB) は取り込みません: ${uidl}`,
        );
        continue;
      }
      const raw = await client.retr(number);
      const result = await importRawMessage(db, account, inboxId, raw, {
        uidl,
        announce: !initial,
      });
      if (result) imported++;
    }

    // サーバーから消すもの。今回取り込んだ分も含めて、記録を読み直して決める。
    const deletions = options.stopped()
      ? []
      : selectPopDeletions(
          await loadPopRecords(db, account.id),
          onServer.keys(),
          {
            leaveOnServer: account.popLeaveOnServer,
            deleteAfterDays: account.popDeleteAfterDays,
          },
        );
    for (const uidl of deletions) {
      const number = onServer.get(uidl);
      if (number !== undefined) await client.dele(number);
    }
    await client.quit();

    // サーバーに無くなったメール (消したもの、ほかのメールソフトが消したもの) の記録は要らない。
    const gone = [...records.keys()].filter((uidl) => !onServer.has(uidl));
    await forgetPopRecords(db, account.id, [...gone, ...deletions]);
    return {
      imported,
      deleted: deletions.length,
      more: fresh.length > IMPORT_BATCH,
    };
  } catch (error) {
    // QUIT せずに切ると、付けた削除の印は取り消される (サーバーのメールは消えない)。
    client.destroy();
    throw error;
  }
}

/** 保存しておいた原文から、添付ファイルを取り出す。 */
export function popAttachmentDownloader(db: Database): AttachmentDownloader {
  return async (target, sink) => {
    const [source] = await db
      .select({ raw: messageSources.raw })
      .from(messageSources)
      .where(eq(messageSources.messageId, target.messageId));
    if (!source) return false;
    const file = await extractAttachment(source.raw, target.partId);
    if (!file) return false;
    await sink(Readable.from([file.content]));
    return true;
  };
}

/**
 * POP3 で受け取るアカウント 1 件分の同期。
 * 定期的に POP3 サーバーへつなぎ、新しいメールを受信トレイへ取り込む
 * (画面を開いている間は 1 分ごと、そうでなければ 5 分ごと)。
 * フォルダ・既読・移動などはこのアプリの中だけで持ち、送信は SMTP で行う。
 */
export class PopAccountSync {
  account: AccountRow;
  private stopped = false;
  private wake: (() => void) | null = null;
  private wakeRequested = false;
  private backoff = MIN_BACKOFF_MS;
  private presentUntil = 0;
  private sending: Promise<void> = Promise.resolve();
  private readonly attachmentRequests: AttachmentRequests;

  constructor(
    private readonly db: Database,
    private readonly encryptionKey: Buffer,
    account: AccountRow,
    /** 暗号化されていない接続を許す (開発用のローカルサーバー向け)。 */
    private readonly allowInsecure = false,
    private readonly createClient: Pop3Factory = (settings) =>
      new Pop3Client(settings),
  ) {
    this.account = account;
    this.attachmentRequests = new AttachmentRequests(
      db,
      account.id,
      popAttachmentDownloader(db),
      (message) => this.log(message),
    );
  }

  private log(message: string) {
    console.log(`[${this.account.email}] ${message}`);
  }

  /** 本文は取り込んだときに入れてあるので、取りに行くものは無い。 */
  notifyBody(_messageIds: string[], _priority: BodyFetchPriority) {}

  /** 添付ファイルを、保存しておいた原文から取り出す。 */
  notifyAttachment(attachmentId: string) {
    if (!this.stopped) this.attachmentRequests.request(attachmentId);
  }

  /** 送信待ちキューに操作が積まれた (手動の同期の依頼もここに来る)。すぐに受信も確かめる。 */
  notifyOutbox() {
    this.requestWake();
    this.flushSends();
  }

  /** 利用者が画面を開いた。開いた直後は、次の確認を待たずに受信を確かめる。 */
  notifyFocus(_mailboxId: string | null, refresh = false) {
    const wasPresent = Date.now() < this.presentUntil;
    this.presentUntil = Date.now() + PRESENCE_TTL_MS;
    // refresh は、利用者がフォルダの更新を指示したこと。POP3 は受信トレイしか無いので、受信を確かめる。
    if (!wasPresent || refresh) this.requestWake();
  }

  stop() {
    this.stopped = true;
    this.wake?.();
  }

  /** 停止されるか、パスワードの入れ直しが必要になるまで動き続ける。 */
  async run() {
    while (!this.stopped) {
      try {
        await this.session();
      } catch (error) {
        if (this.stopped) break;
        const err = error as Error;
        const reason = describeError(err);
        if (
          err instanceof Pop3Error &&
          err.kind === "auth" &&
          !isTemporaryLoginRefusal({
            responseText: err.responseText ?? undefined,
          })
        ) {
          // パスワードが変わった場合など。繰り返すとロックされかねないので止める。
          this.log(
            `認証に失敗しました。パスワードの入れ直しが必要です: ${reason}`,
          );
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

  private requestWake() {
    this.wakeRequested = true;
    this.wake?.();
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  private password(): string {
    const credentials = decryptCredentials(
      this.account.credentialsEncrypted,
      this.encryptionKey,
      this.account.userId,
    );
    if (credentials.type !== "password") {
      throw new Error("このアカウントにはパスワードが保存されていません。");
    }
    return credentials.password;
  }

  /** 送信待ちのメールを SMTP で送る。受信とは別に、同時には 1 回だけ走らせる。 */
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
        // 送信済みフォルダへの控えの保存を、次の周回で反映させる。
        if (result.queued) this.requestWake();
      })
      .catch((error) =>
        this.log(
          `送信待ちのメールを処理できませんでした: ${error instanceof Error ? error.message : ""}`,
        ),
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
    let password: string;
    try {
      password = this.password();
    } catch (error) {
      return {
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return sendViaSmtp(
      {
        host: smtpHost,
        port: smtpPort,
        secure: this.account.smtpSecure,
        username: this.account.username,
        password,
        allowInsecure: this.allowInsecure,
        allowLegacyTls: this.account.allowLegacyTls,
      },
      message,
    );
  }

  private async setStatus(status: Status, lastError: string | null = null) {
    try {
      await this.db.transaction(async (tx) => {
        const [row] = await tx
          .update(mailAccountsTable)
          .set({ status, lastError })
          .where(eq(mailAccountsTable.id, this.account.id))
          .returning({ id: mailAccountsTable.id });
        if (row) {
          await recordChanges(tx, this.account.userId, "account", "upsert", [
            row.id,
          ]);
        }
      });
    } catch (error) {
      this.log(
        `状態を保存できませんでした: ${error instanceof Error ? error.message : ""}`,
      );
    }
  }

  /** 同期 1 回分。エラーが起きると投げ、run() が間隔を空けてやり直す。 */
  private async session() {
    const { imapHost, imapPort } = this.account;
    if (!imapHost || !imapPort) {
      throw new Error("POP3 サーバーが設定されていません。");
    }
    const inboxId = await ensurePopMailboxes(this.db, this.account);
    let healthy = false;
    // 起動前に積まれていた送信待ちのメールを送る。
    this.flushSends();

    while (!this.stopped) {
      this.wakeRequested = false;
      // 既読や移動などの操作は DB の中で完結しているので、後始末だけ行う。
      await processOutbox(
        this.db,
        this.account.id,
        (operation) => applyPopOperation(this.db, this.account, operation),
        (message) => this.log(message),
      );

      const client = this.createClient({
        host: imapHost,
        port: imapPort,
        secure: this.account.imapSecure,
        username: this.account.username,
        password: this.password(),
        allowLegacyTls: this.account.allowLegacyTls,
        allowInsecure: this.allowInsecure,
      });
      const result = await receivePop(this.db, this.account, inboxId, client, {
        stopped: () => this.stopped,
        log: (message) => this.log(message),
      });
      if (result.imported > 0 || result.deleted > 0) {
        this.log(
          `POP3 サーバーから受信しました (取り込み ${result.imported} 件、サーバーから削除 ${result.deleted} 件)`,
        );
      }
      // 項目を足す前に取り込んだメールに、認証結果などを補う (原文から読むので通信は無い)。
      while (
        !this.stopped &&
        (await backfillPopHeaders(this.db, this.account))
      ) {
        // DB が重くならないよう、間を空けて少しずつ進める。
        await headerBackfillPause();
      }
      if (!healthy) {
        healthy = true;
        this.backoff = MIN_BACKOFF_MS;
        this.log("POP3 サーバーに接続しました");
        await this.setStatus("active");
      }
      if (this.stopped) break;
      // 取り込み残しがあれば、待たずに続ける。
      if (result.more) continue;
      const present = Date.now() < this.presentUntil;
      const wait = present ? PRESENT_POLL_MS : IDLE_POLL_MS;
      if (!this.wakeRequested) await this.sleep(wait);
    }
  }
}
