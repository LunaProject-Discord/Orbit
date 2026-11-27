import { Temporal } from "temporal-polyfill";
import type { InviteRole } from "./event-invite.js";
import type { ICalEventData } from "./icalendar-write.js";
import { buildItip } from "./itip.js";
import type { ImipPlan, ImipPlanMessage, MailAddress } from "./outbox.js";
import {
  expandOccurrences,
  normalizeRecurrenceId,
  type RecurringEvent,
} from "./recurrence.js";

/**
 * 招待メールの計画 (imip-design 3.2、6.2)。API が予定の変更を受け付けた時点で、
 * 変更前後の予定から「誰に何を送るか」を決める。純粋な関数。
 */

/** 送信数の上限: 利用者ごとの、1 時間の宛先の合計 (REPLY は数えない)。 */
export const IMIP_RECIPIENTS_PER_HOUR = 200;
/** 送信数の上限: 利用者ごとの、1 日の宛先の合計 (REPLY は数えない)。 */
export const IMIP_RECIPIENTS_PER_DAY = 1000;

/** 計画に渡す予定 1 行分 (DB の行と参加者)。 */
export type ImipEvent = Omit<ICalEventData, "organizer" | "attendees"> & {
  organizer: { email: string; name?: string; self?: boolean } | null;
  attendees: readonly (ICalEventData["attendees"][number] & {
    self: boolean;
    /** 返事のコメント (自分の REPLY の COMMENT に書く)。 */
    comment?: string | null;
  })[];
};

/** 受け付けた操作と、計画を作るのに要る値。 */
export type ImipAccepted = {
  operation: "create" | "update" | "delete" | "respond";
  /** 受け付けた時刻 (DTSTAMP)。 */
  stamp: Date;
  /** 終了済みかの判定に使う「いま」。省けば stamp。 */
  now?: Date;
  /** 浮動時刻のタイムゾーン (カレンダーか利用者のもの)。 */
  defaultTimeZone: string;
};

/** 送信元 (REQUEST / CANCEL は主催者のアカウント、REPLY は自分の ATTENDEE のアカウント)。 */
export type ImipPlanSender = { accountId: string; email: string };

const lower = (email: string) => email.trim().toLowerCase();

/** 送れるアドレスか (mailto: で書ける、空白を含まない a@b)。 */
function isMailAddress(email: string): boolean {
  return /^[^\s@<>"]+@[^\s@<>"]+$/.test(email.trim());
}

function address(person: { email: string; name?: string | null }): MailAddress {
  return person.name
    ? { address: person.email.trim(), name: person.name }
    : { address: person.email.trim() };
}

/**
 * 主催者として送る相手: 参加者のうち、自分 (self)・主催者自身・送れないアドレスを除いたもの。
 * non_participant でも ATTENDEE なら送る。
 */
function recipients(event: ImipEvent): MailAddress[] {
  const organizer = event.organizer ? lower(event.organizer.email) : null;
  const seen = new Set<string>();
  const result: MailAddress[] = [];
  for (const attendee of event.attendees) {
    const key = lower(attendee.email);
    if (attendee.self || key === organizer || seen.has(key)) continue;
    if (!isMailAddress(attendee.email)) continue;
    seen.add(key);
    result.push(address(attendee));
  }
  return result;
}

const iso = (value: Date | string | null) =>
  value === null
    ? null
    : Temporal.Instant.from(
        typeof value === "string" ? value : value.toISOString(),
      ).toString();

function timingKey(event: ICalEventData): string {
  return event.allDay
    ? `d:${event.startDate}/${event.endDate}`
    : `t:${iso(event.startAt)}/${iso(event.endAt)}/${event.startTimeZone ?? ""}`;
}

const idSet = (values: readonly string[] | null) =>
  new Set((values ?? []).map(normalizeRecurrenceId));

const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((value) => b.has(value));

const text = (value: string | null) => value ?? "";

