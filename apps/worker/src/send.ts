import {
  type AppendPayload,
  calendarScheduling,
  IMIP_OUTBOX_KIND,
  type ImipSendPayload,
  isSendableAccount,
  type OutboxTarget,
  type OutgoingMessage,
  type SendPayload,
  type SetFlagsPayload,
} from "@orbit/core";
import {
  type accounts,
  accounts as accountsTable,
  calendars,
  type Database,
  mailboxes,
  messageMailboxes,
  messages,
  outbox,
  users,
} from "@orbit/db";
import { and, asc, eq, inArray, lt, min, notInArray, or } from "drizzle-orm";
import {
  imipFailurePrefix,
  KEEP_CONFLICTS_MS,
  pruneEventConflicts,
  recordInviteFailure,
} from "./calendar/conflicts.js";
import { recordChanges } from "./changes.js";
import { missingAttachments } from "./mime.js";
import { lockAccount } from "./outbox.js";

/** 一時的な失敗でやり直す回数の上限。超えたら失敗として利用者に知らせる。 */
const MAX_ATTEMPTS = 5;
/** やり直すまでの待ち時間 (回数ごとに倍にする)。 */
const RETRY_BASE_MS = 30_000;

const INTERRUPTED =
  "送信の途中で処理が中断されました。相手に届いているか確認してから送り直してください。";

/** 送信の種類 (outbox.kind)。招待メール (imip_send) も同じ順番で送る。 */
const SEND_KINDS = ["send", IMIP_OUTBOX_KIND] as const;
/** 送った招待メールの記録を残す期間 (送信数の上限は 1 日分を数える)。 */
const KEEP_IMIP_DONE_MS = 7 * 24 * 60 * 60_000;
/** processing のまま、これだけ動きの無い招待メールは、送信の途中で中断されたとみなす。 */
const INTERRUPTED_AFTER_MS = 10 * 60_000;
/**
 * 送信元のアカウントの同期が止まっていて (再ログイン待ち、メールの無効化など)、これだけたっても
 * 送れていない招待メールは、失敗として利用者に知らせる (imip レビュー M8)。
 */
export const IMIP_STALE_MS = 60 * 60_000;

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

type AccountRow = typeof accounts.$inferSelect;

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
  // 管理者が無効にした利用者のメールは送らない (送信待ちは残し、有効に戻すと送る)。
  const [owner] = await db
    .select({ disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, account.userId));
  if (owner?.disabledAt) {
    return { sent: 0, failed: 0, queued: false, nextRunAt: null };
  }
  const rows = await db
    .select()
    .from(outbox)
    .where(
      and(
        eq(outbox.accountId, account.id),
        inArray(outbox.kind, [...SEND_KINDS]),
        inArray(outbox.status, ["pending", "processing"]),
      ),
    )
    .orderBy(asc(outbox.createdAt), asc(outbox.id));
  let sent = 0;
  let failed = 0;
  let queued = false;

  for (const row of rows) {
    if (row.kind === IMIP_OUTBOX_KIND) {
      const result = await processImipSend(db, account, row, send, log);
      if (result === "sent") sent++;
      if (result === "failed") failed++;
      continue;
    }
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
  await pruneImipSends(db, account);
  const [next] = await db
    .select({ at: min(outbox.runAfter) })
    .from(outbox)
    .where(
      and(
        eq(outbox.accountId, account.id),
        inArray(outbox.kind, [...SEND_KINDS]),
        eq(outbox.status, "pending"),
      ),
    );
  return { sent, failed, queued, nextRunAt: next?.at ?? null };
}

type OutboxRow = typeof outbox.$inferSelect;

