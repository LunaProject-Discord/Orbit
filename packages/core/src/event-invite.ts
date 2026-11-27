/**
 * 招待と出欠の共通の決まり (段取り 8)。API と Web の両方から使うので、依存を持たない。
 * 設計は calendar-dev/invites-design.md の 3 章と 4 章。
 */

/** 予定に対する自分の役割。 */
export type InviteRole = "organizer" | "attendee" | "none";

/** 自分の出欠の返事。needs_action には戻せない (どのサービスにも取り消しの操作が無い)。 */
export type RsvpStatus = "accepted" | "tentative" | "declined";

/** カレンダーが招待の連絡を送れるか。8b で "mail" (Orbit が iMIP を送る) を足す。 */
export type CalendarScheduling = "server" | "none";

/** 出欠と参加者の変更で API が返すエラーコード。 */
export type InviteErrorCode =
  | "not_attendee"
  | "organizer"
  | "cancelled"
  | "not_organizer"
  | "no_scheduling";

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