function recurringOf(event: ICalEventData): RecurringEvent | null {
  if (event.allDay) {
    if (!event.startDate || !event.endDate) return null;
    return {
      allDay: true,
      startDate: event.startDate,
      endDate: event.endDate,
      rrule: event.rrule,
      rdates: event.rdates,
      exdates: event.exdates,
    };
  }
  const startAt = iso(event.startAt);
  if (!startAt) return null;
  return {
    allDay: false,
    startAt,
    endAt: iso(event.endAt) ?? startAt,
    startTimeZone: event.startTimeZone,
    rrule: event.rrule,
    rdates: event.rdates,
    exdates: event.exdates,
  };
}

/** 残っている参加者の役割 (ROLE) が変わったか (名前だけの変更は送らない。L9)。 */
function rolesChanged(before: ImipEvent, after: ImipEvent): boolean {
  const roles = new Map(
    before.attendees.map((attendee) => [lower(attendee.email), attendee.role]),
  );
  return after.attendees.some((attendee) => {
    const previous = roles.get(lower(attendee.email));
    return previous !== undefined && previous !== attendee.role;
  });
}

/** 最後の回が終わっている (これからの回が 1 つも無い) か。読めない予定は終わっていない側に倒す。 */
function hasEnded(
  event: ICalEventData,
  now: Date,
  defaultTimeZone: string,
): boolean {
  const recurring = recurringOf(event);
  if (!recurring) return false;
  const today = Temporal.Instant.fromEpochMilliseconds(now.getTime())
    .toZonedDateTimeISO(defaultTimeZone)
    .toPlainDate();
  const repeats =
    event.recurrenceId === null &&
    (Boolean(event.rrule) || (event.rdates?.length ?? 0) > 0);
  if (!repeats) {
    if (recurring.allDay) {
      return Temporal.PlainDate.compare(recurring.endDate, today) <= 0;
    }
    return Temporal.Instant.compare(recurring.endAt, now.toISOString()) <= 0;
  }
  // 終わりの無い繰り返し (UNTIL も COUNT も無い RRULE) は、展開せずに続いているとみなす。
  if (event.rrule && !/(^|[;:])(UNTIL|COUNT)=/i.test(event.rrule)) return false;
  const nowIso = now.toISOString();
  const endsAfterNow = (
    occurrence: ReturnType<typeof expandOccurrences>[number],
  ) =>
    occurrence.allDay
      ? Temporal.PlainDate.compare(occurrence.endDate, today) > 0
      : Temporal.Instant.compare(occurrence.endAt, nowIso) > 0;
  try {
    // 明日以降に掛かる回が 1 つでもあれば終わっていない (EXDATE で除いた回の分だけ多めに探す)。
    const tomorrow = today.add({ days: 1 });
    const later = expandOccurrences(
      recurring,
      [],
      {
        from: tomorrow.toString(),
        to: today.add({ years: 100 }).toString(),
        timeZone: defaultTimeZone,
      },
      { defaultTimeZone, limit: (event.exdates?.length ?? 0) + 1 },
    );
    if (later.length > 0) return false;
    // 今日の回は、終わった回を飛ばして「いまより後に終わる回」があるかを見る。
    const todays = expandOccurrences(
      recurring,
      [],
      {
        from: today.toString(),
        to: tomorrow.toString(),
        timeZone: defaultTimeZone,
      },
      { defaultTimeZone },
    );
    return !todays.some(endsAfterNow);
  } catch {
    return false;
  }
}

/** 原本の 1 回分 (1 回だけの取り消しの CANCEL に使う)。長さは原本のまま。 */
function occurrenceOf(master: ImipEvent, recurrenceId: string): ImipEvent {
  const id = normalizeRecurrenceId(recurrenceId);
  const base = {
    ...master,
    recurrenceId: id,
    rrule: null,
    rdates: null,
    exdates: null,
  };
  if (/^\d{4}-\d{2}-\d{2}$/.test(id)) {
    const days =
      master.allDay && master.startDate && master.endDate
        ? Temporal.PlainDate.from(master.startDate).until(
            Temporal.PlainDate.from(master.endDate),
          ).days
        : 1;
    return {
      ...base,
      allDay: true,
      startAt: null,
      endAt: null,
      startDate: id,
      endDate: Temporal.PlainDate.from(id)
        .add({ days: Math.max(days, 1) })
        .toString(),
    };
  }
  const start = Temporal.Instant.from(id);
  const masterStart = iso(master.startAt);
  const masterEnd = iso(master.endAt);
  const length =
    masterStart && masterEnd
      ? Temporal.Instant.from(masterStart).until(masterEnd)
      : Temporal.Duration.from({ hours: 0 });
  return {
    ...base,
    allDay: false,
    startAt: start.toString(),
    endAt: start.add(length).toString(),
    startDate: null,
    endDate: null,
  };
}

