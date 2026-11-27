import { randomUUID } from "node:crypto";
import {
  buildItip,
  CHANNEL_OUTBOX,
  calendarScheduling,
  EVENT_OUTBOX_KINDS,
  type ICalEventData,
  IMIP_OUTBOX_KIND,
  IMIP_RECIPIENTS_PER_DAY,
  IMIP_RECIPIENTS_PER_HOUR,
  IMIP_RECIPIENTS_PER_MESSAGE,
  type ImipPlan,
  type ImipPlanMessage,
  type ImipSendPayload,
  type ItipMethod,
  imipSendKey,
  isSendableAccount,
  type MailAddress,
  normalizeRecurrenceId,
  type OutgoingMessage,
  type ParsedEvent,
  parseICalendar,
} from "@orbit/core";
import { and, asc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { EventWithExtras } from "./calendar-store.js";
import type * as schema from "./schema.js";
import { accounts, calendars, outbox } from "./schema.js";

/**
 * 招待メール (iMIP) を outbox (kind = imip_send) に積む (imip-design 6.2)。
 * API (Orbit 内のカレンダー) と worker (CalDAV の書き戻しの成功後) の両方から呼ぶ。
 */

type Executor = Pick<
  NodePgDatabase<typeof schema>,
  "select" | "insert" | "execute"
>;

type CalendarRow = typeof calendars.$inferSelect;

export type ImipEnqueueContext = {
  userId: string;
  calendarId: string;
  /** 元の操作の対象の予定 (削除では消えた行の ID)。 */
  eventId: string;
  /**
   * 元の操作の冪等キー (eventCreateKey / eventUpdateKey / eventDeleteKey / eventRespondKey)。
   * imip_send のキーは imipSendKey(baseKey, METHOD, 通し番号)。
   */
  baseKey: string;
  /** 浮動時刻のタイムゾーン (buildItip の defaultTimeZone)。 */
  defaultTimeZone: string;
  /**
   * 上限の数から除く outbox の行 (worker が、いま処理している event_* の行を渡す。
   * その行の payload の計画は、これから積む imip_send と同じものなので二重に数えない)。
   */
  sourceOutboxId?: string;
  /** 上限の判定の「いま」。省けば現在時刻。 */
  now?: Date;
};

export type ImipEnqueueResult = {
  /** 積んだ imip_send の行の数 (積み済みで増えなかった分は数えない)。 */
  enqueued: number;
  /**
   * 積まなかった理由 (1 通も積んでいない)。
   * - not_mail: カレンダーを読み直したら scheduling が mail でない (二重送信の防止。記録は要らない)。
   * - sender_unavailable: 計画の送信元が無い・送信できない。
   * - sender_mismatch: 送信元のアドレスが、iCalendar の ORGANIZER (REPLY は自分の ATTENDEE) と違う。
   * - limit: 送信数の上限 (1 時間・1 日) を超える。API は保存の前に imipLimitExceeded で断るので、
   *   ここで当たるのは受け付けた後に上限を使い切ったときだけ。
   */
  skipped:
    | "not_mail"
    | "sender_unavailable"
    | "sender_mismatch"
    | "limit"
    | null;
  /**
   * 本文を作れずに飛ばしたメッセージの数 (content が無く、eventRows に対象の行が無い)。
   * 削除のように行が消える操作は、計画に content を入れておく約束。
   */
  incomplete: number;
  /** 本文を作れずに飛ばしたメッセージ (invite_failed の記録に使う。積めた分は含めない)。 */
  incompleteMessages: ImipPlanMessage[];
};

const lower = (email: string) => email.trim().toLowerCase();

// biome-ignore lint/suspicious/noControlCharactersInRegex: 件名と名前から制御文字を除くための正規表現
const CONTROL = /[\u0000-\u001f\u007f]+/g;
const noControl = (value: string) => value.replace(CONTROL, " ").trim();

// ---------------------------------------------------------------------------
// 送信元の解決 (imip-design 4.2)

/** カレンダーの送信元。email は From と、新しい予定の ORGANIZER に使う。 */
export type CalendarImipSender = {
  accountId: string;
  email: string;
  displayName: string | null;
};

export type CalendarImipSenderResolution =
  | { sender: CalendarImipSender; blocked: null }
  | { sender: null; blocked: "no_sender" | "receive_only" };

/** 送信元の判定に使うアカウントの値 (サイドバーの並び順に並べて渡す)。 */
export type ImipSenderCandidate = {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
  mailEnabled: boolean;
  protocol: string;
  smtpHost: string | null;
  status: string;
};

/** アカウントの自分のアドレス (email と、@ を含む username)。小文字。 */
function ownAddresses(account: { email: string; username: string }) {
  return new Set(
    [account.email, account.username]
      .filter((value) => value.includes("@"))
      .map((value) => lower(value)),
  );
}

function toSender(account: ImipSenderCandidate): CalendarImipSender {
  return {
    accountId: account.id,
    email: account.email,
    displayName: account.displayName,
  };
}

/**
 * カレンダーの送信元 (4.2 の「カレンダーの送信元」。上から順):
 * 1. calendars.imipAccountId が送信できる → それ (受信専用なら receive_only。ほかへ進まない)
 * 2. カレンダーの accountId のアカウント自身が送信できる → それ
 * 3. カレンダーのアカウントと同じアドレスの、送信できる別のアカウント → それ
 *    (2・3 で当たるのが受信専用だけなら receive_only)
 * 4. 利用者の送信できるアカウントが 1 つだけ → それ
 * 5. 2 つ以上 → サイドバーの並び順 (sortOrder、追加した順) の先頭
 * 6. 1 つも無い → no_sender
 * list は利用者のアカウントをサイドバーの並び順に並べたもの。API (画面と計画) と worker
 * (CalDAV の self の判定) が同じ結果になるよう、判定はこの関数 1 つに置く (imip レビュー L11)。
 */
export function pickCalendarImipSender(
  list: readonly ImipSenderCandidate[],
  calendar: Pick<CalendarRow, "accountId" | "imipAccountId">,
): CalendarImipSenderResolution {
  if (calendar.imipAccountId) {
    const chosen = list.find(
      (account) => account.id === calendar.imipAccountId,
    );
    if (chosen) {
      return isSendableAccount(chosen)
        ? { sender: toSender(chosen), blocked: null }
        : { sender: null, blocked: "receive_only" };
    }
  }
  const own = calendar.accountId
    ? list.find((account) => account.id === calendar.accountId)
    : undefined;
  if (own) {
    if (isSendableAccount(own)) return { sender: toSender(own), blocked: null };
    const addresses = ownAddresses(own);
    const same = list.filter(
      (account) =>
        account.id !== own.id &&
        [...ownAddresses(account)].some((address) => addresses.has(address)),
    );
    const match = same.find(isSendableAccount);
    if (match) return { sender: toSender(match), blocked: null };
    if (same.length > 0 || own.mailEnabled) {
      return { sender: null, blocked: "receive_only" };
    }
  }
  const first = list.find(isSendableAccount);
  if (!first) return { sender: null, blocked: "no_sender" };
  return { sender: toSender(first), blocked: null };
}

/** 利用者のアカウントを、サイドバーの並び順 (sortOrder → 作った順) で読む。 */
export async function loadImipSenderCandidates(
  db: Pick<Executor, "select">,
  userId: string,
): Promise<ImipSenderCandidate[]> {
  return db
    .select({
      id: accounts.id,
      email: accounts.email,
      username: accounts.username,
      displayName: accounts.displayName,
      mailEnabled: accounts.mailEnabled,
      protocol: accounts.protocol,
      smtpHost: accounts.smtpHost,
      status: accounts.status,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .orderBy(
      asc(accounts.sortOrder),
      asc(accounts.createdAt),
      asc(accounts.id),
    );
}

/** カレンダーの送信元を、利用者のアカウントを読んで決める (pickCalendarImipSender)。 */
export async function resolveCalendarImipSender(
  db: Pick<Executor, "select">,
  calendar: Pick<CalendarRow, "userId" | "accountId" | "imipAccountId">,
): Promise<CalendarImipSenderResolution> {
  return pickCalendarImipSender(
    await loadImipSenderCandidates(db, calendar.userId),
    calendar,
  );
}

/**
 * 利用者の「自分のアドレス」(全アカウントの email と、@ を含む username。小文字)。
 * CalDAV の取り込みで、主催者が自分かを決めるのに使う。
 * いまの送信元だけにすると、送信元を変えた後に、前の送信元で主催した予定が「他人の予定」になる
 * (imip レビュー M7)。
 */
export async function userOwnAddresses(
  db: Pick<Executor, "select">,
  userId: string,
): Promise<Set<string>> {
  const list = await db
    .select({ email: accounts.email, username: accounts.username })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  const result = new Set<string>();
  for (const account of list) {
    for (const address of ownAddresses(account)) result.add(address);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 送信数の上限 (imip-design 6.6)

/** 計画の宛先の数 (REPLY は上限に数えない)。 */
export function imipPlanRecipients(plan: ImipPlan): number {
  return plan.messages
    .filter((message) => message.method !== "REPLY")
    .reduce((sum, message) => sum + message.to.length, 0);
}

/**
 * 利用者の、直近 1 時間と 1 日の招待メールの宛先の数 (REPLY を除く)。
 * 積んだ imip_send (状態を問わない) と、まだ書き戻していない event_* の payload の計画を数える。
 */
export async function imipRecipientUsage(
  db: Pick<Executor, "execute">,
  userId: string,
  options: { now?: Date; excludeOutboxId?: string } = {},
): Promise<{ hour: number; day: number }> {
  const now = options.now ?? new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60_000).toISOString();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
  const exclude = options.excludeOutboxId ?? null;
  const eventKinds = sql.join(
    EVENT_OUTBOX_KINDS.map((kind) => sql`${kind}`),
    sql`, `,
  );
  const result = await db.execute<{ hour: string | null; day: string | null }>(
    sql`select
      sum(n) filter (where created_at > ${hourAgo}::timestamptz) as hour,
      sum(n) as day
    from (
      select o.created_at, jsonb_array_length(coalesce(o.payload->'message'->'to', '[]'::jsonb)) as n
      from outbox o join accounts a on a.id = o.account_id
      where a.user_id = ${userId}
        and o.kind = ${IMIP_OUTBOX_KIND}
        and coalesce(o.payload->'imip'->>'method', '') <> 'REPLY'
        and o.created_at > ${dayAgo}::timestamptz
      union all
      select o.created_at, jsonb_array_length(coalesce(m->'to', '[]'::jsonb)) as n
      from outbox o
        join accounts a on a.id = o.account_id
        cross join lateral jsonb_array_elements(
          case when jsonb_typeof(o.payload->'imip'->'messages') = 'array'
            then o.payload->'imip'->'messages' else '[]'::jsonb end
        ) as m
      where a.user_id = ${userId}
        and o.kind in (${eventKinds})
        and o.status in ('pending', 'processing')
        and coalesce(m->>'method', '') <> 'REPLY'
        and o.created_at > ${dayAgo}::timestamptz
        and o.id is distinct from ${exclude}::uuid
    ) as used`,
  );
  const row = result.rows[0];
  return { hour: Number(row?.hour ?? 0), day: Number(row?.day ?? 0) };
}

/**
 * 計画を足すと上限を超えるか。API は予定を保存する前に呼び、true なら 409 invite_limit で断る。
 * 宛先の無い計画 (REPLY だけ) は超えない。
 */
export async function imipLimitExceeded(
  db: Pick<Executor, "execute">,
  userId: string,
  plan: ImipPlan,
  options: { now?: Date; excludeOutboxId?: string } = {},
): Promise<boolean> {
  const adding = imipPlanRecipients(plan);
  if (adding === 0) return false;
  const used = await imipRecipientUsage(db, userId, options);
  return (
    used.hour + adding > IMIP_RECIPIENTS_PER_HOUR ||
    used.day + adding > IMIP_RECIPIENTS_PER_DAY
  );
}

// ---------------------------------------------------------------------------
// 本文

/** DB の行を buildItip に渡す形にする。 */
export function imipEventData(row: EventWithExtras): ICalEventData {
  return {
    uid: row.uid,
    recurrenceId: row.recurrenceId,
    summary: row.summary,
    location: row.location,
    description: row.description,
    status: row.status,
    busy: row.busy,
    allDay: row.allDay,
    startAt: row.startAt,
    endAt: row.endAt,
    startDate: row.startDate,
    endDate: row.endDate,
    startTimeZone: row.startTimeZone,
    endTimeZone: row.endTimeZone,
    rrule: row.rrule,
    rdates: row.rdates,
    exdates: row.exdates,
    organizer: row.organizer
      ? {
          email: row.organizer.email,
          ...(row.organizer.name ? { name: row.organizer.name } : {}),
        }
      : null,
    attendees: row.attendees.map((attendee) => ({
      email: attendee.email,
      name: attendee.name,
      role: attendee.role,
      status: attendee.status,
    })),
    sequence: row.sequence,
    conferenceUrl: row.conferenceUrl,
    useDefaultReminders: true,
    reminders: null,
  };
}

/** メッセージの対象の行 (scope series は原本と例外、occurrence はその回)。無ければ空。 */
function targetRows(
  message: ImipPlanMessage,
  rows: readonly EventWithExtras[],
  eventId: string,
): EventWithExtras[] {
  const main = rows.find((row) => row.id === eventId) ?? null;
  if (message.scope === "occurrence") {
    if (message.recurrenceId) {
      const id = normalizeRecurrenceId(message.recurrenceId);
      const hit = rows.find(
        (row) =>
          row.recurrenceId !== null &&
          normalizeRecurrenceId(row.recurrenceId) === id,
      );
      if (hit) return [hit];
      // 繰り返さない予定の「その行」(recurrenceId が無い行への REPLY など)。
      return main && main.recurrenceId === null && !main.rrule ? [main] : [];
    }
    return main ? [main] : [];
  }
  const uid = main?.uid ?? rows[0]?.uid;
  if (!uid) return [];
  const series = rows.filter((row) => row.uid === uid);
  // 原本を先頭に置く。
  return [
    ...series.filter((row) => row.recurrenceId === null),
    ...series.filter((row) => row.recurrenceId !== null),
  ];
}

/** REQUEST (変更) を送る理由になる項目 (参加者の役割の変更も含めて attendees)。 */
const UPDATE_FIELDS = new Set([
  "time",
  "recurrence",
  "summary",
  "location",
  "description",
  "conferenceUrl",
  "status",
  "attendees",
]);

/**
 * CalDAV の書き戻しの後に、計画を「相手側に実際に書いた内容」に絞る (imip レビュー M1)。
 * 競合のマージで負けた項目の計画を、そのまま送らないため。
 * - writtenFields (変更で書いた項目。null は絞らない): attendees を書いていなければ参加者の
 *   追加・削除のメッセージを、内容の項目を書いていなければ変更の REQUEST を、status を書いて
 *   いなければ取り消し (STATUS:CANCELLED) の CANCEL を、recurrence を書いていなければ
 *   1 回だけの取り消しの CANCEL を捨てる。持ち越したメッセージ (carried) はここでは絞らない。
 * - rows (書いた後の行): REQUEST は「いまも参加者にいる人」だけに、参加者を外す CANCEL は
 *   「いま参加者にいない人」だけに送る。宛先が無くなったメッセージは捨てる。
 */
export function narrowImipPlan(
  plan: ImipPlan,
  writtenFields: readonly string[] | null,
  rows: readonly EventWithExtras[],
  eventId: string,
): ImipPlan {
  const messages: ImipPlanMessage[] = [];
  for (const message of plan.messages) {
    if (message.method === "REPLY") {
      messages.push(message);
      continue;
    }
    if (writtenFields && !message.carried) {
      const wrote = (field: string) => writtenFields.includes(field);
      const keep =
        message.reason === "add" || message.reason === "remove"
          ? wrote("attendees")
          : message.reason === "update"
            ? writtenFields.some((field) => UPDATE_FIELDS.has(field))
            : message.reason === "delete"
              ? message.content !== undefined
                ? wrote("recurrence")
                : wrote("status")
              : true;
      if (!keep) continue;
    }
    // 本文を計画の時点で作ってある削除は、行と突き合わせない (行は消えている)。
    if (message.content !== undefined) {
      messages.push(message);
      continue;
    }
    const [target] = targetRows(
      { ...message, scope: "occurrence" },
      rows,
      eventId,
    ).filter((row) =>
      message.scope === "series" ? row.recurrenceId === null : true,
    );
    if (!target) {
      // 行が無ければ enqueueImip が本文を作れないメッセージとして扱う。
      messages.push(message);
      continue;
    }
    const present = new Set(
      target.attendees.map((attendee) => lower(attendee.email)),
    );
    const isRemove = message.method === "CANCEL" && message.reason === "remove";
    const fits = (address: string) =>
      isRemove ? !present.has(lower(address)) : present.has(lower(address));
    if (message.method === "CANCEL" && !isRemove) {
      messages.push(message);
      continue;
    }
    const to = message.to.filter((entry) => fits(entry.address));
    if (to.length === 0) continue;
    messages.push({
      ...message,
      to,
      ...(message.attendees
        ? { attendees: message.attendees.filter((address) => fits(address)) }
        : {}),
    });
  }
  return { ...plan, messages };
}

/** 予定の表示用のタイムゾーン。 */
function zoneOf(event: ParsedEvent, fallback: string): string {
  const zone = event.startTimeZone;
  if (zone) {
    try {
      new Intl.DateTimeFormat("ja-JP", { timeZone: zone });
      return zone;
    } catch {
      // "+09:00" などは使わない。
    }
  }
  return fallback;
}

function formatDate(date: Date, timeZone: string, withYear = true): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    ...(withYear ? { year: "numeric" } : {}),
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

function formatTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

/** 件名に添える日付 (例: 2026/12/5)。 */
function shortDate(event: ParsedEvent, fallback: string): string | null {
  if (event.allDay && event.startDate) {
    const [y, m, d] = event.startDate.split("-").map(Number);
    return `${y}/${m}/${d}`;
  }
  if (!event.startAt) return null;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: zoneOf(event, fallback),
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(new Date(event.startAt));
}

/** 本文の日時の行 (タイムゾーン名付き)。 */
function whenLine(event: ParsedEvent, fallback: string): string | null {
  if (event.allDay && event.startDate) {
    const start = new Date(`${event.startDate}T00:00:00Z`);
    const lastDay =
      event.endDate && event.endDate > event.startDate
        ? new Date(
            new Date(`${event.endDate}T00:00:00Z`).getTime() - 86_400_000,
          )
        : start;
    const first = formatDate(start, "UTC");
    return lastDay.getTime() > start.getTime()
      ? `${first} 〜 ${formatDate(lastDay, "UTC")} (終日)`
      : `${first} (終日)`;
  }
  if (!event.startAt) return null;
  const zone = zoneOf(event, fallback);
  const start = new Date(event.startAt);
  const end = event.endAt ? new Date(event.endAt) : start;
  const sameDay = formatDate(start, zone) === formatDate(end, zone);
  const tail = sameDay
    ? formatTime(end, zone)
    : `${formatDate(end, zone)} ${formatTime(end, zone)}`;
  return `${formatDate(start, zone)} ${formatTime(start, zone)} 〜 ${tail} (${zone})`;
}

function personLabel(person: { email: string; name?: string | null }): string {
  return person.name
    ? `${noControl(person.name)} <${person.email}>`
    : person.email;
}

const FOOTER = "このメールは Orbit のカレンダーから送信されました。";

const RSVP_LABEL: Record<string, { subject: string; verb: string }> = {
  accepted: { subject: "参加", verb: "参加" },
  tentative: { subject: "未定", verb: "未定" },
  declined: { subject: "不参加", verb: "不参加" },
};

/** 件名と本文 (imip-design 5.2 の表)。 */
export function imipSubjectAndText(
  method: ItipMethod,
  reason: ImipPlanMessage["reason"],
  event: ParsedEvent,
  defaultTimeZone: string,
): { subject: string; text: string } {
  const title = noControl(event.summary ?? "") || "(題名なし)";
  const date = shortDate(event, defaultTimeZone);
  const titled = date ? `${title} (${date})` : title;
  const when = whenLine(event, defaultTimeZone);
  const lines: string[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value?.trim()) lines.push(`${label}: ${value.trim()}`);
  };

  if (method === "REPLY") {
    const me = event.attendees[0];
    const label = RSVP_LABEL[me?.status ?? ""] ?? {
      subject: "返事",
      verb: "返事",
    };
    const who = me ? noControl(me.name ?? "") || me.email : "参加者";
    lines.push(`${who} さんが${label.verb}と返事しました。`, "");
    add("予定", title);
    add("日時", when);
    if (event.comment?.trim()) {
      lines.push("", "コメント:", event.comment.trim());
    }
    lines.push("", FOOTER);
    return { subject: `${label.subject}: ${title}`, text: lines.join("\n") };
  }

  if (method === "CANCEL") {
    lines.push(
      reason === "remove"
        ? "この予定の参加者から外れました。"
        : "この予定は取り消されました。",
      "",
    );
    add("予定", title);
    add("日時", when);
    if (event.organizer) add("主催者", personLabel(event.organizer));
    lines.push("", FOOTER);
    return { subject: `取り消し: ${titled}`, text: lines.join("\n") };
  }

  const changed = reason === "update";
  if (changed) lines.push("予定が変更されました。", "");
  add("予定", title);
  add("日時", when);
  add("場所", event.location);
  if (event.conferenceUrl) add("会議", event.conferenceUrl);
  if (event.organizer) add("主催者", personLabel(event.organizer));
  if (event.attendees.length > 0) {
    lines.push("参加者:");
    for (const attendee of event.attendees) {
      lines.push(`  ${personLabel(attendee)}`);
    }
  }
  if (event.description?.trim()) {
    lines.push("", "メモ:", event.description.trim());
  }
  lines.push("", FOOTER);
  return {
    subject: `${changed ? "変更" : "招待"}: ${titled}`,
    text: lines.join("\n"),
  };
}

function chunk<T>(list: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < list.length; i += size) {
    result.push(list.slice(i, i + size));
  }
  return result;
}

/** iCalendar を読み、送る VEVENT の代表 (原本、無ければ最初) を返す。読めなければ null。 */
function primaryEvent(
  content: string,
  defaultTimeZone: string,
  recurrenceId: string | null,
): ParsedEvent | null {
  try {
    const parsed = parseICalendar(content, { defaultTimeZone });
    const wanted = recurrenceId ? normalizeRecurrenceId(recurrenceId) : null;
    return (
      (wanted
        ? parsed.events.find(
            (event) =>
              event.recurrenceId !== null &&
              normalizeRecurrenceId(event.recurrenceId) === wanted,
          )
        : undefined) ??
      parsed.events.find((event) => event.recurrenceId === null) ??
      parsed.events[0] ??
      null
    );
  } catch {
    return null;
  }
}

/**
 * 計画 (plan) の各メッセージを、宛先 50 件ごとの imip_send にして積む。トランザクションの中で呼ぶ。
 * 1. 計画の送信元のアカウントが利用者のもので送信できるか、カレンダーを読み直して
 *    calendarScheduling(…, imipSender: true) が mail か確かめる (二重送信の防止)。
 * 2. content の無いメッセージは eventRows (原本と例外、または対象の行) から buildItip で本文を作る。
 *    From のアドレスが ORGANIZER (REPLY は自分の ATTENDEE) と違えば 1 通も積まない。
 * 3. 送信数の上限を超えるなら 1 通も積まない (REPLY だけの計画は数えない)。
 * 4. 宛先を IMIP_RECIPIENTS_PER_MESSAGE 件ごとに分けて積む (冪等キーは imipSendKey。
 *    同じ計画をもう一度積んでも増えない)。
 * 5. pg_notify(CHANNEL_OUTBOX, 送信元の accountId) を打つ (コミット時に届く)。
 */
export async function enqueueImip(
  tx: Executor,
  plan: ImipPlan,
  eventRows: readonly EventWithExtras[],
  context: ImipEnqueueContext,
): Promise<ImipEnqueueResult> {
  const incompleteMessages: ImipPlanMessage[] = [];
  const none = (skipped: ImipEnqueueResult["skipped"]): ImipEnqueueResult => ({
    enqueued: 0,
    skipped,
    incomplete: incompleteMessages.length,
    incompleteMessages,
  });
  if (plan.messages.length === 0) return none(null);

  const [account] = await tx
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.id, plan.senderAccountId),
        eq(accounts.userId, context.userId),
      ),
    );
  if (!account || !isSendableAccount(account)) {
    return none("sender_unavailable");
  }
  const [calendar] = await tx
    .select()
    .from(calendars)
    .where(
      and(
        eq(calendars.id, context.calendarId),
        eq(calendars.userId, context.userId),
      ),
    );
  if (
    !calendar ||
    calendarScheduling({
      source: calendar.source,
      readOnly: calendar.readOnly,
      providerState: calendar.providerState,
      imipSender: true,
    }) !== "mail"
  ) {
    return none("not_mail");
  }

  const stamp = new Date(plan.stamp);
  if (Number.isNaN(stamp.getTime())) {
    throw new Error("enqueueImip: plan.stamp が日時ではありません。");
  }
  const senderEmail = lower(account.email);
  const domain = account.email.split("@")[1] || "orbit.invalid";
  const from: MailAddress = account.displayName
    ? { address: account.email, name: noControl(account.displayName) }
    : { address: account.email };

  type Pending = { key: string; payload: ImipSendPayload };
  const pending: Pending[] = [];
  let index = 0;
  for (const message of plan.messages) {
    const rows = message.content
      ? []
      : targetRows(message, eventRows, context.eventId);
    if (!message.content && rows.length === 0) {
      incompleteMessages.push(message);
      continue;
    }
    // 1 回だけのメッセージの RECURRENCE-ID は、原本の DTSTART の形で書く (L8)。
    const uid = rows[0]?.uid;
    const master = uid
      ? eventRows.find((row) => row.uid === uid && row.recurrenceId === null)
      : undefined;
    const self = rows
      .flatMap((row) => row.attendees)
      .find((attendee) => attendee.self);
    for (const to of chunk(message.to, IMIP_RECIPIENTS_PER_MESSAGE)) {
      const key = imipSendKey(context.baseKey, message.method, index++);
      // 参加者を外す CANCEL は、この通の宛先の分だけを ATTENDEE に書く。
      const attendees =
        message.attendees && message.method === "CANCEL"
          ? message.attendees.filter((address) =>
              to.some((entry) => lower(entry.address) === lower(address)),
            )
          : message.attendees;
      let content: string;
      try {
        content =
          message.content ??
          buildItip({
            method: message.method,
            events: rows.map(imipEventData),
            ...(attendees ? { attendees } : {}),
            ...(message.method === "REPLY"
              ? { comment: self?.comment ?? null }
              : {}),
            dtstamp: stamp,
            defaultTimeZone: context.defaultTimeZone,
            masterTiming: master
              ? { allDay: master.allDay, startTimeZone: master.startTimeZone }
              : null,
          });
      } catch {
        // 読めない日時 (壊れた EXDATE など) で本文を作れない。積まずに記録する (L7)。
        content = "";
      }
      const event = content
        ? primaryEvent(
            content,
            context.defaultTimeZone,
            message.recurrenceId ?? null,
          )
        : null;
      if (!event) {
        incompleteMessages.push({ ...message, to });
        continue;
      }
      // From = 役のアドレス (REQUEST / CANCEL は ORGANIZER、REPLY は自分の ATTENDEE)。4.2。
      const role =
        message.method === "REPLY"
          ? event.attendees.length === 1
            ? event.attendees[0]?.email
            : undefined
          : event.organizer?.email;
      if (!role || lower(role) !== senderEmail) return none("sender_mismatch");
      const { subject, text } = imipSubjectAndText(
        message.method,
        message.reason,
        event,
        context.defaultTimeZone,
      );
      const outgoing: OutgoingMessage = {
        from,
        to,
        cc: [],
        bcc: [],
        subject,
        text,
        html: null,
        attachments: [],
        messageId: `<${randomUUID()}@${domain}>`,
        date: stamp.toISOString(),
        inReplyTo: null,
        references: [],
        calendar: { method: message.method, content },
      };
      pending.push({
        key,
        payload: {
          message: outgoing,
          imip: {
            method: message.method,
            reason: message.reason,
            userId: context.userId,
            calendarId: context.calendarId,
            eventId: context.eventId,
            uid: event.uid,
            recurrenceId: message.recurrenceId ?? event.recurrenceId ?? null,
            sequence: event.sequence,
            title: event.summary,
          },
        },
      });
    }
  }
  if (pending.length === 0) return none(null);

  if (
    await imipLimitExceeded(tx, context.userId, plan, {
      ...(context.now ? { now: context.now } : {}),
      ...(context.sourceOutboxId
        ? { excludeOutboxId: context.sourceOutboxId }
        : {}),
    })
  ) {
    // 積み済み (同じ計画の再実行) なら、上限には当たらない扱いにする。
    const [already] = await tx
      .select({ id: outbox.id })
      .from(outbox)
      .where(
        and(
          eq(outbox.accountId, account.id),
          eq(outbox.idempotencyKey, pending[0]?.key ?? ""),
        ),
      );
    if (!already) return none("limit");
  }

  let enqueued = 0;
  for (const item of pending) {
    const inserted = await tx
      .insert(outbox)
      .values({
        accountId: account.id,
        kind: IMIP_OUTBOX_KIND,
        payload: item.payload as unknown as Record<string, unknown>,
        idempotencyKey: item.key,
      })
      .onConflictDoNothing()
      .returning({ id: outbox.id });
    enqueued += inserted.length;
  }
  if (enqueued > 0) {
    await tx.execute(sql`select pg_notify(${CHANNEL_OUTBOX}, ${account.id})`);
  }
  return {
    enqueued,
    skipped: null,
    incomplete: incompleteMessages.length,
    incompleteMessages,
  };
}
