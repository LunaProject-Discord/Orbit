import {
  type AttachmentFetchError,
  type AttachmentReadyNotification,
  attachmentExists,
  attachmentKey,
  attachmentsDir,
  CHANNEL_ATTACHMENT_READY,
  storeReceivedAttachment,
} from "@mail/core";
import {
  attachments,
  type Database,
  mailAccounts,
  mailboxes,
  messageMailboxes,
  messages,
} from "@mail/db";
import { and, eq, sql } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import { type GraphClient, GraphError } from "./graph-client.js";

/** 取得する添付ファイルと、それを持つメールの所在。 */
export type AttachmentTarget = {
  id: string;
  userId: string;
  /** IMAP では BODYSTRUCTURE 上の位置、Microsoft Graph では添付ファイルの ID。 */
  partId: string;
  /** Microsoft Graph のメッセージ ID。IMAP では使わない。 */
  providerMessageId: string | null;
  /** メールがあるフォルダ (IMAP 用)。どれか 1 つから取得できればよい。 */
  locations: { path: string; uid: number; uidValidity: bigint | null }[];
};

/**
 * 実体をメールサーバーから読み、sink に渡す。メールや添付ファイルが無くなっていたら
 * sink を呼ばずに false を返す。
 */
export type AttachmentDownloader = (
  target: AttachmentTarget,
  sink: (body: AsyncIterable<Uint8Array>) => Promise<void>,
) => Promise<boolean>;

export async function loadAttachmentTarget(
  db: Database,
  accountId: string,
  attachmentId: string,
): Promise<AttachmentTarget | null> {
  const [row] = await db
    .select({
      id: attachments.id,
      partId: attachments.partId,
      messageId: messages.id,
      providerMessageId: messages.providerMessageId,
      userId: mailAccounts.userId,
    })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .innerJoin(mailAccounts, eq(mailAccounts.id, messages.accountId))
    .where(
      and(eq(attachments.id, attachmentId), eq(messages.accountId, accountId)),
    );
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    partId: row.partId,
    providerMessageId: row.providerMessageId,
    locations: await loadMessageLocations(db, row.messageId),
  };
}

/** メールがあるフォルダと、そこでの UID (IMAP 用)。 */
export async function loadMessageLocations(
  db: Database,
  messageId: string,
): Promise<AttachmentTarget["locations"]> {
  const placed = await db
    .select({
      path: mailboxes.path,
      uid: messageMailboxes.uid,
      uidValidity: mailboxes.uidValidity,
    })
    .from(messageMailboxes)
    .innerJoin(mailboxes, eq(mailboxes.id, messageMailboxes.mailboxId))
    .where(eq(messageMailboxes.messageId, messageId));
  return placed.flatMap((entry) =>
    entry.uid === null
      ? []
      : [
          {
            path: entry.path,
            uid: Number(entry.uid),
            uidValidity: entry.uidValidity,
          },
        ],
  );
}

/** 取得が終わったこと (失敗も含む) を API サーバーへ知らせる。 */
export async function notifyAttachmentReady(
  db: Database,
  attachmentId: string,
  error: AttachmentFetchError | null,
) {
  const payload: AttachmentReadyNotification = { attachmentId, error };
  await db.execute(
    sql`select pg_notify(${CHANNEL_ATTACHMENT_READY}, ${JSON.stringify(payload)})`,
  );
}

/**
 * 添付ファイル 1 件を取得して置き場に保存する。すでに置き場にあれば何もしない。
 * 戻り値は失敗の理由 (成功なら null)。
 */
export async function fetchAttachment(
  db: Database,
  accountId: string,
  attachmentId: string,
  download: AttachmentDownloader,
  dir = attachmentsDir(),
): Promise<AttachmentFetchError | null> {
  const target = await loadAttachmentTarget(db, accountId, attachmentId);
  if (!target) return "not_found";
  const storageKey = attachmentKey(target.userId, target.id);
  if (await attachmentExists(dir, storageKey)) return null;
  let stored: number | "too_large" | null = null;
  const found = await download(target, async (body) => {
    stored = await storeReceivedAttachment(dir, target.userId, target.id, body);
  });
  if (!found || stored === null) return "not_found";
  if (stored === "too_large") return "too_large";
  // 一覧を取り込んだ時点の大きさは見積もりのことがあるので、実際の大きさに直す。
  await db
    .update(attachments)
    .set({ storageKey, size: stored })
    .where(eq(attachments.id, target.id));
  return null;
}

/**
 * 添付ファイルの取得の依頼を受け付ける。同じ添付ファイルへの依頼が重なっても取得は 1 回にし、
 * 終わったら (失敗しても) 必ず API サーバーへ知らせる。
 */
