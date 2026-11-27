import {
  type CalendarNotificationSettingsBody,
  readCalendarNotificationSettings,
} from "@orbit/core/calendar-notifications";
import type {
  CalendarImipFields,
  CalendarScheduling,
  InviteDelivery,
} from "@orbit/core/event-invite";
import { ApiError, apiFetch } from "@/lib/api";

/**
 * 予定の API (/v1/calendars) の型と呼び出し。
 * 時刻付きの予定は UTC の ISO 8601、終日の予定は YYYY-MM-DD (終わりの日は含まない)。
 */

export type CalendarSource =
  | "google"
  | "microsoft"
  | "caldav"
  | "ics"
  | "local"
  | "holidays"
  | "birthdays";

export type ReminderMethod = "display" | "email";
export type Reminder = { method: ReminderMethod; minutes: number };

export type Calendar = {
  id: string;
  accountId: string | null;
  source: CalendarSource;
  name: string;
  description: string | null;
  color: string | null;
  timeZone: string | null;
  readOnly: boolean;
  visible: boolean;
  sortOrder: number | null;
  url: string | null;
  pollIntervalSeconds: number | null;
  defaultReminders: Reminder[];
  lastSyncedAt: string | null;
  lastError: string | null;
  /**
   * カレンダーが招待の連絡を送れるか (段取り 8)。古いサーバーと古い控えには無く、
   * 無いときは "none" として扱う (calendarScheduling)。
   */
  scheduling?: CalendarScheduling;
  /**
   * 招待メールの送信元 (段取り 8b、imip-design 10.1)。古いサーバーと古い控えには無い。
   * imipAccountId は利用者が選んだ値 (null は自動)、imipSender は解決した送信元。
   */
  imipAccountId?: CalendarImipFields["imipAccountId"];
  imipSender?: CalendarImipFields["imipSender"];
  /** scheduling が none になった理由 (Orbit 内と CalDAV だけ)。古いサーバーには無い。 */
  schedulingBlocked?: CalendarImipFields["schedulingBlocked"];
  /**
   * 出欠を返してよいかの材料 (Google の primary と自分の権限)。古いサーバーと
   * Google 以外では無い。判定は lib/calendar/rsvp.ts の respondsAsAccount。
   */
  primary?: boolean | null;
  accessRole?: string | null;
  /**
   * 通知が効くか (段取り 9、設計 2.5)。サーバーが種類ごとの既定まで解決した値。
   * 古いサーバーと古い控えには無く、無いときは通知の設定を出さない (calendarNotifySupported)。
   */
  notify?: boolean;
  /** 種類ごとの既定 (ics・holidays・birthdays はオフ、ほかはオン)。古いサーバーには無い。 */
  notifyDefault?: boolean;
  /** 既定の通知 (defaultReminders) を Orbit で変えられるか。古いサーバーには無い。 */
  defaultRemindersEditable?: boolean;
  updatedAt: string;
};

/** サーバーがカレンダーごとの通知に対応しているか (応答に notify があるか)。 */
export function calendarNotifySupported(
  calendar: Pick<Calendar, "notify"> | null | undefined,
): boolean {
  return typeof calendar?.notify === "boolean";
}

/**
 * カレンダーの既定の通知 (defaultReminders) を Orbit で変えられるか。サーバーが応答の
 * defaultRemindersEditable で決める (今は Orbit 内と購読だけ)。古いサーバーには無く、変えられない。
 */
export function calendarDefaultRemindersEditable(
  calendar: Pick<Calendar, "defaultRemindersEditable">,
): boolean {
  return calendar.defaultRemindersEditable === true;
}

/**
 * カレンダーが招待を送れるか。項目が無い (古いサーバー・古い控え) か知らない値なら
 * 送れない側に倒す。mail は Orbit が招待メールを送る (段取り 8b)。
 */
export function calendarScheduling(
  calendar: Pick<Calendar, "scheduling"> | null | undefined,
): CalendarScheduling {
  const value = calendar?.scheduling;
  return value === "server" || value === "mail" ? value : "none";
}

export type AttendeeStatus =
  | "needs_action"
  | "accepted"
  | "declined"
  | "tentative"
  | "delegated";

