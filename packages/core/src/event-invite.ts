/**
 * 招待と出欠の共通の決まり (段取り 8)。API と Web の両方から使うので、依存を持たない。
 * 設計は calendar-dev/invites-design.md の 3 章と 4 章。
 */

/** 予定に対する自分の役割。 */
export type InviteRole = "organizer" | "attendee" | "none";

/** 自分の出欠の返事。needs_action には戻せない (どのサービスにも取り消しの操作が無い)。 */
export type RsvpStatus = "accepted" | "tentative" | "declined";

/**
 * カレンダーが招待の連絡を送れるか。
 * - server: サービス (Google、Microsoft、自動スケジュール対応の CalDAV) が送る。Orbit は送らない。
 * - mail: Orbit が招待メール (iMIP) を送る (段取り 8b)。
 * - none: 送れない。
 */
export type CalendarScheduling = "server" | "mail" | "none";

/**
 * scheduling が none になった理由 (Orbit 内と CalDAV のカレンダーだけ。ほかは null)。
 * - no_sender: 送信できるメールアカウントが無い。
 * - receive_only: 選んだ・当たった送信元が受信専用。
 * - unknown_server: CalDAV のサーバーが招待を送るか、まだ分からない。
 */
export type SchedulingBlocked = "no_sender" | "receive_only" | "unknown_server";

/** 出欠と参加者の変更で API が返すエラーコード。 */
export type InviteErrorCode =
  | "not_attendee"
  | "organizer"
  | "cancelled"
  | "not_organizer"
  | "no_scheduling"
  /** 招待メールの送信数の上限 (1 時間・1 日) を超える変更 (409)。予定も保存しない。 */
  | "invite_limit";

/** カレンダーの応答に足す、招待メールの項目 (設計 10.1)。 */
export type CalendarImipFields = {
  scheduling: CalendarScheduling;
  /** 利用者が選んだ送信元 (calendars.imip_account_id)。null は自動。 */
  imipAccountId: string | null;
  /** 解決した送信元。決まらなければ null。 */
  imipSender: { accountId: string; email: string } | null;
  schedulingBlocked: SchedulingBlocked | null;
};

/** 出欠の返事を主催者へ知らせる方法 (POST /events/:id/respond の応答の notify)。 */
export type RespondNotify = CalendarScheduling;

/** REPLY を送れない理由 (応答の notifyBlocked)。 */
export type NotifyBlocked = "no_sender";

/** 予定の応答の inviteDelivery (招待メールの送信の状態)。 */
export type InviteDelivery = "pending" | "failed";

/** POST /v1/calendars/conflicts/:id/resend-invite のエラーコード (409)。 */
export type ResendInviteErrorCode = "not_resendable";

/** メールの招待カードで、サーバーが決めた「いまできる操作」(設計 10.3)。 */
export type InviteAction =
  | "none"
  | "import"
  | "update"
  | "remove"
  | "apply_reply";

/**
 * 操作の状態。ready = そのまま実行できる。confirm = 確認が要る。
 * auto = 端末が自動で apply を呼んでよい (REPLY だけ)。
 */
export type InviteActionState =
  | "ready"
  | "confirm"
  | "auto"
  | "done"
  | "stale"
  | "blocked";

/** 操作できない理由。apply のエラーコード (409) にも同じ値を使う。 */
export type InviteBlocked =
  | "sender_mismatch"
  | "sender_unverified"
  | "own_event"
  | "not_attendee_of_event"
  | "occurrence_unsupported"
  | "no_calendar"
  | "server_calendar"
  | "unsupported_method";

/** 差出人の認証の結果 (messages.senderCheck から)。 */
export type InviteSenderAuth = "verified" | "unknown" | "failed" | "pending";

/** GET /v1/messages/:id/invite の応答 (invite) に足す項目。 */
export type MessageInviteImipFields = {
  dtstamp: string | null;
  /** From と、ORGANIZER / 返事をした ATTENDEE の一致。 */
  sender: { email: string; matches: boolean; auth: InviteSenderAuth };
  action: InviteAction;
  actionState: InviteActionState;
  blocked: InviteBlocked | null;
  /** import のときの取り込み先の候補と既定。 */
  calendars: { id: string; default: boolean }[];
};

