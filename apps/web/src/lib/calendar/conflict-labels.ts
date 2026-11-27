import type {
  Calendar,
  CalendarEvent,
  EventFields,
  Reminder,
} from "@/lib/calendar/api";
import {
  formatMonthDayWeekday,
  formatTimeRange,
  toLocal,
} from "@/lib/calendar/dates";
import type {
  ConflictAction,
  ConflictItem,
  QueuedOp,
} from "@/lib/calendar/offline";
import { describeRule } from "@/lib/calendar/recurrence-label";
import type { SyncStatus } from "@/lib/sync-status";

/**
 * 反映されなかった変更 (競合) と送信待ちの、表示用の文言。
 * 項目名・値・理由・ボタンの文言をここにまとめ、部品は並べるだけにする。
 */

type FieldName = keyof EventFields;

export const FIELD_LABELS: Record<FieldName, string> = {
  summary: "タイトル",
  location: "場所",
  description: "メモ",
  status: "状態",
  busy: "予定あり / 空き",
  time: "日時",
  recurrence: "繰り返し",
  conferenceUrl: "オンライン会議",
  useDefaultReminders: "通知",
  reminders: "通知",
  attendees: "参加者",
};

const FIELD_ORDER: FieldName[] = [
  "summary",
  "time",
  "recurrence",
  "location",
  "conferenceUrl",
  "attendees",
  "reminders",
  "useDefaultReminders",
  "busy",
  "status",
  "description",
];

/** 項目名を、表示の順に並べて重複 (通知の 2 項目) を除いたもの。 */
export function displayFields(fields: readonly FieldName[]): FieldName[] {
  const set = new Set<FieldName>(fields);
  // 「既定の通知を使う」と「通知」は、画面ではどちらも「通知」。1 行にまとめる。
  if (set.has("useDefaultReminders") && set.has("reminders")) {
    set.delete("useDefaultReminders");
  }
  return FIELD_ORDER.filter((field) => set.has(field));
}

/** 項目名の並び (「タイトルと場所」「タイトル、場所と日時」)。 */
export function fieldListLabel(fields: readonly FieldName[]): string {
  const labels = [
    ...new Set(displayFields(fields).map((field) => FIELD_LABELS[field])),
  ];
  if (labels.length === 0) return "変更";
  if (labels.length === 1) return labels[0] as string;
  return `${labels.slice(0, -1).join("、")}と${labels.at(-1)}`;
}

function reminderText(reminder: Reminder): string {
  const { minutes } = reminder;
  const unit =
    minutes === 0
      ? "予定の時刻"
      : minutes % 10080 === 0
        ? `${minutes / 10080} 週間前`
        : minutes % 1440 === 0
          ? `${minutes / 1440} 日前`
          : minutes % 60 === 0
            ? `${minutes / 60} 時間前`
            : `${minutes} 分前`;
  return reminder.method === "email" ? `${unit}にメール` : `${unit}に通知`;
}

/** 日時の値 (「12月1日(月) 10:00〜11:00」)。 */
export function timeLabel(
  time: NonNullable<EventFields["time"]>,
  timeZone: string,
): string {
  const local = toLocal(
    time.allDay
      ? {
          eventId: "",
          masterId: "",
          recurrenceId: null,
          allDay: true,
          startAt: null,
          endAt: null,
          startDate: time.startDate,
          endDate: time.endDate,
        }
      : {
          eventId: "",
          masterId: "",
          recurrenceId: null,
          allDay: false,
          startAt: time.startAt,
          endAt: time.endAt,
          startDate: null,
          endDate: null,
        },
    timeZone,
  );
  if (!local) return "-";
  const range = formatTimeRange(local);
  return local.allDay && range !== "終日"
    ? range
    : `${formatMonthDayWeekday(local.firstDay)} ${range}`;
}

const NONE = "(なし)";

function clip(value: string, length = 40): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}

/** 項目の値を短い文字にする。値が分からなければ null。 */
export function fieldValueLabel(
  field: FieldName,
  values: EventFields | null,
  timeZone: string,
): string | null {
  if (!values) return null;
  // 通知は 2 項目を合わせて 1 つの値にする。
  if (field === "reminders" || field === "useDefaultReminders") {
    if (values.useDefaultReminders === true) return "既定の通知";
    if (values.reminders === undefined) {
      return values.useDefaultReminders === false
        ? "既定の通知を使わない"
        : null;
    }
    return values.reminders.length > 0
      ? values.reminders.map(reminderText).join("、")
      : "通知しない";
  }
  if (!(field in values)) return null;
  switch (field) {
    case "summary":
      return values.summary?.trim() ? clip(values.summary) : "(タイトルなし)";
    case "location":
      return values.location?.trim() ? clip(values.location) : NONE;
    case "description":
      return values.description?.trim() ? clip(values.description) : NONE;
    case "conferenceUrl":
      return values.conferenceUrl?.trim() ? clip(values.conferenceUrl) : NONE;
    case "status":
      return values.status === "tentative"
        ? "仮"
        : values.status === "cancelled"
          ? "取り消し"
          : "確定";
    case "busy":
      return values.busy === false ? "空き" : "予定あり";
    case "time":
      return values.time ? timeLabel(values.time, timeZone) : null;
    case "recurrence": {
      const rrule = values.recurrence?.rrule ?? null;
      if (!rrule) return "繰り返さない";
      return describeRule(rrule.replace(/^RRULE:/i, "")) ?? "繰り返し";
    }
    case "attendees": {
      const list = values.attendees ?? [];
      if (list.length === 0) return NONE;
      const names = list.map((attendee) => attendee.name || attendee.email);
      return names.length > 3
        ? `${names.slice(0, 3).join("、")} ほか ${names.length - 3} 人`
        : names.join("、");
    }
  }
}

