import {
  accountLockKey,
  type OutboxOperation,
  type OutboxTarget,
} from "@mail/core";
import { type Database, mailboxes, outbox } from "@mail/db";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Tx } from "./changes.js";

/** 一時的な失敗 (接続が切れたなど) でやり直す回数の上限。超えたら失敗として扱う。 */
const MAX_ATTEMPTS = 5;
/** 反映済みの記録を残す期間。この間は同じ操作が再送されても二重に実行しない。 */
const KEEP_DONE_MS = 7 * 24 * 60 * 60_000;

/**
 * 反映した結果。failed はやり直しても成功しない失敗 (サーバーに拒否されたなど)。
 * 接続が切れたなどの一時的な失敗は、例外を投げて知らせる。
 */
export type OutboxResult = { ok: true } | { ok: false; reason: string };

export type OutboxExecutor = (
  operation: OutboxOperation,
) => Promise<OutboxResult>;

type OutboxRow = typeof outbox.$inferSelect;

function toOperation(row: OutboxRow): OutboxOperation | null {
  if (
    row.kind !== "set_flags" &&
    row.kind !== "move" &&
    row.kind !== "delete"
  ) {
    // 送信 (send) と保存 (append) にはまだ対応していない。
    return null;
  }
  return { kind: row.kind, payload: row.payload } as OutboxOperation;
}

/**
 * アカウントの送信待ちキューを、受け付けた順にプロバイダへ反映する。
 * 一時的な失敗では例外を投げて止まり (順番を保つため後続も実行しない)、
 * 呼び出し側の再接続のあとで続きからやり直す。
 * 戻り値は失敗として確定した件数。
 */
export async function processOutbox(
  db: Database,
  accountId: string,
  execute: OutboxExecutor,
  log: (message: string) => void,
): Promise<{ done: number; failed: number }> {
  const rows = await db
    .select()
    .from(outbox)
    .where(
      and(
        eq(outbox.accountId, accountId),
        inArray(outbox.status, ["pending", "processing"]),
      ),
    )
    .orderBy(asc(outbox.createdAt), asc(outbox.id));
  let done = 0;
  let failed = 0;

  for (const row of rows) {
    const operation = toOperation(row);
    let result: OutboxResult;
    if (!operation) {
      result = { ok: false, reason: `未対応の操作です: ${row.kind}` };
    } else {
      await db
        .update(outbox)
        .set({ status: "processing", attempts: row.attempts + 1 })
        .where(eq(outbox.id, row.id));
      try {
        result = await execute(operation);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (row.attempts + 1 < MAX_ATTEMPTS) {
          await db
            .update(outbox)
            .set({ status: "pending", lastError: reason })
            .where(eq(outbox.id, row.id));
          throw error;
        }
        result = { ok: false, reason };
      }
    }

    if (result.ok) {
      await db
        .update(outbox)
        .set({ status: "done", lastError: null })
        .where(eq(outbox.id, row.id));
      done++;
      continue;
    }
    failed++;
    log(`操作 (${row.kind}) を反映できませんでした: ${result.reason}`);
    const reason = result.reason;
    await db.transaction(async (tx) => {
      await lockAccount(tx, accountId);
      await tx
        .update(outbox)
        .set({ status: "failed", lastError: reason })
        .where(eq(outbox.id, row.id));
      // 先に DB へ反映した内容を取り消す。対象のフォルダを次の同期で
      // 全件突き合わせることで、サーバーの実際の状態に戻す。
      const mailboxIds = [
        ...new Set(
          ((row.payload.targets ?? []) as OutboxTarget[]).map(
            (target) => target.mailboxId,
          ),
        ),
      ];
      if (mailboxIds.length > 0) {
        await tx
          .update(mailboxes)
          .set({ highestModseq: null, syncState: null })
          .where(
            and(
              eq(mailboxes.accountId, accountId),
              inArray(mailboxes.id, mailboxIds),
            ),
          );
      }
    });
  }

  await db
    .delete(outbox)
    .where(
      and(
        eq(outbox.accountId, accountId),
        eq(outbox.status, "done"),
        lt(outbox.updatedAt, new Date(Date.now() - KEEP_DONE_MS)),
      ),
    );
  return { done, failed };
}

/** 反映待ちの操作があるアカウントの ID。通知の取りこぼしに備えた確認に使う。 */
export async function accountsWithPendingOutbox(
  db: Database,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ accountId: outbox.accountId })
    .from(outbox)
    .where(inArray(outbox.status, ["pending", "processing"]));
  return rows.map((row) => row.accountId);
}

/** 操作の受け付け (API) と順番に実行するための、アカウント単位のロック。 */
export async function lockAccount(tx: Tx, accountId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${accountLockKey(accountId)}, 0))`,
  );
}

/**
 * まだプロバイダへ反映していない操作の対象。同期の結果を書き込むとき、
 * これに当たるものは上書きしない (先に DB へ反映した内容を古い状態で戻さないため)。
 */
export type PendingGuard = {
  /** 既読やスターを変更中のメッセージ (messages.id)。 */
  flagMessageIds: Set<string>;
  /** 移動・削除中の UID (フォルダの ID ごと)。IMAP 用。 */
  removedUids: Map<string, Set<number>>;
  /** 既読やスターを変更中の、プロバイダ側のメッセージ ID。Graph 用。 */
  flagProviderIds: Set<string>;
  /** 移動・削除中の、プロバイダ側のメッセージ ID。Graph 用。 */
  removedProviderIds: Set<string>;
};

export function buildPendingGuard(
  rows: { kind: string; payload: Record<string, unknown> }[],
): PendingGuard {
  const guard: PendingGuard = {
    flagMessageIds: new Set(),
    removedUids: new Map(),
    flagProviderIds: new Set(),
    removedProviderIds: new Set(),
  };
  for (const row of rows) {
    const targets = (row.payload.targets ?? []) as OutboxTarget[];
    for (const target of targets) {
      if (row.kind === "set_flags") {
        guard.flagMessageIds.add(target.messageId);
        if (target.providerMessageId) {
          guard.flagProviderIds.add(target.providerMessageId);
        }
      } else if (row.kind === "move" || row.kind === "delete") {
        if (target.providerMessageId) {
          guard.removedProviderIds.add(target.providerMessageId);
        }
        if (target.uid !== null) {
          let uids = guard.removedUids.get(target.mailboxId);
          if (!uids) {
            uids = new Set();
            guard.removedUids.set(target.mailboxId, uids);
          }
          uids.add(Number(target.uid));
        }
      }
    }
  }
  return guard;
}

/**
 * アカウントのロックを取り、反映待ちの操作の対象を返す。
 * 同期の結果を書き込むトランザクションの最初に呼ぶ。
 */
export async function loadPendingGuard(
  tx: Tx,
  accountId: string,
): Promise<PendingGuard> {
  await lockAccount(tx, accountId);
  const rows = await tx
    .select({ kind: outbox.kind, payload: outbox.payload })
    .from(outbox)
    .where(
      and(
        eq(outbox.accountId, accountId),
        inArray(outbox.status, ["pending", "processing"]),
      ),
    );
  return buildPendingGuard(rows);
}