/** POST /v1/messages/:id/invite/apply の本文の expect。 */
export type InviteApplyExpect = Exclude<InviteAction, "none">;

/** POST /v1/messages/:id/invite/apply の本文。 */
export type InviteApplyRequest = {
  expect: InviteApplyExpect;
  calendarId?: string;
  confirmed?: boolean;
};

/** POST /v1/messages/:id/invite/apply のエラーコード (409)。changed = カードを出した後に状況が変わった。 */
export type InviteApplyErrorCode = InviteBlocked | "changed";

/** POST /v1/messages/:id/invite/apply の応答。E は予定の形 (API の CalendarEvent)。 */
export type InviteApplyResult<E = unknown> = {
  applied: boolean;
  eventId: string | null;
  event?: E;
};

export type InvitePerson = { email: string; name?: string; self?: boolean };

const normalize = (email: string) => email.trim().toLowerCase();

/**
 * 予定に対する自分の役割を決める。上から順に当てはめる。
 * 1. 主催者に self の印がある → organizer
 * 2. 主催者に印が無く、self の参加者のアドレスが主催者と同じ → organizer (古い控えのため)
 * 3. 主催者が無く、参加者もいない → organizer (自分で作った予定)
 * 4. self の参加者がいる → attendee
 * 5. それ以外 (共有カレンダーで見ている他人の予定など) → none
 */
export function inviteRole(event: {
  organizer: { email: string; self?: boolean } | null;
  attendees: readonly { email: string; self: boolean }[];
}): InviteRole {
  const { organizer, attendees } = event;
  if (organizer?.self === true) return "organizer";
  const me = attendees.find((attendee) => attendee.self);
  if (organizer) {
    if (
      organizer.self === undefined &&
      me &&
      normalize(me.email) === normalize(organizer.email)
    ) {
      return "organizer";
    }
  } else if (attendees.length === 0) {
    return "organizer";
  }
  return me ? "attendee" : "none";
}

/** 招待された予定 (主催者でない) で、参加者が変えてよい項目。ほかは 409 not_organizer。 */
export const ATTENDEE_EDITABLE_FIELDS = [
  "reminders",
  "useDefaultReminders",
  "busy",
] as const;

/** 自分の返事の時刻を入れる events.fieldUpdatedAt の鍵。EVENT_FIELD_NAMES には入れない。 */
export const MY_RESPONSE_FIELD = "myResponse";

/** 返事のコメントの長さの上限。 */
export const RSVP_COMMENT_MAX = 1000;

/**
 * カレンダーが招待の連絡を送れるか (設計の 3.3、imip-design 3.1)。
 * - google、microsoft: サービスが送る。
 * - caldav: サーバーが calendar-auto-schedule (RFC 6638) を返したときだけ。調べていなければ none。
 * - local、ics、holidays、birthdays など: none。
 */
export function calendarScheduling(calendar: {
  source: string;
  readOnly?: boolean;
  providerState?: Record<string, unknown> | null;
  /** 送信元として使えるメールアカウントが決まっているか。API と worker が解決して渡す。 */
  imipSender?: boolean;
}): CalendarScheduling {
  if (calendar.source === "google" || calendar.source === "microsoft") {
    return "server";
  }
  if (calendar.source === "caldav") {
    return calendar.providerState?.autoSchedule === true ? "server" : "none";
  }
  return "none";
}

/**
 * scheduling が none になった理由 (imip-design 3.1、4.3)。Orbit 内と CalDAV のカレンダーで
 * none のときだけ理由を返し、ほかは null。senderBlocked は送信元の解決 (resolveImipSender) の結果。
 */
export function schedulingBlocked(_calendar: {
  source: string;
  readOnly?: boolean;
  providerState?: Record<string, unknown> | null;
  imipSender?: boolean;
  senderBlocked?: "no_sender" | "receive_only" | null;
}): SchedulingBlocked | null {
  throw new Error("not implemented");
}