/**
 * 招待メール (imip_send) を 1 通送る (imip-design 6.4、6.5)。ふつうのメールとの違い:
 * - processing のまま残った行 (送信の途中で止まった) も送り直す。同じ iTIP が 2 通届いても
 *   予定は 1 つで、メールが重複するだけのため (未決 3)。回数の上限は同じ 5 回。
 * - 送る直前に、カレンダーの scheduling がまだ mail で、このアカウントから送れるかを確かめる。
 * - 送信済みフォルダへの控えは積まない (未決 4)。返信済みの印も付けない。
 * - 確定した失敗と、一部の宛先だけ拒否されたときは event_conflicts に invite_failed を残す。
 *   一部の宛先だけの失敗は送信済み (done) として扱う。
 */
async function processImipSend(
  db: Database,
  account: AccountRow,
  row: OutboxRow,
  send: Sender,
  log: (message: string) => void,
): Promise<"sent" | "failed" | "skipped"> {
  const payload = row.payload as unknown as ImipSendPayload;
  const fail = async (reason: string) => {
    log(`${imipFailurePrefix(payload.imip)}: ${reason}`);
    await finishImip(db, account, row, payload, "failed", reason);
    return "failed" as const;
  };
  // ほかの worker (入れ替えの重なりなど) が送っている最中の行は取らない。processing のまま
  // INTERRUPTED_AFTER_MS 動きが無い行だけを、中断されたものとして送り直す (L6)。
  if (
    row.status === "processing" &&
    Date.now() - row.updatedAt.getTime() < INTERRUPTED_AFTER_MS
  ) {
    return "skipped";
  }
  if (row.status === "processing" && row.attempts >= MAX_ATTEMPTS) {
    return fail(
      "送信の途中で処理が中断され、やり直しの上限に達しました。相手に届いているか確認してください。",
    );
  }
  if (row.status === "pending" && row.runAfter.getTime() > Date.now()) {
    return "skipped";
  }
  const [claimed] = await db
    .update(outbox)
    .set({ status: "processing", attempts: row.attempts + 1 })
    .where(and(eq(outbox.id, row.id), eq(outbox.status, row.status)))
    .returning({ id: outbox.id });
  if (!claimed) return "skipped";
  if (row.status === "processing") {
    log("送信の途中で中断された招待メールを送り直します。");
  }

  // 送る直前の検査 (3.1 の 2・4、6.4): カレンダーがまだ mail で、このアカウントから送れるか。
  const [calendar] = await db
    .select({
      source: calendars.source,
      readOnly: calendars.readOnly,
      providerState: calendars.providerState,
    })
    .from(calendars)
    .where(
      and(
        eq(calendars.id, payload.imip.calendarId),
        eq(calendars.userId, account.userId),
      ),
    );
  if (!isSendableAccount(account)) {
    return fail(`送信元の ${account.email} からはメールを送れません。`);
  }
  // カレンダーを消すときに積んだ取り消し (CANCEL) は、カレンダーが消えていても送る
  // (積んだ時点で scheduling が mail だったことは確かめてある。imip レビュー M9)。
  // 招待 (REQUEST) と返事 (REPLY) は送らない。
  if (!calendar && payload.imip.method !== "CANCEL") {
    return fail("カレンダーが削除されています。");
  }
  const scheduling = calendar
    ? calendarScheduling({ ...calendar, imipSender: true })
    : "mail";
  if (scheduling !== "mail") {
    return fail(
      scheduling === "server"
        ? "カレンダーのサービスが招待を送るようになったため、Orbit からは送りませんでした。"
        : "このカレンダーからは招待メールを送れなくなりました。",
    );
  }

  let outcome: SendOutcome;
  try {
    outcome = await send(payload.message);
  } catch (error) {
    // 届いたか分からないが、招待メールは送り直してよい (予定は重複しない)。
    outcome = {
      status: "retry",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (outcome.status === "retry" && row.attempts + 1 >= MAX_ATTEMPTS) {
    outcome = { status: "failed", reason: outcome.reason };
  }
  if (outcome.status === "retry") {
    log(`招待メールの送信をやり直します: ${outcome.reason}`);
    await db
      .update(outbox)
      .set({
        status: "pending",
        lastError: outcome.reason,
        runAfter: new Date(Date.now() + RETRY_BASE_MS * 2 ** row.attempts),
      })
      .where(eq(outbox.id, row.id));
    return "skipped";
  }
  if (outcome.status === "failed") return fail(outcome.reason);
  if (outcome.warning) log(outcome.warning);
  await finishImip(db, account, row, payload, "done", outcome.warning ?? null);
  return "sent";
}

/**
 * 招待メールの結果を記録する。reason があれば (失敗、または一部の宛先だけの失敗)
 * event_conflicts に invite_failed を残す (同じトランザクション)。
 */
async function finishImip(
  db: Database,
  account: AccountRow,
  row: OutboxRow,
  payload: ImipSendPayload,
  status: "done" | "failed",
  reason: string | null,
) {
  await db.transaction(async (tx) => {
    await tx
      .update(outbox)
      .set({ status, lastError: reason })
      .where(eq(outbox.id, row.id));
    if (reason !== null) {
      await recordInviteFailure(tx, account.userId, row.id, payload, reason, {
        partial: status === "done",
      });
    }
  });
}

/**
 * 招待メールの古い記録を消す。送れたものは KEEP_IMIP_DONE_MS、失敗は event_conflicts の記録と
 * 同じ期間 (「もう一度送る」がその行を pending に戻すため) が過ぎたら消す。
 */
async function pruneImipSends(db: Database, account: AccountRow) {
  const accountId = account.id;
  const now = Date.now();
  for (const [status, keep] of [
    ["done", KEEP_IMIP_DONE_MS],
    ["failed", KEEP_CONFLICTS_MS],
  ] as const) {
    await db
      .delete(outbox)
      .where(
        and(
          eq(outbox.accountId, accountId),
          eq(outbox.kind, IMIP_OUTBOX_KIND),
          eq(outbox.status, status),
          lt(outbox.updatedAt, new Date(now - keep)),
        ),
      );
  }
  // 失敗の記録 (invite_failed など) の古いものも消す。CalDAV の書き戻しの処理からも消すが、
  // Orbit 内のカレンダーだけの利用者では、そちらが動かないため (L12)。
  await pruneEventConflicts(db, account.userId, new Date(now));
}

/**
 * 送信元のアカウントの同期が動いていない (メールの同期は active と error だけ) ために、
 * IMIP_STALE_MS たっても送れていない招待メールを失敗にし、invite_failed を残す (M8)。
 * 同期が動いていないアカウントでは processSends が呼ばれないので、worker の定期の処理から呼ぶ。
 * 再ログインした後は「もう一度送る」で送り直せる。戻り値は失敗にした行の数。
 */
export async function failStaleImipSends(
  db: Database,
  now: Date = new Date(),
): Promise<number> {
  const stale = await db
    .select({ row: outbox, account: accountsTable })
    .from(outbox)
    .innerJoin(accountsTable, eq(accountsTable.id, outbox.accountId))
    .where(
      and(
        eq(outbox.kind, IMIP_OUTBOX_KIND),
        inArray(outbox.status, ["pending", "processing"]),
        lt(outbox.createdAt, new Date(now.getTime() - IMIP_STALE_MS)),
        or(
          eq(accountsTable.mailEnabled, false),
          notInArray(accountsTable.status, ["active", "error"]),
        ),
      ),
    );
  let count = 0;
  for (const { row, account } of stale) {
    const reason =
      account.status === "auth_required"
        ? `送信元の ${account.email} の再ログインが必要なため、送れていません。再ログインしてから「もう一度送る」を押してください。`
        : `送信元の ${account.email} の同期が止まっているため、送れていません。`;
    const updated = await db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(outbox)
        .set({ status: "failed", lastError: reason })
        .where(
          and(
            eq(outbox.id, row.id),
            inArray(outbox.status, ["pending", "processing"]),
          ),
        )
        .returning({ id: outbox.id });
      if (!claimed) return false;
      await recordInviteFailure(
        tx,
        account.userId,
        row.id,
        row.payload as unknown as ImipSendPayload,
        reason,
      );
      return true;
    });
    if (updated) count++;
  }
  return count;
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
