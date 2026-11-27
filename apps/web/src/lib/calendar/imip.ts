import type { Account } from "@/lib/api";
import {
  type Calendar,
  type CalendarEvent,
  calendarScheduling,
} from "@/lib/calendar/api";
import { canSendFrom } from "@/lib/compose";

/**
 * 招待メール (iMIP、段取り 8b) の送信元まわりの、画面で使う判定。
 * 送信元の解決そのものはサーバーが行い (imip-design 4.2)、画面は応答の imipSender を出すだけ。
 */

/** 送信元の判定に使うアカウントの項目 (無い項目は送信できる側に倒す)。 */
export type ImipAccount = Pick<Account, "id" | "email"> &
  Partial<Pick<Account, "protocol" | "smtpHost" | "mailEnabled">>;

const normalize = (email: string) => email.trim().toLowerCase();

/** 招待メールの送信元に選べるアカウント (imip-design 4.1)。並びはそのまま。 */
export function imipSenderAccounts<T extends ImipAccount>(
  accounts: readonly T[],
): T[] {
  return accounts.filter(
    (account) => account.mailEnabled !== false && canSendFrom(account),
  );
}

/**
 * カレンダーの編集に「招待メールの送信元」を出すか (12.2)。Orbit 内のカレンダーと、
 * 招待を自分で送らない CalDAV だけ。項目を返さない古いサーバーでは出さない。
 */
export function imipConfigurable(
  calendar: Pick<
    Calendar,
    "source" | "readOnly" | "scheduling" | "imipAccountId"
  >,
): boolean {
  if (calendar.imipAccountId === undefined || calendar.readOnly) return false;
  if (calendar.source === "local") return true;
  return (
    calendar.source === "caldav" && calendarScheduling(calendar) !== "server"
  );
}

/**
 * 招待を送るときの From (主催者) のアドレス。既にある予定の主催者アドレスがあればそれ
 * (送信元はその予定の ORGANIZER と同じアカウント。4.2)、無ければカレンダーの送信元。
 */
export function inviteSenderAddress(
  calendar: Pick<Calendar, "imipSender"> | null | undefined,
  organizer: CalendarEvent["organizer"] | null | undefined,
): string | null {
  if (organizer?.self !== false && organizer?.email.trim()) {
    return organizer.email.trim();
  }
  return calendar?.imipSender?.email ?? null;
}

/**
 * 受信専用で招待を送れない送信元のアドレス (schedulingBlocked が receive_only のとき)。
 * 利用者が選んだアカウント、無ければカレンダー自身のアカウント。分からなければ null。
 */
export function blockedSenderAddress(
  calendar: Pick<Calendar, "imipAccountId" | "accountId">,
  accounts: readonly Pick<Account, "id" | "email">[] | null | undefined,
): string | null {
  const id = calendar.imipAccountId ?? calendar.accountId;
  return accounts?.find((account) => account.id === id)?.email ?? null;
}

/** 自分の参加者のアドレスと同じ、送信できるアカウント (REPLY の送信元。4.2)。 */
export function replySenderAccount<T extends ImipAccount>(
  selfEmail: string,
  accounts: readonly T[],
): T | null {
  const key = normalize(selfEmail);
  return (
    imipSenderAccounts(accounts).find(
      (account) => normalize(account.email) === key,
    ) ?? null
  );
}
