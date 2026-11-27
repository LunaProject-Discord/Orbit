import { inviteRole } from "@orbit/core/event-invite";
import type { Account } from "@/lib/api";
import {
  type Calendar,
  type CalendarEvent,
  calendarScheduling,
} from "@/lib/calendar/api";
import { type ImipAccount, replySenderAccount } from "@/lib/calendar/imip";

/**
 * 出欠のボタンを出してよいかの判定 (calendar-dev/review-invites.md の 3 と 6)。
 * 詳細・削除の確認・メールの招待カードで同じ判定を使う。
 */

export type RsvpAccount = Pick<Account, "id" | "email">;

export type RsvpCalendar = Pick<Calendar, "accountId" | "scheduling"> & {
  /**
   * Google の primary のカレンダーか / 自分の権限 (owner・writer など)。
   * 返事してよいかの材料。古いサーバーと Google 以外では無い。
   */
  primary?: boolean | null;
  accessRole?: string | null;
};

const normalize = (email: string) => email.trim().toLowerCase();

/**
 * サーバーが出欠の返事を受け付けるか。出欠の API より前の古いサーバーは、カレンダーに
 * scheduling を返さない (指摘 6)。そのときは出欠のボタンを出さず、削除はふつうの削除にする。
 */
export function serverHandlesRsvp(
  calendar: Pick<Calendar, "scheduling"> | null | undefined,
): boolean {
  return calendar?.scheduling !== undefined;
}

/**
 * self の参加者として返事をすると、アカウントの持ち主の返事になるか (指摘 3)。
 * Google の共有カレンダーでは attendees[].self は「そのカレンダーの持ち主」なので、
 * 返事をすると同僚の出欠を同僚の名前で書き換えてしまう。
 * - primary のカレンダーか、権限が owner → よい
 * - self の参加者のアドレスがアカウントのアドレスと同じ → よい
 * - 材料 (primary / accessRole) の無いサーバー・カレンダー → 今までどおりよい
 */
export function respondsAsAccount(
  event: Pick<CalendarEvent, "attendees" | "canRespond">,
  calendar: RsvpCalendar,
  accounts: readonly RsvpAccount[] | null | undefined,
): boolean {
  // サーバーが判定した値があればそれに従う (calendar-identity.ts)。
  if (typeof event.canRespond === "boolean") return event.canRespond;
  const known =
    typeof calendar.primary === "boolean" ||
    typeof calendar.accessRole === "string";
  if (!known) return true;
  if (calendar.primary === true || calendar.accessRole === "owner") return true;
  const me = event.attendees.find((attendee) => attendee.self);
  const account = accounts?.find((entry) => entry.id === calendar.accountId);
  return (
    me !== undefined &&
    account !== undefined &&
    normalize(me.email) === normalize(account.email)
  );
}

/** 出欠のボタンを出すか (書き込めるか・取り消し済みかは呼ぶ側で見る)。 */
export function canRespondTo(
  event: Pick<CalendarEvent, "attendees" | "organizer" | "canRespond">,
  calendar: RsvpCalendar | null | undefined,
  accounts?: readonly RsvpAccount[] | null,
): boolean {
  if (!calendar || !serverHandlesRsvp(calendar)) return false;
  if (inviteRole(event) !== "attendee") return false;
  return respondsAsAccount(event, calendar, accounts);
}

/** respondsAsAccount の判定にアカウントのアドレスが要るか (要るときだけ一覧を読む)。 */
export function needsAccounts(calendar: RsvpCalendar | null | undefined) {
  return (
    !!calendar &&
    (typeof calendar.primary === "boolean" ||
      typeof calendar.accessRole === "string") &&
    calendar.primary !== true &&
    calendar.accessRole !== "owner"
  );
}

/**
 * 出欠の返事が主催者にどう届くか (imip-design 12.3)。
 * - server: カレンダーのサービスが知らせる。
 * - mail: Orbit が from のアドレスから REPLY のメールを送る。
 * - none: 知らせない。no_sender は返事を送れるメールアカウントが無い、
 *   calendar_only はこのカレンダーにだけ記録する (招待を送るか分からない CalDAV など)。
 *
 * mail で、自分のアドレスの送信できるアカウントが無ければ none (no_sender)。アカウントの
 * 一覧が分からない (読み込み中) ときは、自分の参加者のアドレスから送るものとして出す
 * (送るかどうかはサーバーが決める)。
 */
export type RsvpDelivery =
  | { via: "server" }
  | { via: "mail"; from: string }
  | { via: "none"; reason: "no_sender" | "calendar_only" };

export function rsvpDelivery(
  event: Pick<CalendarEvent, "attendees">,
  calendar: Pick<Calendar, "scheduling" | "schedulingBlocked"> | undefined,
  accounts: readonly ImipAccount[] | null | undefined,
): RsvpDelivery {
  const scheduling = calendarScheduling(calendar);
  if (scheduling === "server") return { via: "server" };
  if (scheduling === "mail") {
    const me = event.attendees.find((attendee) => attendee.self);
    if (!me) return { via: "none", reason: "calendar_only" };
    if (!accounts) return { via: "mail", from: me.email };
    const account = replySenderAccount(me.email, accounts);
    return account
      ? { via: "mail", from: account.email }
      : { via: "none", reason: "no_sender" };
  }
  const blocked = calendar?.schedulingBlocked;
  return {
    via: "none",
    reason:
      blocked === "no_sender" || blocked === "receive_only"
        ? "no_sender"
        : "calendar_only",
  };
}
