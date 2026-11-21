import {
  attachmentExists,
  attachmentKey,
  attachmentsDir,
  type OutgoingMessage,
} from "@mail/core";
import { type Database, drafts, type mailAccounts } from "@mail/db";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { recordChanges } from "./changes.js";
import { lockAccount } from "./outbox.js";

/**
 * 下書きを、メールサーバーの下書きフォルダにも置く。
 * アプリの下書き (drafts テーブル) が正で、メールサーバー側は控え。
 * ほかのメールソフト (Thunderbird、Outlook など) からも書きかけが見えるようにする。
 */

/**
 * 最後の保存からこれだけ変更が無ければ、メールサーバーへ置く。
 * 入力のたびに置き直すと負荷が大きいので、書く手が止まるのを待つ。
 */
export const DRAFT_SETTLE_MS = 20_000;

type AccountRow = typeof mailAccounts.$inferSelect;
export type DraftRow = typeof drafts.$inferSelect;

/** メールサーバーに置いた控えの場所。IMAP はフォルダと UID、Graph はメッセージの ID。 */
export type DraftRemoteRef = {
  messageId: string | null;
  mailboxPath: string | null;
  uid: bigint | null;
  uidValidity: bigint | null;
  providerId: string | null;
};

/**
 * メールサーバーへの控えの置き方 (IMAP と Microsoft Graph で実装が違う)。
 * サーバーに拒否された場合は DraftRejected を投げ、接続の問題はそのままの例外にする。
 */
export type DraftRemote = {
  /**
   * 控えを置き、置いた場所を返す。previous は前回置いた場所 (初めてなら null)。
   * 下書きフォルダが無いなど、置き場が無ければ null を返す。
   */
  save(
    message: OutgoingMessage,
    previous: DraftRemoteRef | null,
  ): Promise<DraftRemoteRef | null>;
  /** 控えを消す。すでに無ければ何もしない。 */
  remove(ref: DraftRemoteRef): Promise<void>;
};

/** メールサーバーに拒否された。やり直しても通らない。 */
export class DraftRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftRejected";
  }
}

export type DraftStore = {
  /** メールサーバーへまだ置いていない変更がある下書き。 */
  loadUnsynced(): Promise<DraftRow[]>;
  /**
   * 置いた結果を記録する。ref が undefined なら、場所は変えずに revision だけ記録する。
   * 下書きがすでに無い (送信・破棄された、別のアカウントへ移った) なら false。
   */
  recordSynced(
    id: string,
    revision: number,
    ref: DraftRemoteRef | undefined,
  ): Promise<boolean>;
};

export function refOf(row: DraftRow): DraftRemoteRef | null {
  if (row.remoteProviderId === null && row.remoteUid === null) return null;
  return {
    messageId: row.remoteMessageId,
    mailboxPath: row.remoteMailboxPath,
    uid: row.remoteUid,
    uidValidity: row.remoteUidValidity,
    providerId: row.remoteProviderId,
  };
}

function sameRef(a: DraftRemoteRef, b: DraftRemoteRef): boolean {
  return (
    a.providerId === b.providerId &&
    a.mailboxPath === b.mailboxPath &&
    a.uid === b.uid &&
    a.uidValidity === b.uidValidity
  );
}

/**
 * 控えの Message-ID。下書きごとに決まった値にして、同期で取り込んだ控えが
 * どの下書きのものかを見分けられるようにする。送信するメールには別の値を付ける。
 */
export function draftMessageId(draftId: string, email: string): string {
  const domain = email.split("@").pop() || "localhost";
  return `<draft.${draftId}@${domain}>`;
}

/** 下書きを、メールとして組み立てる前の形にする。置き場に残っていない添付ファイルは外す。 */
export async function draftToMessage(
  row: DraftRow,
  account: Pick<AccountRow, "email" | "displayName">,
): Promise<OutgoingMessage> {
  const dir = attachmentsDir();
  const attachments: NonNullable<OutgoingMessage["attachments"]> = [];
  for (const file of row.attachments) {
    const storageKey = attachmentKey(row.userId, file.id);
    if (await attachmentExists(dir, storageKey)) {
      attachments.push({ ...file, storageKey });
    }
  }
  return {
    from: {
      address: account.email,
      ...(account.displayName ? { name: account.displayName } : {}),
    },
    to: row.to.list,
    cc: row.cc.list,
    bcc: row.bcc.list,
    subject: row.subject.trim(),
    text: row.text,
    html: row.html.trim() ? row.html : null,
    attachments,
    messageId: draftMessageId(row.id, account.email),
    date: row.updatedAt.toISOString(),
    inReplyTo: null,
    references: [],
  };
}

