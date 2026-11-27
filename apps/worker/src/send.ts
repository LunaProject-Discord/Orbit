import type {
  AppendPayload,
  OutboxTarget,
  OutgoingMessage,
  SendPayload,
  SetFlagsPayload,
} from "@orbit/core";
import {
  type Database,
  type mailAccounts,
  mailboxes,
  messageMailboxes,
  messages,
  outbox,
} from "@orbit/db";
import { and, asc, eq, inArray, min } from "drizzle-orm";
import { recordChanges } from "./changes.js";
import { missingAttachments } from "./mime.js";
import { lockAccount } from "./outbox.js";

/** 一時的な失敗でやり直す回数の上限。超えたら失敗として利用者に知らせる。 */
const MAX_ATTEMPTS = 5;
/** やり直すまでの待ち時間 (回数ごとに倍にする)。 */
const RETRY_BASE_MS = 30_000;

const INTERRUPTED =
  "送信の途中で処理が中断されました。相手に届いているか確認してから送り直してください。";

/**
 * 送信 1 回の結果。
 * - sent: 送信できた。warning は一部の宛先だけ拒否された場合の説明。
 * - retry: 相手には届いておらず、時間を置けば通る見込みがある。
 * - failed: やり直しても通らない、または届いたかどうか分からない。
 */
export type SendOutcome =
  | { status: "sent"; warning?: string }
  | { status: "retry"; reason: string }
  | { status: "failed"; reason: string };

export type Sender = (message: OutgoingMessage) => Promise<SendOutcome>;

type AccountRow = typeof mailAccounts.$inferSelect;

/**
 * 送信済みフォルダへの保存を自分で行うか。Gmail と Microsoft の SMTP は
 * サーバーが自動で保存するので、こちらからも保存すると二重になる。
 * Microsoft Graph も自動で保存する。
 * POP3 のアカウントは送信済みフォルダがこのアプリの中にしか無いので、いつも保存する。
 */
export function savesSentCopy(
  account: Pick<AccountRow, "protocol" | "provider">,
): boolean {
  if (account.protocol === "pop3") return true;
  return (
    account.protocol === "imap" &&
    account.provider !== "gmail" &&
    account.provider !== "microsoft"
  );
}

/**
 * アカウントの送信待ちのメールを送る。
 * 既読や移動などの操作 (processOutbox) とは別に扱い、SMTP が不調でも同期を止めない。
 * 一時的な失敗は runAfter を先へ延ばし、次に呼ばれたときにやり直す。
 * 戻り値の queued は、続けて反映する操作 (送信済みフォルダへの保存など) を積んだかどうか。
 */
export async function processSends(
  db: Database,
  account: AccountRow,
  send: Sender,
  log: (message: string) => void,
): Promise<{
  sent: number;
  failed: number;
  queued: boolean;
  /** まだ時刻になっていない送信 (予約、やり直し待ち) のうち、いちばん早い時刻。無ければ null。 */
  nextRunAt: Date | null;
}> {
  const rows = await db
    .select()
    .from(outbox)
    .where(
      and(
        eq(outbox.accountId, account.id),
        eq(outbox.kind, "send"),
        inArray(outbox.status, ["pending", "processing"]),
      ),
    )
    .orderBy(asc(outbox.createdAt), asc(outbox.id));
  let sent = 0;
  let failed = 0;
  let queued = false;

  for (const row of rows) {
    if (row.status === "processing") {
      // 前回の送信中にワーカーが止まった。届いたかどうか分からないので、送り直さない。
      await finish(db, account, row.id, "failed", INTERRUPTED);
      failed++;
      continue;
    }
    if (row.runAfter.getTime() > Date.now()) continue;
    // 利用者が取り消していた場合は、ここで行が無くなっている。
    const [claimed] = await db
      .update(outbox)
      .set({ status: "processing", attempts: row.attempts + 1 })
      .where(and(eq(outbox.id, row.id), eq(outbox.status, "pending")))
      .returning({ id: outbox.id });
    if (!claimed) continue;

    const stored = row.payload as unknown as SendPayload;
    // 予約送信は、実際に送る時刻を送信日時 (Date) にする。
    const payload: SendPayload = row.scheduledAt
      ? {
          ...stored,
          message: { ...stored.message, date: new Date().toISOString() },
        }
      : stored;
    let outcome: SendOutcome;
    try {
      const missing = await missingAttachments(payload.message);
      outcome =
        missing.length > 0
          ? {
              status: "failed",
              reason: `添付ファイルが見つかりません。添付し直してから送ってください: ${missing.join(", ")}`,
            }
          : await send(payload.message);
    } catch (error) {
      outcome = {
        status: "failed",
        reason: `${INTERRUPTED} (${error instanceof Error ? error.message : String(error)})`,
      };
    }

    if (outcome.status === "retry" && row.attempts + 1 >= MAX_ATTEMPTS) {
      outcome = { status: "failed", reason: outcome.reason };
    }
    if (outcome.status === "retry") {
      log(`送信をやり直します: ${outcome.reason}`);
      await finish(
        db,
        account,
        row.id,
        "pending",
        outcome.reason,
        new Date(Date.now() + RETRY_BASE_MS * 2 ** row.attempts),
      );
      continue;
    }
    if (outcome.status === "failed") {
      log(`メールを送信できませんでした: ${outcome.reason}`);
      await finish(db, account, row.id, "failed", outcome.reason);
      failed++;
      continue;
    }

    sent++;
    if (outcome.warning) {
      log(outcome.warning);
      failed++;
    }
    const warning = outcome.warning ?? null;
    const followUps = await db.transaction(async (tx) => {
      await lockAccount(tx, account.id);
      // 一部の宛先だけ拒否された場合は、気づけるよう失敗の一覧に残す。
      await tx
        .update(outbox)
        .set({ status: warning ? "failed" : "done", lastError: warning })
        .where(eq(outbox.id, row.id));
      let count = 0;

      if (savesSentCopy(account)) {
        const [sentBox] = await tx
          .select({ path: mailboxes.path })
          .from(mailboxes)
          .where(
            and(
              eq(mailboxes.accountId, account.id),
              eq(mailboxes.specialUse, "sent"),
            ),
          );
        if (sentBox) {
          const append: AppendPayload = {
            message: payload.message,
            mailboxPath: sentBox.path,
            targets: [],
          };
          await tx
            .insert(outbox)
            .values({
              accountId: account.id,
              kind: "append",
              payload: append,
              idempotencyKey: `${row.idempotencyKey}:append`,
            })
            .onConflictDoNothing();
          count++;
        } else {
          log("送信済みフォルダが見つからないため、控えは保存しません。");
        }
      }

      if (payload.mode === "reply" && payload.sourceMessageId) {
        count += await markAnswered(
          tx,
          account,
          payload.sourceMessageId,
          `${row.idempotencyKey}:answered`,
        );
      }
      // 送信待ちの一覧が変わったことを端末へ知らせる。
      await recordChanges(tx, account.userId, "account", "upsert", [
        account.id,
      ]);
      return count;
    });
    if (followUps > 0) queued = true;
  }
  const [next] = await db
    .select({ at: min(outbox.runAfter) })
    .from(outbox)
    .where(
      and(
        eq(outbox.accountId, account.id),
        eq(outbox.kind, "send"),
        eq(outbox.status, "pending"),
      ),
    );
  return { sent, failed, queued, nextRunAt: next?.at ?? null };
}