export class AttachmentRequests {
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Database,
    private readonly accountId: string,
    private readonly download: AttachmentDownloader,
    private readonly log: (message: string) => void,
  ) {}

  request(attachmentId: string) {
    if (this.running.has(attachmentId)) return;
    const task = (async () => {
      let error: AttachmentFetchError | null;
      try {
        error = await fetchAttachment(
          this.db,
          this.accountId,
          attachmentId,
          this.download,
        );
      } catch (cause) {
        error = "fetch_failed";
        this.log(
          `添付ファイルを取得できませんでした: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      await notifyAttachmentReady(this.db, attachmentId, error).catch(() => {});
    })().finally(() => this.running.delete(attachmentId));
    this.running.set(attachmentId, task);
  }
}

/** 最後の取得から、この時間だけ接続を残しておく (同じメールの添付を続けて開く場合に備える)。 */
const IMAP_IDLE_CLOSE_MS = 30_000;

/**
 * IMAP から添付ファイルを取得する。同期用の接続は受信トレイの通知待ち (IDLE) や同期で
 * 使っているので、取得のときだけ別の接続を張り、しばらく使われなければ閉じる。
 * 取得は 1 件ずつ順に行う。利用者が開いたメールの本文の取得 (withClient) にも同じ接続を使う。
 */
export class ImapAttachmentDownloader {
  private client: ImapFlow | null = null;
  private closeTimer: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly createClient: () => ImapFlow | Promise<ImapFlow>,
  ) {}

  /** この接続を使う作業を、順番待ちに入れて実行する。 */
  withClient<T>(task: (client: ImapFlow) => Promise<T>): Promise<T> {
    const result = this.queue.then(() => this.run(task));
    this.queue = result.catch(() => {});
    return result;
  }

  readonly download: AttachmentDownloader = (target, sink) =>
    this.withClient((client) => downloadFromImap(client, target, sink));

  close() {
    this.stopped = true;
    this.disconnect();
  }

  private disconnect() {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.client?.close();
    this.client = null;
  }

  private async connect(): Promise<ImapFlow> {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    if (this.client?.usable) return this.client;
    const client = await this.createClient();
    // 切断時のエラーは次の取得で気付く。リスナーが無いと例外になるので受けておく。
    client.on("error", () => {});
    await client.connect();
    this.client = client;
    return client;
  }

  private async run<T>(task: (client: ImapFlow) => Promise<T>): Promise<T> {
    if (this.stopped) throw new Error("同期を停止しました。");
    const client = await this.connect();
    try {
      return await task(client);
    } catch (error) {
      this.disconnect();
      throw error;
    } finally {
      if (this.client && !this.stopped) {
        this.closeTimer = setTimeout(
          () => this.disconnect(),
          IMAP_IDLE_CLOSE_MS,
        );
      }
    }
  }
}

/**
 * メールのある場所を順に読み取り専用で開き、read が null 以外を返した時点でその値を返す。
 * 消されたフォルダや、UID が振り直されたフォルダは飛ばす。どこからも読めなければ null。
 */
export async function readFromLocations<T>(
  client: ImapFlow,
  locations: AttachmentTarget["locations"],
  read: (uid: number) => Promise<T | null>,
): Promise<T | null> {
  for (const location of locations) {
    let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>>;
    try {
      lock = await client.getMailboxLock(location.path, { readOnly: true });
    } catch (error) {
      const status = (error as { responseStatus?: string }).responseStatus;
      // フォルダが消されていた場合は、ほかの所在を試す。
      if (status === "NO" || status === "BAD") continue;
      throw error;
    }
    try {
      const mailbox = client.mailbox;
      // UIDVALIDITY が変わっていたら、UID が別のメールを指しているおそれがある。
      if (
        !mailbox ||
        (location.uidValidity !== null &&
          mailbox.uidValidity !== location.uidValidity)
      ) {
        continue;
      }
      const result = await read(location.uid);
      if (result !== null) return result;
    } finally {
      lock.release();
    }
  }
  return null;
}

async function downloadFromImap(
  client: ImapFlow,
  target: AttachmentTarget,
  sink: Parameters<AttachmentDownloader>[1],
): Promise<boolean> {
  const done = await readFromLocations(
    client,
    target.locations,
    async (uid) => {
      const { content } = await client.download(String(uid), target.partId, {
        uid: true,
      });
      if (!content) return null;
      await sink(content);
      return true;
    },
  );
  return done === true;
}

/** Microsoft Graph から添付ファイルの実体を取得する。 */
export function graphAttachmentDownloader(
  client: GraphClient,
  signal?: AbortSignal,
): AttachmentDownloader {
  return async (target, sink) => {
    if (!target.providerMessageId) return false;
    let response: Response;
    try {
      response = await client.download(
        `/me/messages/${encodeURIComponent(target.providerMessageId)}/attachments/${encodeURIComponent(target.partId)}/$value`,
        signal,
      );
    } catch (error) {
      if (error instanceof GraphError && error.notFound) return false;
      throw error;
    }
    if (!response.body) return false;
    await sink(response.body as unknown as AsyncIterable<Uint8Array>);
    return true;
  };
}