/**
 * まだメールサーバーへ置いていない下書きを置く。
 * 戻り値の saved は置いた件数、nextDueAt は書く手が止まるのを待っている下書きを
 * 次に確認する時刻 (無ければ null)。
 */
export async function processDrafts(
  store: DraftStore,
  account: Pick<AccountRow, "email" | "displayName">,
  remote: DraftRemote,
  log: (message: string) => void,
  now = Date.now(),
): Promise<{ saved: number; nextDueAt: number | null }> {
  let saved = 0;
  let nextDueAt: number | null = null;
  for (const row of await store.loadUnsynced()) {
    const dueAt = row.updatedAt.getTime() + DRAFT_SETTLE_MS;
    if (dueAt > now) {
      nextDueAt = nextDueAt === null ? dueAt : Math.min(nextDueAt, dueAt);
      continue;
    }
    const previous = refOf(row);
    let next: DraftRemoteRef | null;
    try {
      next = await remote.save(await draftToMessage(row, account), previous);
    } catch (error) {
      if (!(error instanceof DraftRejected)) throw error;
      log(`下書きをメールサーバーへ保存できませんでした: ${error.message}`);
      // 同じ内容でやり直しても通らないので、次に内容が変わるまで置かない。
      await store.recordSynced(row.id, row.revision, undefined);
      continue;
    }
    if (!next) {
      // 置き場が無い (下書きフォルダが無いなど)。
      await store.recordSynced(row.id, row.revision, undefined);
      continue;
    }
    const kept = await store.recordSynced(row.id, row.revision, next);
    const replaced = previous !== null && !sameRef(previous, next);
    try {
      if (!kept) {
        // 置いている間に送信または破棄された。置いたばかりの控えを片付ける
        // (前の控えは、送信・破棄を受け付けた API が消す操作を積んでいる)。
        await remote.remove(next);
      } else if (replaced) {
        await remote.remove(previous);
      }
    } catch (error) {
      if (!(error instanceof DraftRejected)) throw error;
      log(`古い下書きをメールサーバーから消せませんでした: ${error.message}`);
    }
    if (kept) saved++;
  }
  return { saved, nextDueAt };
}

/** drafts テーブルを使う DraftStore。 */
export function dbDraftStore(
  db: Database,
  account: Pick<AccountRow, "id" | "userId">,
): DraftStore {
  return {
    loadUnsynced: () =>
      db
        .select()
        .from(drafts)
        .where(
          and(
            eq(drafts.accountId, account.id),
            or(
              isNull(drafts.syncedRevision),
              ne(drafts.syncedRevision, drafts.revision),
            ),
          ),
        ),
    recordSynced: (id, revision, ref) =>
      db.transaction(async (tx) => {
        // 送信・破棄の受け付け (API) と順番に実行する。
        await lockAccount(tx, account.id);
        const [row] = await tx
          .update(drafts)
          .set({
            syncedRevision: revision,
            // 同期の状態の記録なので、下書きの更新日時は動かさない。
            updatedAt: sql`${drafts.updatedAt}`,
            ...(ref
              ? {
                  remoteMessageId: ref.messageId,
                  remoteMailboxPath: ref.mailboxPath,
                  remoteUid: ref.uid,
                  remoteUidValidity: ref.uidValidity,
                  remoteProviderId: ref.providerId,
                }
              : {}),
          })
          .where(and(eq(drafts.id, id), eq(drafts.accountId, account.id)))
          .returning({ id: drafts.id });
        if (!row) return false;
        // 下書きフォルダの一覧で、控えと下書きを結び付けて表示し直してもらう。
        if (ref) {
          await recordChanges(tx, account.userId, "account", "upsert", [
            account.id,
          ]);
        }
        return true;
      }),
  };
}
