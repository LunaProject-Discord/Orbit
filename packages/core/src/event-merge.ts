import { normalizeRecurrenceId } from "./recurrence.js";

/**
 * 予定の項目ごとのマージ。プロバイダから届いた内容 (remote) と、Orbit の DB の内容 (local) を、
 * 前回同期した相手側の内容 (base、events.raw を戻したもの) を基準に 3 者で比べる。
 * DB には触らない純粋な関数だけを置く。
 */

/**
 * 項目名。API の予定の変更 (apps/api/src/routes/calendars.ts の eventFields) と同じ。
 * time と recurrence は、関係する値をまとめて 1 つの項目として扱う。
 */
export const EVENT_FIELD_NAMES = [
  "summary",
  "location",
  "description",
  "status",
  "busy",
  "time",
  "recurrence",
  "conferenceUrl",
  "useDefaultReminders",
  "reminders",
  "attendees",
] as const;
export type EventFieldName = (typeof EVENT_FIELD_NAMES)[number];

/** 比べられる形にそろえた項目の値。同じ内容なら JSON にしたときに同じ文字列になる。 */
export type EventFieldValues = Record<EventFieldName, unknown>;

/**
 * eventFieldValues に渡す予定。DB の行 (events に参加者とリマインダーを足したもの) と、
 * プロバイダが返す予定 (CalendarEventInput の形) のどちらも渡せる。
 */
export type EventFieldSource = {
  summary: string | null;
  location: string | null;
  description: string | null;
  status: string;
  busy: boolean;
  allDay: boolean;
  /** DB の行は Date、プロバイダの予定は ISO 8601 の文字列。 */
  startAt: Date | string | null;
  endAt: Date | string | null;
  startDate: string | null;
  endDate: string | null;
  startTimeZone: string | null;
  endTimeZone: string | null;
  rrule: string | null;
  rdates: readonly string[] | null;
  exdates: readonly string[] | null;
  conferenceUrl: string | null;
  /** 省いたら、reminders が null かどうかで決める (CalendarEventInput と同じ決まり)。 */
  useDefaultReminders?: boolean;
  reminders: readonly { method: string; minutes: number }[] | null;
  attendees: readonly {
    email: string;
    name?: string | null;
    role: string;
    status?: string;
  }[];
};

/** 空の文字列は「無い」とみなし、改行は LF にそろえる。 */
function text(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.replace(/\r\n?/g, "\n");
  return normalized === "" ? null : normalized;
}

/** 時刻を UTC の ISO 8601 (ミリ秒付き) にそろえる。読めない値はそのまま残す。 */
function instant(value: Date | string): string {
  const time = typeof value === "string" ? Date.parse(value) : value.getTime();
  if (Number.isNaN(time)) return String(value);
  return new Date(time).toISOString();
}

function nextDay(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(value.getTime())) return date;
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

/**
 * 時刻の項目。終日は日付、時刻付きは UTC の時刻とタイムゾーン。
 * 終わりが無い、または始まり以前のときは、API の表示と同じく補う (終日は翌日、時刻付きは始まり)。
 */
function timeValue(e: EventFieldSource) {
  if (e.allDay) {
    const startDate = e.startDate;
    const endDate =
      startDate && e.endDate && e.endDate > startDate
        ? e.endDate
        : startDate
          ? nextDay(startDate)
          : e.endDate;
    return { allDay: true, startDate, endDate };
  }
  const startAt = e.startAt === null ? null : instant(e.startAt);
  const endAt = e.endAt === null ? startAt : instant(e.endAt);
  return {
    allDay: false,
    startAt,
    endAt,
    startTimeZone: e.startTimeZone,
    endTimeZone: e.endTimeZone ?? e.startTimeZone,
  };
}

/** 回の一覧 (RDATE / EXDATE)。recurrenceId の書き方にそろえ、重複を除いて並べる。 */
function dateList(values: readonly string[] | null): string[] {
  return [...new Set((values ?? []).map(normalizeRecurrenceId))].sort();
}

/**
 * RRULE。先頭の "RRULE:" を外して大文字にし、部分の順番をそろえる (FREQ を先頭、残りは名前順)。
 * 比べるためだけの形で、書き戻しには使わない。
 */