/** カレンダーの相手側 (プロバイダ) の呼び名。 */
export function providerLabel(calendar: Calendar | undefined): string {
  switch (calendar?.source) {
    case "google":
      return "Google カレンダー";
    case "microsoft":
      return "Outlook";
    case "caldav":
      return "CalDAV のサーバー";
    default:
      return "カレンダーのサービス";
  }
}

/** API のエラーコードを、理由の文にする。 */
export function errorReasonLabel(code: string | null): string {
  switch (code) {
    case null:
      return "理由は分かりません";
    case "read_only":
      return "このカレンダーは読み取り専用です";
    case "invalid":
      return "内容がサーバーに受け付けられませんでした";
    case "unsupported":
      return "サーバーがこの操作に対応していません";
    case "calendar_sync_stopped":
      return "カレンダーの同期が止まっています";
    case "calendar_disabled":
      return "カレンダーが無効になっています";
    case "deleted_elsewhere":
      return "ほかの端末で削除されていました";
    case "not_found":
      return "予定が見つかりませんでした";
    case "not_attendee":
      return "この予定に招待されていません";
    case "organizer":
      return "自分が主催する予定には返事できません";
    case "cancelled":
      return "この予定は取り消されています";
    case "not_organizer":
      return "主催者でない予定は、通知と「予定あり / 空き」だけ変えられます";
    case "no_scheduling":
      return "このカレンダーからは招待を送れません";
    case "invite_limit":
      return "招待メールの送信数が上限に達しました。しばらくしてからもう一度保存してください";
    case "invite_too_many":
      return "1 回の変更で招待メールを送れる宛先の上限 (200 件) を超えています。参加者を減らしてください";
    default:
      return code.startsWith("http_")
        ? `サーバーの応答 ${code.slice(5)}`
        : "サーバーに断られました";
  }
}

function quoted(item: Pick<ConflictItem, "title" | "snapshot">): string {
  const title = item.title?.trim() || item.snapshot?.summary?.trim();
  return `「${title ? clip(title, 30) : "(タイトルなし)"}」`;
}

/** 競合 1 件の説明の文 (一覧の見出しとトーストに使う)。 */
export function conflictMessage(
  item: ConflictItem,
  calendar: Calendar | undefined,
): string {
  const name = quoted(item);
  const fields = fieldListLabel(item.fields);
  const provider = providerLabel(calendar);
  switch (item.kind) {
    case "field_lost":
      return `${name}の${fields}は、${provider}で後から変更された内容になりました。`;
    case "write_failed":
      if (
        item.source === "server" &&
        item.lost === null &&
        item.fields.length === 1 &&
        item.fields[0] === "attendees"
      ) {
        return `${name}への出欠の返事を、${provider}に送れませんでした。`;
      }
      return item.fields.length > 0
        ? `${name}の${fields}の変更を、${provider}に反映できませんでした。`
        : `${name}の変更を、${provider}に反映できませんでした。`;
    case "create_failed":
      return `${name}を${provider}に作成できませんでした。`;
    case "remote_deleted":
      return `${name}は、${provider}で削除されていました。`;
    case "delete_cancelled":
      return item.source === "server"
        ? `${name}は${provider}で後から変更されていたので、削除しませんでした。`
        : `${name}はほかの端末で後から変更されていたので、削除しませんでした。`;
    case "rejected":
      return `${name}の${fields}は、ほかの端末で後から変更されていたので、変更しませんでした。`;
    case "deleted_elsewhere":
      return `${name}は、ほかの端末で削除されていたので、変更を保存できませんでした。`;
    case "occurrence_gone":
      return `${name}のこの回は、繰り返しの変更で無くなっていたので、変更を保存できませんでした。`;
    case "failed":
      return `${name}の変更を保存できませんでした。`;
    case "invite_failed":
      return inviteFailedMessage(item, name);
  }
}

/** 招待メールの送信の失敗の文 (imip-design 12.4)。 */
function inviteFailedMessage(item: ConflictItem, name: string): string {
  switch (item.invite?.method) {
    case "CANCEL":
      return `${name}の取り消しのメールを送れませんでした。`;
    case "REPLY":
      return `${name}への出欠の返事を主催者へ送れませんでした。`;
    default:
      return `${name}の招待メールを送れませんでした。`;
  }
}

