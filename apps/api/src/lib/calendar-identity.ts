import { accounts, calendars, type Database } from "@orbit/db";
import { eq, inArray } from "drizzle-orm";
import { loadSenderAccounts, pickImipSender } from "./imip-sender.js";

/**
 * カレンダーの「自分」の判定 (calendars.ts と message-invite.ts で使う)。
 * 出欠の返事を許すのは、self の行が自分 (アカウント) を指しているときだけ (レビュー 3)。
 */

type Executor = Pick<Database, "select">;
type CalendarRow = typeof calendars.$inferSelect;

/** アカウントの自分のアドレス (email と、@ を含む username)。小文字。 */
export function ownAddresses(account: {
  email: string;
  username: string;
}): Set<string> {
  return new Set(
    [account.email, account.username]
      .filter((value) => value.includes("@"))
      .map((value) => value.trim().toLowerCase()),
  );
}

/**
 * そのカレンダーの self の行を「アカウントの持ち主」とみなしてよいか (レビュー 3)。
 * Google の共有カレンダーでは attendees[].self が「そのカレンダーの持ち主」を指すので、
 * 同僚のカレンダーの self は同僚になる。自分のもの (Orbit 内のカレンダー、primary、
 * accessRole が owner) だけを無条件に認め、ほかは self の行のアドレスで決める。
 */
export function ownsCalendar(
  calendar: Pick<CalendarRow, "accountId" | "providerState">,
): boolean {
  if (calendar.accountId === null) return true;
  const state = calendar.providerState ?? {};
  return state.primary === true || state.accessRole === "owner";
}

/** カレンダーごとの、自分のアドレスと、自分のカレンダーか。 */
export type CalendarIdentity = {
  /**
   * 自分のアドレス: カレンダーのアカウントのアドレスと、招待メールの送信元のアドレス
   * (Orbit 内と CalDAV のカレンダー。imip-design 4.4)、Orbit 内と自動スケジュールでない CalDAV
   * では利用者の全アカウントのアドレス (M7)。どれも無ければ undefined。
   */
  addresses: ReadonlySet<string> | undefined;
  owned: boolean;
};

/** 招待メールの送信元を「自分」に数えるカレンダー (Orbit が招待を送りうるもの)。 */
const SENDER_SOURCES = new Set(["local", "caldav"]);

export async function calendarIdentities(
  db: Executor,
  calendarIds: string[],
): Promise<Map<string, CalendarIdentity>> {
  const map = new Map<string, CalendarIdentity>();
  if (calendarIds.length === 0) return map;
  const rows = await db
    .select({
      calendarId: calendars.id,
      userId: calendars.userId,
      source: calendars.source,
      accountId: calendars.accountId,
      imipAccountId: calendars.imipAccountId,
      providerState: calendars.providerState,
      email: accounts.email,
      username: accounts.username,
    })
    .from(calendars)
    .leftJoin(accounts, eq(accounts.id, calendars.accountId))
    .where(inArray(calendars.id, [...new Set(calendarIds)]));
  const senderAccounts = new Map(
    await Promise.all(
      [
        ...new Set(
          rows
            .filter((row) => SENDER_SOURCES.has(row.source))
            .map((row) => row.userId),
        ),
      ].map(
        async (userId) =>
          [userId, await loadSenderAccounts(db, userId)] as const,
      ),
    ),
  );
  for (const row of rows) {
    const addresses =
      row.email !== null && row.username !== null
        ? ownAddresses({ email: row.email, username: row.username })
        : new Set<string>();
    const list = senderAccounts.get(row.userId);
    if (list && SENDER_SOURCES.has(row.source)) {
      const { sender } = pickImipSender(list, row);
      if (sender) addresses.add(sender.email.trim().toLowerCase());
      // 利用者の全アカウントのアドレスも自分に数える (送信元を変えた後も、前の送信元で
      // 主催した予定を自分の予定として扱う。imip レビュー M7)。自動スケジュールの CalDAV は
      // worker の取り込みと同じく足さない。
      if (row.providerState?.autoSchedule !== true) {
        for (const account of list) {
          for (const address of ownAddresses(account)) addresses.add(address);
        }
      }
    }
    map.set(row.calendarId, {
      addresses: addresses.size > 0 ? addresses : undefined,
      owned: ownsCalendar(row),
    });
  }
  return map;
}

/**
 * self の行が自分 (アカウント) を指しているか。自分のカレンダーなら常に true、
 * 共有カレンダーなら self の行のアドレスがアカウントのアドレスと同じときだけ。
 */
export function selfIsMe(
  attendees: readonly { email: string; self: boolean }[],
  identity: CalendarIdentity | undefined,
): boolean {
  if (identity?.owned) return true;
  const me = attendees.find((attendee) => attendee.self);
  if (!me) return false;
  return identity?.addresses?.has(me.email.trim().toLowerCase()) ?? false;
}