function ruleValue(rrule: string | null): string | null {
  if (rrule === null) return null;
  const body = rrule
    .trim()
    .replace(/^RRULE:/i, "")
    .toUpperCase();
  if (body === "") return null;
  const parts = body.split(";").filter((part) => part !== "");
  const freq = parts.filter((part) => part.startsWith("FREQ="));
  const rest = parts.filter((part) => !part.startsWith("FREQ=")).sort();
  return [...freq, ...rest].join(";");
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 参加者。メールアドレスを小文字にし、同じアドレスは 1 人にまとめて、アドレスの順に並べる。
 * 出欠 (status) も比べる (相手側で誰かが返事をしたら、相手側の変更として扱う)。
 * self は DB の側で決める値なので比べない。
 */
function attendeesValue(attendees: EventFieldSource["attendees"]) {
  const byEmail = new Map<
    string,
    { email: string; name: string | null; role: string; status: string | null }
  >();
  for (const attendee of attendees) {
    const email = attendee.email.trim().toLowerCase();
    byEmail.set(email, {
      email,
      name: text(attendee.name ?? null),
      role: attendee.role,
      status: attendee.status ?? null,
    });
  }
  return [...byEmail.values()].sort((a, b) => compareText(a.email, b.email));
}

/** リマインダー。分の順 (同じなら方法の順) に並べる。null は空の一覧とみなす。 */
function remindersValue(reminders: EventFieldSource["reminders"]) {
  return (reminders ?? [])
    .map((reminder) => ({ method: reminder.method, minutes: reminder.minutes }))
    .sort((a, b) => a.minutes - b.minutes || compareText(a.method, b.method));
}

/** 予定を、項目ごとの比べられる値にする。 */
export function eventFieldValues(e: EventFieldSource): EventFieldValues {
  return {
    summary: text(e.summary),
    location: text(e.location),
    description: text(e.description),
    status: e.status,
    busy: e.busy,
    time: timeValue(e),
    recurrence: {
      rrule: ruleValue(e.rrule),
      rdates: dateList(e.rdates),
      exdates: dateList(e.exdates),
    },
    conferenceUrl: text(e.conferenceUrl),
    useDefaultReminders: e.useDefaultReminders ?? e.reminders === null,
    reminders: remindersValue(e.reminders),
    attendees: attendeesValue(e.attendees),
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  // eventFieldValues はキーの順番が決まった値を作るので、JSON の文字列で比べられる。
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 値の違う項目を、EVENT_FIELD_NAMES の順に返す。 */
export function changedEventFields(
  a: EventFieldValues,
  b: EventFieldValues,
): EventFieldName[] {
  return EVENT_FIELD_NAMES.filter((field) => !sameValue(a[field], b[field]));
}

/** 時刻を読む。読めなければ null。未来の時刻 (時計のずれ) は now に丸める。 */
function clampedTime(
  value: string | null | undefined,
  now: Date,
): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return Math.min(time, now.getTime());
}

export type EventMergeInput = {
  /** 前回同期した相手側の内容 (events.raw を戻したもの)。raw が無ければ null。 */
  base: EventFieldValues | null;
  /** DB のいまの内容。 */
  local: EventFieldValues;
  /** 相手側の最新の内容。 */
  remote: EventFieldValues;
  /** events.fieldUpdatedAt (項目名 → ISO 8601)。 */
  localFieldAt: Readonly<Record<string, string>>;
  /** まだ書き戻していないローカルの変更がある項目。 */
  localPending: ReadonlySet<EventFieldName>;
  /** 相手側での最終更新時刻 (ISO 8601)。分からなければ null。 */
  remoteUpdatedAt: string | null;
  now: Date;
};

export type EventMergeResult = {
  /** 相手側の値を採る項目 (lostLocal を含む)。 */
  takeRemote: EventFieldName[];
  /** ローカルの値を残す項目。取り込むときは、相手側の値を DB の値で差し替える。 */
  keepLocal: EventFieldName[];
  /** 未送信のローカルの変更が、相手側の新しい変更に負けて失われる項目。 */
  lostLocal: EventFieldName[];
  /** マージ後の fieldUpdatedAt。相手側を採った項目は相手側の時刻 (無ければ now) にする。 */
  fieldUpdatedAt: Record<string, string>;
};

/**
 * 項目ごとに、相手側とローカルのどちらを採るかを決める。決まり:
 * - 相手側で変わった項目 (base と remote が違う) で、未送信のローカルの変更が無ければ、相手側を採る。
 * - 両方で変わった項目は、localFieldAt と remoteUpdatedAt の新しい方を採る。
 *   remoteUpdatedAt が無ければ相手側を採る。同じ時刻ならローカルを残す。
 * - base が null なら、未送信の項目だけローカルを残し、ほかは相手側を採る。
 * - 相手側で変わっていない項目は、未送信ならローカルを残す。
 *   未送信でないのにローカルと相手側が違う場合 (書き戻しが失敗した後など) は、相手側にそろえる。
 * ローカルと相手側が同じ値の項目は、どの一覧にも入れない (何もしなくてよい)。
 * 未来の時刻は now に丸めてから比べる。
 */
export function mergeEventFields(input: EventMergeInput): EventMergeResult {
  const { base, local, remote, localPending, now } = input;
  const takeRemote: EventFieldName[] = [];
  const keepLocal: EventFieldName[] = [];
  const lostLocal: EventFieldName[] = [];
  const fieldUpdatedAt: Record<string, string> = { ...input.localFieldAt };
  const remoteAt = clampedTime(input.remoteUpdatedAt, now);
  const remoteStamp = new Date(remoteAt ?? now.getTime()).toISOString();

  for (const field of EVENT_FIELD_NAMES) {
    if (sameValue(local[field], remote[field])) continue;
    const pending = localPending.has(field);
    const remoteChanged =
      base === null || !sameValue(base[field], remote[field]);

    let remoteWins: boolean;
    if (!pending) {
      remoteWins = true;
    } else if (base === null || !remoteChanged) {
      remoteWins = false;
    } else {
      // 両方で変わった。相手側の時刻が分からなければ相手側を採る。
      const localAt = clampedTime(input.localFieldAt[field], now);
      remoteWins = remoteAt === null || localAt === null || remoteAt > localAt;
      if (remoteWins) lostLocal.push(field);
    }

    if (remoteWins) {
      takeRemote.push(field);
      fieldUpdatedAt[field] = remoteStamp;
    } else {
      keepLocal.push(field);
    }
  }
  return { takeRemote, keepLocal, lostLocal, fieldUpdatedAt };
}

/**
 * API の予定の変更 (PATCH の changes、POST の項目) と同じ形の値。
 * 競合の記録 (event_conflicts.lost / snapshot) に入れ、端末はそのまま PATCH / POST に使える。
 */
export type EventFieldChanges = {
  summary?: string | null;
  location?: string | null;
  description?: string | null;
  status?: string;
  busy?: boolean;
  time?:
    | { allDay: true; startDate: string; endDate: string }
    | {
        allDay: false;
        startAt: string;
        endAt: string;
        startTimeZone: string | null;
        endTimeZone: string | null;
      };
  recurrence?: { rrule: string | null; rdates: string[]; exdates: string[] };
  conferenceUrl?: string | null;
  useDefaultReminders?: boolean;
  reminders?: { method: string; minutes: number }[];
  attendees?: { email: string; name: string | null; role: string }[];
};

/**
 * eventFieldValues の値のうち fields の項目を、API の変更の形 (EventFieldChanges) にする。
 * 参加者の出欠 (status) は API で変えられない値なので外す。時刻が欠けていて API の形に
 * できない time は入れない。RRULE は比べるための形 (大文字、部分の順番をそろえたもの) のまま。
 */
export function fieldValuesToChanges(
  values: EventFieldValues,
  fields: readonly EventFieldName[] = EVENT_FIELD_NAMES,
): EventFieldChanges {
  const result: EventFieldChanges = {};
  for (const field of fields) {
    switch (field) {
      case "summary":
      case "location":
      case "description":
      case "conferenceUrl":
        result[field] = values[field] as string | null;
        break;
      case "status":
        result.status = values.status as string;
        break;
      case "busy":
      case "useDefaultReminders":
        result[field] = values[field] as boolean;
        break;
      case "time": {
        const time = values.time as ReturnType<typeof timeValue>;
        if (time.allDay) {
          if (time.startDate && time.endDate) {
            result.time = {
              allDay: true,
              startDate: time.startDate,
              endDate: time.endDate,
            };
          }
        } else if (time.startAt && time.endAt) {
          result.time = {
            allDay: false,
            startAt: time.startAt,
            endAt: time.endAt,
            startTimeZone: time.startTimeZone ?? null,
            endTimeZone: time.endTimeZone ?? null,
          };
        }
        break;
      }
      case "recurrence": {
        const value = values.recurrence as {
          rrule: string | null;
          rdates: string[];
          exdates: string[];
        };
        result.recurrence = {
          rrule: value.rrule,
          rdates: [...value.rdates],
          exdates: [...value.exdates],
        };
        break;
      }
      case "reminders":
        result.reminders = (
          values.reminders as { method: string; minutes: number }[]
        ).map((reminder) => ({ ...reminder }));
        break;
      case "attendees":
        result.attendees = (
          values.attendees as {
            email: string;
            name: string | null;
            role: string;
          }[]
        ).map(({ email, name, role }) => ({ email, name, role }));
        break;
    }
  }
  return result;
}