export type Attendee = {
  email: string;
  name: string | null;
  role: "chair" | "required" | "optional" | "non_participant";
  status: AttendeeStatus;
  self: boolean;
  /** 返事のコメント (段取り 8b)。古いサーバーには無い。 */
  comment?: string | null;
  /** 最後に反映したメールの返事 (REPLY) の時刻。古いサーバーには無い。 */
  repliedAt?: string | null;
};

export type CalendarEvent = {
  id: string;
  calendarId: string;
  uid: string;
  recurrenceId: string | null;
  parentId: string | null;
  summary: string | null;
  location: string | null;
  description: string | null;
  status: "confirmed" | "tentative" | "cancelled";
  busy: boolean;
  allDay: boolean;
  startAt: string | null;
  endAt: string | null;
  startDate: string | null;
  endDate: string | null;
  startTimeZone: string | null;
  endTimeZone: string | null;
  rrule: string | null;
  rdates: string[];
  exdates: string[];
  /** self は自分が主催者か (段取り 8。古いサーバー・古い控えには無い)。 */
  organizer: { email: string; name?: string; self?: boolean } | null;
  /**
   * アカウントの持ち主として出欠を返事してよいか (サーバーの判定)。共有カレンダーで
   * 他人の出欠を書き換えないため。古いサーバー・古い控えでは無い。
   */
  canRespond?: boolean;
  sequence: number;
  conferenceUrl: string | null;
  useDefaultReminders: boolean;
  reminders: Reminder[];
  attendees: Attendee[];
  /**
   * 招待メールの送信の状態 (段取り 8b。scheduling が mail のカレンダーだけ)。
   * 送り終えたか送るものが無ければ null。古いサーバーには無い。
   */
  inviteDelivery?: InviteDelivery | null;
  fieldUpdatedAt: Record<string, string>;
  updatedAt: string;
};

/** 期間内の 1 回。eventId で予定 (原本か例外) を引く。 */
export type Occurrence = {
  eventId: string;
  masterId: string;
  recurrenceId: string | null;
  allDay: boolean;
  startAt: string | null;
  endAt: string | null;
  startDate: string | null;
  endDate: string | null;
};

export type EventTimeInput =
  | { allDay: true; startDate: string; endDate: string }
  | {
      allDay: false;
      startAt: string;
      endAt: string;
      startTimeZone: string | null;
      endTimeZone?: string | null;
    };

/** 項目ごとに変えられる内容。 */
export type EventFields = {
  summary?: string | null;
  location?: string | null;
  description?: string | null;
  status?: CalendarEvent["status"];
  busy?: boolean;
  time?: EventTimeInput;
  recurrence?: {
    rrule: string | null;
    rdates?: string[] | null;
    exdates?: string[] | null;
  };
  conferenceUrl?: string | null;
  useDefaultReminders?: boolean;
  reminders?: Reminder[];
  attendees?: {
    email: string;
    name?: string | null;
    role?: Attendee["role"];
  }[];
};

export async function listCalendars(signal?: AbortSignal): Promise<Calendar[]> {
  const response = await apiFetch("/v1/calendars", { signal });
  return ((await response.json()) as { calendars: Calendar[] }).calendars;
}

export async function createCalendar(input: {
  name: string;
  color?: string | null;
  timeZone?: string | null;
}): Promise<Calendar> {
  const response = await apiFetch("/v1/calendars", {
    method: "POST",
    body: input,
  });
  return ((await response.json()) as { calendar: Calendar }).calendar;
}

export async function updateCalendar(
  id: string,
  input: Partial<
    Pick<
      Calendar,
      | "name"
      | "description"
      | "color"
      | "timeZone"
      | "visible"
      | "sortOrder"
      | "pollIntervalSeconds"
      | "imipAccountId"
      | "defaultReminders"
    >
  > & {
    /**
     * 通知のオン・オフ (段取り 9)。サーバーは null (種類ごとの既定に戻す) も受け付けるが、
     * 画面はオン・オフだけを送る。
     */
    notify?: boolean;
  },
): Promise<Calendar> {
  const response = await apiFetch(`/v1/calendars/${id}`, {
    method: "PATCH",
    body: input,
  });
  return ((await response.json()) as { calendar: Calendar }).calendar;
}

/** ICS の URL を購読する。取得できなければ ApiError (body.message に理由)。 */
export async function subscribeCalendar(input: {
  url: string;
  name?: string;
  color?: string | null;
  timeZone: string;
}): Promise<Calendar> {
  const response = await apiFetch("/v1/calendars/subscriptions", {
    method: "POST",
    body: input,
  });
  return ((await response.json()) as { calendar: Calendar }).calendar;
}