/** setTimeout で待てる最長の時間 (これより先は、定期的な確認に任せる)。 */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * 予約やり直し待ちの送信を、その時刻に送り始めるためのタイマー。
 * アカウントの同期 1 つにつき 1 つ持ち、送信を処理するたびに次の時刻で掛け直す。
 */
export class SendTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly fire: () => void) {}

  /** at に fire を呼ぶ。null なら止める。過ぎていれば、少し置いてすぐ呼ぶ。 */
  schedule(at: Date | null, now = Date.now()) {
    this.stop();
    if (!at) return;
    const wait = Math.max(1_000, at.getTime() - now);
    if (wait > MAX_TIMER_MS) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fire();
    }, wait);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** 送信の結果を記録し、送信待ちの一覧が変わったことを端末へ知らせる。 */
async function finish(
  db: Database,
  account: AccountRow,
  id: string,
  status: "pending" | "failed",
  lastError: string,
  runAfter?: Date,
) {
  await db.transaction(async (tx) => {
    await tx
      .update(outbox)
      .set({ status, lastError, ...(runAfter ? { runAfter } : {}) })
      .where(eq(outbox.id, id));
    await recordChanges(tx, account.userId, "account", "upsert", [account.id]);
  });
}

/**
 * 返信した元のメールに「返信済み」の印を付ける。DB にはすぐ反映し、
 * IMAP サーバーへは既読などと同じ仕組み (set_flags) で反映する。
 * Microsoft Graph には返信済みを書き込む手段が無いので、DB への反映だけ行う。
 * 戻り値は積んだ操作の数。
 */
async function markAnswered(
  tx: Parameters<typeof lockAccount>[0],
  account: AccountRow,
  messageId: string,
  idempotencyKey: string,
): Promise<number> {
  const placements = await tx
    .select({
      messageId: messages.id,
      providerMessageId: messages.providerMessageId,
      mailboxId: mailboxes.id,
      mailboxPath: mailboxes.path,
      uid: messageMailboxes.uid,
      uidValidity: mailboxes.uidValidity,
    })
    .from(messages)
    .innerJoin(messageMailboxes, eq(messageMailboxes.messageId, messages.id))
    .innerJoin(mailboxes, eq(mailboxes.id, messageMailboxes.mailboxId))
    .where(and(eq(messages.id, messageId), eq(messages.accountId, account.id)));
  // 元のメールが別のアカウントのものか、すでに削除されている。
  if (placements.length === 0) return 0;

  await tx
    .update(messages)
    .set({ answered: true })
    .where(eq(messages.id, messageId));
  await recordChanges(tx, account.userId, "message", "upsert", [messageId]);
  if (account.protocol !== "imap") return 0;

  const targets: OutboxTarget[] = placements
    .filter((row) => row.uid !== null)
    .map((row) => ({
      ...row,
      uid: row.uid?.toString() ?? null,
      uidValidity: row.uidValidity?.toString() ?? null,
    }));
  if (targets.length === 0) return 0;
  const payload: SetFlagsPayload = { targets, answered: true };
  await tx
    .insert(outbox)
    .values({
      accountId: account.id,
      kind: "set_flags",
      payload,
      idempotencyKey,
    })
    .onConflictDoNothing();
  return 1;
}
