import type { BodyFetchPriority } from "@orbit/core";
import { type Database, messages } from "@orbit/db";
import { and, eq } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import {
  type AttachmentTarget,
  loadMessageLocations,
  readFromLocations,
} from "./attachment-fetch.js";
import { BodyQueue } from "./body-queue.js";
import { recordChanges } from "./changes.js";
import type { GraphClient } from "./graph-client.js";
import {
  fetchGraphBody,
  fetchGraphMessageHeaders,
  type GraphBodyTarget,
} from "./graph-sync.js";
import type { SyncAccount } from "./mailbox-store.js";
import { readBody } from "./mailbox-sync.js";
import { LIST_HEADERS, parseListHeaders } from "./message-headers.js";
import { analyzeStructure, makeSnippet, toAddresses } from "./message-parse.js";

/** 本文、または送信元の確認結果をまだ取得していないメッセージ。 */
export type BodyTarget = GraphBodyTarget & {
  /** メールがあるフォルダ (IMAP 用)。どれか 1 つから取得できればよい。 */
  locations: AttachmentTarget["locations"];
  /** 本文が未取得。 */
  bodyPending: boolean;
  /** 送信元の確認結果 (認証結果のヘッダー) が未取得。 */
  senderCheckPending: boolean;
};

/**
 * 本文をメールサーバーから取得して保存する。保存したら true を返す。
 * サーバーに見つからなかった場合は何もせず false を返す (通常の同期に任せる)。
 */
export type BodyFetcher = (target: BodyTarget) => Promise<boolean>;

/**
 * 認証結果などのヘッダーをメールサーバーから取得して保存する。保存したら true を返す。
 * 送信元の確認結果を足す前に取り込んだメールに、見られたときだけ補うために使う。
 */
export type HeaderFetcher = (target: BodyTarget) => Promise<boolean>;

/** 本文か送信元の確認結果が未取得のメッセージを探す。どちらも取得済み、または無ければ null。 */
export async function loadBodyTarget(
  db: Database,
  accountId: string,
  messageId: string,
): Promise<BodyTarget | null> {
  const [row] = await db
    .select({
      messageId: messages.id,
      providerMessageId: messages.providerMessageId,
      from: messages.from,
      snippet: messages.snippet,
      hasAttachments: messages.hasAttachments,
      bodyFetchedAt: messages.bodyFetchedAt,
      senderCheck: messages.senderCheck,
    })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.accountId, accountId)));
  if (!row) return null;
  const { bodyFetchedAt, senderCheck, ...target } = row;
  const bodyPending = bodyFetchedAt === null;
  const senderCheckPending = senderCheck === null;
  if (!bodyPending && !senderCheckPending) return null;
  return {
    ...target,
    bodyPending,
    senderCheckPending,
    locations: await loadMessageLocations(db, messageId),
  };
}

/**
 * 利用者が見ているメールの本文を、取り込みの順番を待たずに取得する依頼を受け付ける。
 * 取得する順番と数の制限は BodyQueue が決める。取得できたら変更を記録し、
 * 端末は通常の変更通知で本文を読み直す。取得済みのメールへの依頼は何もしない。
 * 送信元の確認結果がまだ無いメール (その項目を足す前に取り込んだもの) は、
 * ここで認証結果のヘッダーも取得する。全件を裏で補うと DB が重くなるため、見られたものだけ補う。
 */
export class BodyRequests {
  private readonly queue: BodyQueue;

  constructor(
    private readonly db: Database,
    private readonly account: SyncAccount,
    private readonly fetchBody: BodyFetcher,
    private readonly fetchHeaders: HeaderFetcher,
    private readonly log: (message: string) => void,
    /** 同時に取得する数。 */
    concurrency = 1,
  ) {
    this.queue = new BodyQueue(
      (messageId) => this.fetch(messageId),
      concurrency,
    );
  }

  request(messageIds: string[], priority: BodyFetchPriority) {
    this.queue.request(messageIds, priority);
  }

  private async fetch(messageId: string) {
    try {
      const target = await loadBodyTarget(this.db, this.account.id, messageId);
      if (!target) return;
      let changed = false;
      if (target.bodyPending && (await this.fetchBody(target))) {
        changed = true;
        // 本文の取得で認証結果も受け取る取得元 (Graph) もあるので、確かめ直す。
        const after = await loadBodyTarget(this.db, this.account.id, messageId);
        target.senderCheckPending = after?.senderCheckPending ?? false;
      }
      if (target.senderCheckPending && (await this.fetchHeaders(target))) {
        changed = true;
      }
      if (!changed) return;
      await this.db.transaction((tx) =>
        recordChanges(tx, this.account.userId, "message", "upsert", [
          messageId,
        ]),
      );
    } catch (cause) {
      // 失敗しても、通常の取り込みの順番が来れば取得される。
      this.log(
        `本文 (またはヘッダー) を先に取得できませんでした: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
}

/** IMAP から 1 通の本文を取得する。withClient は、同期用とは別の接続で作業を実行する。 */
export function imapBodyFetcher(
  db: Database,
  withClient: <T>(task: (client: ImapFlow) => Promise<T>) => Promise<T>,
): BodyFetcher {
  return async (target) => {
    const body = await withClient((client) =>
      readFromLocations(client, target.locations, async (uid) => {
        const message = await client.fetchOne(
          String(uid),
          { uid: true, bodyStructure: true },
          { uid: true },
        );
        if (!message) return null;
        return readBody(client, uid, analyzeStructure(message.bodyStructure));
      }),
    );
    if (!body) return false;
    await db
      .update(messages)
      .set({
        ...body,
        snippet: makeSnippet(body.bodyText, body.bodyHtml),
        bodyFetchedAt: new Date(),
      })
      .where(eq(messages.id, target.messageId));
    return true;
  };
}

/** Microsoft Graph から 1 通の本文を取得する。 */
export function graphBodyFetcher(
  db: Database,
  client: GraphClient,
  signal?: AbortSignal,
): BodyFetcher {
  return async (target) => {
    if (!target.providerMessageId) return false;
    await fetchGraphBody(db, client, target, signal);
    return true;
  };
}

/** IMAP から 1 通の認証結果などのヘッダーを取得する。withClient は、同期用とは別の接続で作業を実行する。 */
export function imapHeaderFetcher(
  db: Database,
  withClient: <T>(task: (client: ImapFlow) => Promise<T>) => Promise<T>,
): HeaderFetcher {
  return async (target) => {
    const message = await withClient((client) =>
      readFromLocations(client, target.locations, async (uid) => {
        const found = await client.fetchOne(
          String(uid),
          { uid: true, envelope: true, headers: LIST_HEADERS },
          { uid: true },
        );
        return found || null;
      }),
    );
    // サーバーに見つからなければ何もしない (次の同期でメッセージごと消える)。
    if (!message) return false;
    await db
      .update(messages)
      .set({
        sender: toAddresses(message.envelope?.sender),
        ...parseListHeaders(message.headers, target.from),
        headersFetchedAt: new Date(),
      })
      .where(eq(messages.id, target.messageId));
    return true;
  };
}

/** Microsoft Graph から 1 通の認証結果などのヘッダーを取得する。 */
export function graphHeaderFetcher(
  db: Database,
  client: GraphClient,
  signal?: AbortSignal,
): HeaderFetcher {
  return async (target) => {
    if (!target.providerMessageId) return false;
    await fetchGraphMessageHeaders(db, client, target, signal);
    return true;
  };
}