/**
 * iCloud か一般の CalDAV のアカウントを足す (カレンダーだけのアカウント)。サーバーが接続を確かめてから作る。
 * iCloud で同じ Apple ID のメールのアカウントがあれば、そのアカウントでカレンダーをオンにする (merged)。
 * 失敗すると ApiError (body.message に理由)。カレンダーは同期ワーカーが取り込んでから現れる。
 */
export async function createCaldavAccount(
  input:
    | { provider: "icloud"; appleId: string; password: string }
    | { provider: "generic"; url: string; username: string; password: string },
): Promise<{ accountId: string; merged: boolean }> {
  const response = await apiFetch("/v1/accounts/caldav", {
    method: "POST",
    body: input,
  });
  const body = (await response.json()) as {
    account: { id: string };
    merged: boolean;
  };
  return { accountId: body.account.id, merged: body.merged };
}

/** 購読を今すぐ取得し直す。 */
export async function refreshCalendar(id: string): Promise<Calendar> {
  const response = await apiFetch(`/v1/calendars/${id}/refresh`, {
    method: "POST",
  });
  return ((await response.json()) as { calendar: Calendar }).calendar;
}

export async function deleteCalendar(id: string): Promise<void> {
  await apiFetch(`/v1/calendars/${id}`, { method: "DELETE" });
}

export type EventRange = { events: CalendarEvent[]; occurrences: Occurrence[] };

/** from の日から to の日の前日まで (timeZone での日付) の回。 */
export async function listEvents(
  range: { from: string; to: string; timeZone: string },
  signal?: AbortSignal,
): Promise<EventRange> {
  const query = new URLSearchParams(range).toString();
  const response = await apiFetch(`/v1/calendars/events?${query}`, { signal });
  return (await response.json()) as EventRange;
}

export async function searchEvents(
  q: string,
  signal?: AbortSignal,
): Promise<CalendarEvent[]> {
  const response = await apiFetch(
    `/v1/calendars/events/search?q=${encodeURIComponent(q)}`,
    { signal },
  );
  return ((await response.json()) as { events: CalendarEvent[] }).events;
}

/** 書き込みに添える時刻 (端末の時計のまま)。古いサーバーは知らない項目を無視するか、断る。 */
export type WriteTimes = {
  /** 操作した時刻。 */
  changedAt?: Date | string;
  /** 送る瞬間の端末の時刻 (サーバーが端末の時計のずれを直すのに使う)。 */
  clientNow?: Date;
};

const iso = (value: Date | string) =>
  typeof value === "string" ? value : value.toISOString();

/**
 * 古いサーバーは、予定の作成の本文に知らない項目 (changedAt、clientNow) があると
 * 400 で断る (コードの無い入力の誤り)。そう断られたら、その項目を外して送り直し、
 * 外して通ったときだけ以後は付けない (新しいサーバーの入力の誤りも、コードの無い 400 になるため)。
 */
let createTimesUnsupported = false;

export async function createEvent(
  input: EventFields & {
    id?: string;
    calendarId: string;
    time: EventTimeInput;
  },
  times: WriteTimes = {},
): Promise<CalendarEvent> {
  const extra: Record<string, string> = {};
  if (!createTimesUnsupported) {
    if (times.changedAt) extra.changedAt = iso(times.changedAt);
    if (times.clientNow) extra.clientNow = iso(times.clientNow);
  }
  const post = (body: unknown) =>
    apiFetch("/v1/calendars/events", { method: "POST", body });
  let response: Response;
  try {
    response = await post({ ...input, ...extra });
  } catch (error) {
    if (
      Object.keys(extra).length === 0 ||
      !(error instanceof ApiError) ||
      error.status !== 400 ||
      error.code !== null
    ) {
      throw error;
    }
    // 外して通ったときだけ古いサーバーと決める (外しても断られるなら、ただの入力の誤り)。
    try {
      response = await post(input);
    } catch (retryError) {
      // 届かなかったなどは、その失敗を返す (やり直せる)。また 400 なら最初の断りを返す。
      throw retryError instanceof ApiError && retryError.status === 400
        ? error
        : retryError;
    }
    createTimesUnsupported = true;
  }
  return ((await response.json()) as { event: CalendarEvent }).event;
}

