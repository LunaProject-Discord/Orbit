import { accounts, calendars, type Database } from "@orbit/db";
import { eq, inArray } from "drizzle-orm";

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
  /** アカウントの自分のアドレス。アカウントの無いカレンダーは undefined。 */
  addresses: ReadonlySet<string> | undefined;
  owned: boolean;
};

export async function calendarIdentities(
  db: Executor,
  calendarIds: string[],
): Promise<Map<string, CalendarIdentity>> {
  const map = new Map<string, CalendarIdentity>();
  if (calendarIds.length === 0) return map;
  const rows = await db
    .select({
      calendarId: calendars.id,
      accountId: calendars.accountId,
      providerState: calendars.providerState,
      email: accounts.email,
      username: accounts.username,
    })
    .from(calendars)
    .leftJoin(accounts, eq(accounts.id, calendars.accountId))
    .where(inArray(calendars.id, [...new Set(calendarIds)]));
  for (const row of rows) {
    map.set(row.calendarId, {
      addresses:
        row.email !== null && row.username !== null
          ? ownAddresses({ email: row.email, username: row.username })
          : undefined,
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