/**
 * 変更前後の予定 (before は作成なら null、after は削除なら null) から計画を作る。
 * 送るものが無ければ null。scheduling が mail かどうかは呼ぶ側が確かめる。
 * - 主催者 (role organizer) の作成・変更・削除 → REQUEST / CANCEL (3.2 の表)。
 * - 参加者 (role attendee) の出欠 (operation respond) → 主催者へ REPLY。
 * - 終了済みの予定の変更・取り消しは送らない (未決 6)。
 * 1 回だけの変更 (例外の行) は scope occurrence。新しく作った例外の行は before を null で渡す。
 */
export function planImip(
  before: ImipEvent | null,
  after: ImipEvent | null,
  accepted: ImipAccepted,
  role: InviteRole,
  sender: ImipPlanSender | null,
): ImipPlan | null {
  if (!sender) return null;
  const now = accepted.now ?? accepted.stamp;
  const zone = accepted.defaultTimeZone;
  const messages: ImipPlanMessage[] = [];
  const scopeOf = (event: ImipEvent) =>
    event.recurrenceId === null ? "series" : "occurrence";

  if (accepted.operation === "respond") {
    if (role !== "attendee" || !after || after.status === "cancelled") {
      return null;
    }
    const me = after.attendees.find((attendee) => attendee.self);
    const organizer = after.organizer;
    if (!me || !organizer || !isMailAddress(organizer.email)) return null;
    if (!["accepted", "tentative", "declined"].includes(me.status)) return null;
    messages.push({
      method: "REPLY",
      to: [address(organizer)],
      scope: "occurrence",
      attendees: [me.email],
      reason: "respond",
      recurrenceId: after.recurrenceId,
      // CalDAV では書き戻しの後に積むので、その前に行が消えても (不参加で返事をして削除)
      // 送れるよう、受け付けた時点で本文を作っておく (imip レビュー M4)。
      content: buildItip({
        method: "REPLY",
        events: [after],
        attendees: [me.email],
        comment: me.comment ?? null,
        dtstamp: accepted.stamp,
        defaultTimeZone: zone,
      }),
    });
  } else if (role !== "organizer") {
    return null;
  } else if (accepted.operation === "create") {
    if (!after || after.status === "cancelled") return null;
    if (hasEnded(after, now, zone)) return null;
    const to = recipients(after);
    if (to.length > 0) {
      messages.push({
        method: "REQUEST",
        to,
        scope: scopeOf(after),
        reason: "create",
        ...(after.recurrenceId === null
          ? {}
          : { recurrenceId: after.recurrenceId }),
      });
    }
  } else if (accepted.operation === "delete") {
    if (!before || before.status === "cancelled") return null;
    if (hasEnded(before, now, zone)) return null;
    const to = recipients(before);
    if (to.length > 0) {
      messages.push({
        method: "CANCEL",
        to,
        scope: scopeOf(before),
        reason: "delete",
        recurrenceId: before.recurrenceId,
        content: buildItip({
          method: "CANCEL",
          events: [before],
          dtstamp: accepted.stamp,
          defaultTimeZone: zone,
        }),
      });
    }
  } else {
    if (!after) return null;
    if (!before) {
      // 新しく作った例外の行 (1 回だけ変えた)。
      if (after.status === "cancelled" || hasEnded(after, now, zone)) {
        return null;
      }
      const to = recipients(after);
      if (to.length > 0) {
        messages.push({
          method: "REQUEST",
          to,
          scope: scopeOf(after),
          reason: "update",
          recurrenceId: after.recurrenceId,
        });
      }
    } else if (before.status === "cancelled") {
      // 取り消しを戻した (API が SEQUENCE を上げる)。全員にもう一度 REQUEST を送る (L2)。
      if (after.status === "cancelled" || hasEnded(after, now, zone)) {
        return null;
      }
      const to = recipients(after);
      if (to.length > 0) {
        messages.push({
          method: "REQUEST",
          to,
          scope: scopeOf(after),
          reason: "update",
          ...(after.recurrenceId === null
            ? {}
            : { recurrenceId: after.recurrenceId }),
        });
      }
    } else {
      if (hasEnded(before, now, zone) && hasEnded(after, now, zone)) {
        return null;
      }
      const scope = scopeOf(after);
      const recurrenceId =
        after.recurrenceId === null ? {} : { recurrenceId: after.recurrenceId };
      if (after.status === "cancelled") {
        // 取り消しにした (STATUS:CANCELLED) のは削除と同じ。
        const to = recipients(before);
        if (to.length > 0) {
          messages.push({
            method: "CANCEL",
            to,
            scope,
            reason: "delete",
            ...recurrenceId,
          });
        }
      } else {
        const beforeTo = recipients(before);
        const afterTo = recipients(after);
        const beforeKeys = new Set(beforeTo.map((to) => lower(to.address)));
        const afterKeys = new Set(afterTo.map((to) => lower(to.address)));
        const kept = afterTo.filter((to) => beforeKeys.has(lower(to.address)));
        const added = afterTo.filter(
          (to) => !beforeKeys.has(lower(to.address)),
        );
        const removed = beforeTo.filter(
          (to) => !afterKeys.has(lower(to.address)),
        );
        const timeChanged = timingKey(before) !== timingKey(after);
        const beforeExdates = idSet(before.exdates);
        const afterExdates = idSet(after.exdates);
        const ruleSame =
          text(before.rrule).trim() === text(after.rrule).trim() &&
          sameSet(idSet(before.rdates), idSet(after.rdates));
        // 原本の EXDATE に回を足しただけ (1 回だけ消した) なら、その回の CANCEL だけを送る。
        const newExdates =
          after.recurrenceId === null && ruleSame && !timeChanged
            ? [...afterExdates].filter((id) => !beforeExdates.has(id))
            : [];
        const exdatesOnlyAdded = [...beforeExdates].every((id) =>
          afterExdates.has(id),
        );
        const recurrenceChanged =
          !ruleSame ||
          !(exdatesOnlyAdded || sameSet(beforeExdates, afterExdates));
        const contentChanged =
          text(before.summary) !== text(after.summary) ||
          text(before.location) !== text(after.location) ||
          text(before.description) !== text(after.description) ||
          text(before.conferenceUrl) !== text(after.conferenceUrl) ||
          before.status !== after.status ||
          rolesChanged(before, after);
        if (
          kept.length > 0 &&
          (timeChanged || recurrenceChanged || contentChanged)
        ) {
          messages.push({
            method: "REQUEST",
            to: kept,
            scope,
            reason: "update",
            ...recurrenceId,
          });
        }
        if (added.length > 0) {
          messages.push({
            method: "REQUEST",
            to: added,
            scope,
            reason: "add",
            ...recurrenceId,
          });
        }
        if (removed.length > 0) {
          messages.push({
            method: "CANCEL",
            to: removed,
            scope,
            attendees: removed.map((to) => to.address),
            reason: "remove",
            ...recurrenceId,
          });
        }
        if (!recurrenceChanged && kept.length > 0) {
          for (const id of newExdates) {
            const occurrence = occurrenceOf(before, id);
            if (hasEnded(occurrence, now, zone)) continue;
            messages.push({
              method: "CANCEL",
              to: kept,
              scope: "occurrence",
              reason: "delete",
              recurrenceId: id,
              content: buildItip({
                method: "CANCEL",
                events: [occurrence],
                dtstamp: accepted.stamp,
                defaultTimeZone: zone,
              }),
            });
          }
        }
      }
    }
  }
  if (messages.length === 0) return null;
  return {
    senderAccountId: sender.accountId,
    stamp: accepted.stamp.toISOString(),
    messages,
  };
}

/** 送信数の上限に数える宛先の数 (REPLY を除く)。 */
export function imipRecipientCount(plan: ImipPlan | null): number {
  if (!plan) return 0;
  return plan.messages
    .filter((message) => message.method !== "REPLY")
    .reduce((sum, message) => sum + message.to.length, 0);
}