export type EventUpdateResult = {
  event: CalendarEvent;
  /** ほかの端末が後から変えていたので、変えなかった項目。 */
  rejected: (keyof EventFields)[];
};

function changedAtFor(
  changes: EventFields,
  at: Date | Record<string, string>,
): Record<string, string> {
  if (!(at instanceof Date)) return at;
  const value = at.toISOString();
  return Object.fromEntries(Object.keys(changes).map((key) => [key, value]));
}

/**
 * 予定を変える。changedAt は端末で変えた時刻 (既定は今)。
 * 項目ごとの時刻 (送信待ちから送るときは、操作した時刻) も渡せる。
 */
export async function updateEvent(
  id: string,
  changes: EventFields,
  changedAt: Date | Record<string, string> = new Date(),
  clientNow: Date = new Date(),
): Promise<EventUpdateResult> {
  const response = await apiFetch(`/v1/calendars/events/${id}`, {
    method: "PATCH",
    body: {
      changes,
      changedAt: changedAtFor(changes, changedAt),
      clientNow: clientNow.toISOString(),
    },
  });
  return (await response.json()) as EventUpdateResult;
}

/** 繰り返しのうち 1 回だけを変える。 */
export async function updateOccurrence(
  masterId: string,
  recurrenceId: string,
  changes: EventFields,
  changedAt: Date | Record<string, string> = new Date(),
  clientNow: Date = new Date(),
): Promise<EventUpdateResult> {
  const response = await apiFetch(
    `/v1/calendars/events/${masterId}/occurrences/${encodeURIComponent(recurrenceId)}`,
    {
      method: "PATCH",
      body: {
        changes,
        changedAt: changedAtFor(changes, changedAt),
        clientNow: clientNow.toISOString(),
      },
    },
  );
  return (await response.json()) as EventUpdateResult;
}

/**
 * 予定を消す。deletedAt (削除した時刻) を渡すと、それより後にほかの端末で変更されていれば
 * サーバーは消さずに 409 changed_since ({ event }) を返す (新しいサーバーだけ)。
 */
export async function deleteEvent(
  id: string,
  times: { deletedAt?: Date | string; clientNow?: Date } = {},
): Promise<void> {
  const body: Record<string, string> = {};
  if (times.deletedAt) body.deletedAt = iso(times.deletedAt);
  if (times.clientNow) body.clientNow = iso(times.clientNow);
  await apiFetch(`/v1/calendars/events/${id}`, {
    method: "DELETE",
    ...(Object.keys(body).length > 0 ? { body } : {}),
  });
}

export async function deleteOccurrence(
  masterId: string,
  recurrenceId: string,
  times: WriteTimes = {},
): Promise<void> {
  const body: Record<string, string> = {};
  if (times.changedAt) body.changedAt = iso(times.changedAt);
  if (times.clientNow) body.clientNow = iso(times.clientNow);
  await apiFetch(
    `/v1/calendars/events/${masterId}/occurrences/${encodeURIComponent(recurrenceId)}`,
    { method: "DELETE", ...(Object.keys(body).length > 0 ? { body } : {}) },
  );
}

/**
 * 招待に返事をする (段取り 8 で足すルート)。ルートの無いサーバーでは 404 (コード無し)。
 * 応答は { event, applied } (applied: false は、より新しい返事が既にあったので変えなかった)。
 * 予定が返ってくれば、その予定。主催者・参加者でない・取り消し済みは 409
 * (organizer / not_attendee / cancelled)。
 */
export async function respondToEvent(
  id: string,
  input: {
    status: AttendeeStatus;
    comment?: string | null;
    respondedAt: Date | string;
    clientNow?: Date;
  },
): Promise<CalendarEvent | null> {
  const response = await apiFetch(`/v1/calendars/events/${id}/respond`, {
    method: "POST",
    body: {
      status: input.status,
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
      respondedAt: iso(input.respondedAt),
      clientNow: iso(input.clientNow ?? new Date()),
    },
  });
  const body = (await response.json().catch(() => null)) as {
    event?: CalendarEvent;
  } | null;
  return body?.event ?? null;
}

/** 差分同期 (GET /v1/calendars/sync) の 1 ページ。 */
export type CalendarSyncPage = {
  calendars: Calendar[];
  events: CalendarEvent[];
  deleted: { calendars: string[]; events: string[] };
  latestSeq: string;
  hasMore: boolean;
  /** 未解決の競合の件数 (新しいサーバーだけ)。 */
  openConflicts?: number;
  /** 最新の競合の記録の時刻 (新しいサーバーだけ。無ければ null)。 */
  conflictsAt?: string | null;
};