/**
 * invite_failed の理由。サーバーの理由は「招待メールを送れませんでした: <理由>」の形なので、
 * 見出しと重ならないように前置きを外す。一部の宛先だけ失敗したときは宛先を出す。
 */
function inviteFailedReason(item: ConflictItem): string | null {
  const to = item.invite?.to ?? [];
  if (item.invite?.partial && to.length > 0) {
    const shown = to.slice(0, 3).join("、");
    return `次の宛先には送れませんでした: ${
      to.length > 3 ? `${shown} ほか ${to.length - 3} 件` : shown
    }`;
  }
  const reason = item.reason?.trim();
  if (!reason) return null;
  return reason.replace(/^[^:：]*送れませんでした\s*[:：]\s*/, "") || null;
}

/** 説明の下に添える理由 (無ければ null)。 */
export function conflictReason(item: ConflictItem): string | null {
  if (item.kind === "invite_failed") return inviteFailedReason(item);
  if (item.source === "server") return item.reason?.trim() || null;
  if (item.kind === "failed") return errorReasonLabel(item.reason);
  return null;
}

/** ボタンの文言。 */
export function conflictActionLabel(
  item: Pick<ConflictItem, "kind" | "opId">,
  action: ConflictAction,
): string {
  switch (action) {
    case "restore":
      if (item.kind === "occurrence_gone") return "単発の予定として作る";
      if (item.kind === "remote_deleted" || item.kind === "deleted_elsewhere") {
        return "復元";
      }
      return "自分の変更に戻す";
    case "retry":
      return "もう一度試す";
    case "resend":
      return "もう一度送る";
    case "delete":
      return item.kind === "create_failed" ? "予定を消す" : "やはり削除する";
    case "dismiss":
      // 送信待ちから来たものは、閉じると操作も捨てる。
      return item.opId ? "破棄" : "閉じる";
  }
}

/** まとめて届いたときのトーストの文。 */
export function conflictSummary(count: number): string {
  return count === 1
    ? "1 件の変更が反映されませんでした"
    : `${count} 件の変更が反映されませんでした`;
}

export type PendingState = {
  tone: "pending" | "blocked" | "error";
  label: string;
  /** 詳しい理由 (あれば)。 */
  detail: string | null;
};

/** 予定の送信待ちの状態 (印に出す文言)。送信待ちが無ければ null。 */
export function pendingState(ops: readonly QueuedOp[]): PendingState | null {
  if (ops.length === 0) return null;
  const failed = ops.find((op) => op.state === "error");
  if (failed) {
    return {
      tone: "error",
      label: "送信できませんでした",
      detail: errorReasonLabel(failed.error),
    };
  }
  const blocked = ops.find((op) => op.state === "blocked");
  if (blocked) {
    return {
      tone: "blocked",
      label: "未送信",
      detail: errorReasonLabel(blocked.error),
    };
  }
  return { tone: "pending", label: "未送信", detail: null };
}

/** 予定の日時 (EventFields の time の形)。分からなければ null。 */
function eventTime(event: CalendarEvent): EventFields["time"] | null {
  if (event.allDay) {
    return event.startDate
      ? {
          allDay: true,
          startDate: event.startDate,
          endDate: event.endDate ?? event.startDate,
        }
      : null;
  }
  return event.startAt
    ? {
        allDay: false,
        startAt: event.startAt,
        endAt: event.endAt ?? event.startAt,
        startTimeZone: event.startTimeZone,
      }
    : null;
}

/**
 * 競合の予定の日時 (一覧の 2 行目)。いまの予定、削除されたときの控え、
 * 採用された値、自分の値の順に探す。
 */
export function conflictWhen(
  item: ConflictItem,
  current: CalendarEvent | undefined,
  timeZone: string,
): string | null {
  const time =
    (current && eventTime(current)) ??
    (item.snapshot && eventTime(item.snapshot)) ??
    item.kept?.time ??
    item.lost?.time ??
    null;
  return time ? timeLabel(time, timeZone) : null;
}

/** カレンダーの同期の表示 (メールの SyncIndicator に渡す形)。 */
export function calendarSyncStatus(input: {
  online: boolean;
  /** 送信待ちのうち、送れる状態のもの (pending) の数。 */
  pending: number;
  /** カレンダーの一覧を読み込み終えたか。 */
  loaded: boolean;
}): SyncStatus {
  if (!input.online) {
    return {
      tone: "offline",
      label:
        input.pending > 0
          ? `オフライン · 接続後に ${input.pending} 件の変更を反映`
          : "オフライン",
      short: "オフライン",
    };
  }
  if (!input.loaded) {
    return { tone: "busy", label: "読み込んでいます…", short: "読み込み中" };
  }
  if (input.pending > 0) {
    return {
      tone: "busy",
      label: `同期中 · ${input.pending} 件の変更を反映しています`,
      short: "同期中",
    };
  }
  return { tone: "ok", label: "同期済み", short: "同期済み" };
}
