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
import { fetchGraphBody, type GraphBodyTarget } from "./graph-sync.js";
import type { SyncAccount } from "./mailbox-store.js";
import { readBody } from "./mailbox-sync.js";
import { analyzeStructure, makeSnippet } from "./message-parse.js";

/** 本文をまだ取得していないメッセージ。 */
export type BodyTarget = GraphBodyTarget & {
  /** メールがあるフォルダ (IMAP 用)。どれか 1 つから取得できればよい。 */
  locations: AttachmentTarget["locations"];
};

/**
 * 本文をメールサーバーから取得して保存する。保存したら true を返す。
 * サーバーに見つからなかった場合は何もせず false を返す (通常の同期に任せる)。
 */
export type BodyFetcher = (target: BodyTarget) => Promise<boolean>;

/** 本文が未取得のメッセージを探す。取得済み、または無ければ null。 */
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
    })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.accountId, accountId)));
  if (!row || row.bodyFetchedAt !== null) return null;
  const { bodyFetchedAt: _, ...target } = row;
  return { ...target, locations: await loadMessageLocations(db, messageId) };
}

/**
 * 利用者が見ているメールの本文を、取り込みの順番を待たずに取得する依頼を受け付ける。
 * 取得する順番と数の制限は BodyQueue が決める。取得できたら変更を記録し、
 * 端末は通常の変更通知で本文を読み直す。取得済みのメールへの依頼は何もしない。
 */
export class BodyRequests {
  private readonly queue: BodyQueue;

  constructor(
    private readonly db: Database,
    private readonly account: SyncAccount,
    private readonly fetchBody: BodyFetcher,
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
      if (!target || !(await this.fetchBody(target))) return;
      await this.db.transaction((tx) =>
        recordChanges(tx, this.account.userId, "message", "upsert", [
          messageId,
        ]),
      );
    } catch (cause) {
      // 失敗しても、通常の取り込みの順番が来れば取得される。
      this.log(
        `本文を先に取得できませんでした: ${cause instanceof Error ? cause.message : String(cause)}`,
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