/** 変更番号 since より後に変わったカレンダーと予定。 */
export async function syncCalendars(
  since: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<CalendarSyncPage> {
  const query = new URLSearchParams({ since });
  if (options.limit) query.set("limit", String(options.limit));
  const response = await apiFetch(`/v1/calendars/sync?${query}`, {
    signal: options.signal,
  });
  return (await response.json()) as CalendarSyncPage;
}

/** サーバーが記録した、反映されなかった変更 (競合)。 */
export type CalendarConflict = {
  id: string;
  calendarId: string | null;
  eventId: string | null;
  kind:
    | "field_lost"
    | "write_failed"
    | "create_failed"
    | "remote_deleted"
    | "delete_cancelled"
    | "invite_failed";
  fields: (keyof EventFields)[];
  /** invite_failed では InviteFailure の形 (項目の値ではない)。 */
  lost: EventFields | null;
  snapshot: CalendarEvent | null;
  title: string | null;
  reason: string | null;
  createdAt: string;
  resolvedAt: string | null;
  /** 回の変更なら、その回 (サーバーが返すときだけ)。 */
  recurrenceId?: string | null;
  /** invite_failed で「もう一度送る」ができるか (新しいサーバーだけ)。 */
  resendable?: boolean;
};

/** 未解決の競合 (新しい順)。 */
export async function listConflicts(
  signal?: AbortSignal,
): Promise<CalendarConflict[]> {
  const response = await apiFetch("/v1/calendars/conflicts", { signal });
  return ((await response.json()) as { conflicts: CalendarConflict[] })
    .conflicts;
}

/** 競合を閉じる。 */
export async function dismissConflict(id: string): Promise<void> {
  await apiFetch(`/v1/calendars/conflicts/${id}`, { method: "DELETE" });
}

/**
 * 招待メールの送信の失敗 (invite_failed) の記録の lost (imip-design 6.5)。
 * to は送れなかった宛先。partial は、ほかの宛先には送れた (一部の宛先だけ拒否された) とき true。
 */
export type InviteFailure = {
  outboxId?: string;
  method?: "REQUEST" | "CANCEL" | "REPLY";
  to?: string[];
  partial?: boolean;
};

/**
 * 送れなかった招待メールを、同じ内容でもう一度送る (invite_failed だけ)。
 * 送り直せない記録は 409 not_resendable。
 */
export async function resendInvite(id: string): Promise<void> {
  await apiFetch(`/v1/calendars/conflicts/${id}/resend-invite`, {
    method: "POST",
  });
}

/** 作成が確定して失敗した予定を、もう一度書き戻す (create_failed だけ)。 */
export async function retryConflict(id: string): Promise<void> {
  await apiFetch(`/v1/calendars/conflicts/${id}/retry`, { method: "POST" });
}

// ---------------------------------------------------------------------------
// 予定の通知の設定 (段取り 9、設計 4.2・6.2)
// ---------------------------------------------------------------------------

/**
 * 予定の通知の設定 (すべての端末で共通) を取得する。GET /v1/settings の
 * calendarNotifications と timeZone を読む。古いサーバーには項目が無く、null を返す。
 */
export async function getCalendarNotificationSettings(
  signal?: AbortSignal,
): Promise<CalendarNotificationSettingsBody | null> {
  const response = await apiFetch("/v1/settings", { signal });
  const body = (await response.json()) as {
    calendarNotifications?: unknown;
    timeZone?: unknown;
  };
  if (!("calendarNotifications" in body)) return null;
  return {
    calendarNotifications: readCalendarNotificationSettings(
      body.calendarNotifications,
    ),
    timeZone: typeof body.timeZone === "string" ? body.timeZone : null,
  };
}

/**
 * 予定の通知の設定を保存する (PUT /v1/settings/calendar-notifications)。サーバーは部分更新も
 * 受け付けるが、画面は全体を送る。古いサーバーでは 404 (ApiError) になる。
 */
export async function saveCalendarNotificationSettings(
  body: CalendarNotificationSettingsBody,
): Promise<void> {
  await apiFetch("/v1/settings/calendar-notifications", {
    method: "PUT",
    body,
  });
}
