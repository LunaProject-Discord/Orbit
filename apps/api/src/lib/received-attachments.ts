import {
  type AttachmentFetchError,
  type AttachmentFetchNotification,
  attachmentExists,
  attachmentKey,
  CHANNEL_ATTACHMENT_FETCH,
} from "@orbit/core";
import { accounts, attachments, type Database, messages } from "@orbit/db";
import { and, eq, sql } from "drizzle-orm";
import type { EventsHub } from "./events-hub.js";

/** 同期ワーカーがメールサーバーから取得し終えるのを待つ時間。 */
const FETCH_TIMEOUT_MS = 90_000;

export type ReceivedAttachment = {
  id: string;
  filename: string | null;
  contentType: string;
  size: number;
  /** 置き場の中の位置。 */
  storageKey: string;
};

export type EnsureResult =
  | { ok: true; attachment: ReceivedAttachment }
  | { ok: false; error: "not_found" | "timeout" | AttachmentFetchError };

/**
 * 受信メールの添付ファイルを、置き場から読める状態にする。
 * 置き場に無ければ同期ワーカーに取得を頼み、終わるまで待つ。
 * 他人のメールの添付ファイルは、存在しない扱いにする。
 */
export async function ensureReceivedAttachment(
  { db, hub, dir }: { db: Database; hub: EventsHub; dir: string },
  userId: string,
  messageId: string,
  attachmentId: string,
): Promise<EnsureResult> {
  const [row] = await db
    .select({
      id: attachments.id,
      filename: attachments.filename,
      contentType: attachments.contentType,
      size: attachments.size,
      accountId: messages.accountId,
    })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .innerJoin(accounts, eq(accounts.id, messages.accountId))
    .where(
      and(
        eq(attachments.id, attachmentId),
        eq(attachments.messageId, messageId),
        eq(accounts.userId, userId),
      ),
    );
  if (!row) return { ok: false, error: "not_found" };
  const { accountId, ...attachment } = row;
  const storageKey = attachmentKey(userId, attachment.id);
  const found = {
    ok: true,
    attachment: { ...attachment, storageKey },
  } as const;
  if (await attachmentExists(dir, storageKey)) return found;

  const payload: AttachmentFetchNotification = { accountId, attachmentId };
  const error = await hub.waitForAttachment(
    attachmentId,
    async () => {
      await db.execute(
        sql`select pg_notify(${CHANNEL_ATTACHMENT_FETCH}, ${JSON.stringify(payload)})`,
      );
    },
    FETCH_TIMEOUT_MS,
  );
  if (error) return { ok: false, error };
  if (!(await attachmentExists(dir, storageKey))) {
    return { ok: false, error: "fetch_failed" };
  }
  return found;
}

/** 取得できなかった理由に合わせた HTTP の状態コード。 */
export function statusOfFetchError(
  error: Exclude<EnsureResult, { ok: true }>["error"],
): 404 | 413 | 502 | 503 | 504 {
  switch (error) {
    case "not_found":
      return 404;
    case "too_large":
      return 413;
    case "account_unavailable":
      return 503;
    case "timeout":
      return 504;
    default:
      return 502;
  }
}
