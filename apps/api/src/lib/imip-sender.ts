import { isSendableAccount } from "@orbit/core";
import {
  accounts,
  type calendars,
  type Database,
  resolveCalendarImipSender,
} from "@orbit/db";
import { asc, eq } from "drizzle-orm";
import { ownAddresses } from "./calendar-identity.js";

/**
 * 招待メール (iMIP) の送信元のメールアカウントを決める (imip-design 4 章)。
 * 送信できるかの判定は @orbit/core の isSendableAccount (4.1)。
 */

type Executor = Pick<Database, "select">;
type CalendarRow = typeof calendars.$inferSelect;

/** 決まった送信元。email は From と、新しい予定の ORGANIZER に使う。 */
export type ImipSender = {
  accountId: string;
  email: string;
  displayName: string | null;
};

/** 送信元の解決の結果。決まらなければ理由 (scheduling が none になる理由) を返す。 */
export type ImipSenderResolution =
  | { sender: ImipSender; blocked: null }
  | { sender: null; blocked: "no_sender" | "receive_only" };

/** 送信元の候補にするアカウントの値 (サイドバーの並び順に並べたもの)。 */
export type SenderAccount = {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
  mailEnabled: boolean;
  protocol: string;
  smtpHost: string | null;
  status: string;
};

/** 利用者のアカウントを、サイドバーの並び順 (sortOrder → 作った順) で読む。 */
export async function loadSenderAccounts(
  db: Executor,
  userId: string,
): Promise<SenderAccount[]> {
  return db
    .select({
      id: accounts.id,
      email: accounts.email,
      username: accounts.username,
      displayName: accounts.displayName,
      mailEnabled: accounts.mailEnabled,
      protocol: accounts.protocol,
      smtpHost: accounts.smtpHost,
      status: accounts.status,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .orderBy(
      asc(accounts.sortOrder),
      asc(accounts.createdAt),
      asc(accounts.id),
    );
}

const toSender = (account: SenderAccount): ImipSender => ({
  accountId: account.id,
  email: account.email,
  displayName: account.displayName,
});

/**
 * resolveImipSender の中身 (アカウントを読み済みのとき。カレンダーの一覧で 1 回だけ読むため)。
 * list はその利用者のアカウントをサイドバーの並び順に並べたもの。
 */
export function pickImipSender(
  list: readonly SenderAccount[],
  calendar: Pick<CalendarRow, "accountId" | "imipAccountId">,
): ImipSenderResolution {
  // 1. 利用者が選んだ送信元。受信専用になっていれば、黙って別のアドレスから送らない。
  if (calendar.imipAccountId) {
    const chosen = list.find(
      (account) => account.id === calendar.imipAccountId,
    );
    if (chosen) {
      return isSendableAccount(chosen)
        ? { sender: toSender(chosen), blocked: null }
        : { sender: null, blocked: "receive_only" };
    }
  }
  // 2・3. カレンダーのアカウント自身と、同じアドレスの別のアカウント。当たるのが受信専用だけ
  // (メールを使うカレンダーのアカウント、または同じアドレスのアカウントがある) なら receive_only。
  // worker と判定をそろえるため、@orbit/db の resolveCalendarImipSender と同じ順に調べる。
  const own = calendar.accountId
    ? list.find((account) => account.id === calendar.accountId)
    : undefined;
  if (own) {
    if (isSendableAccount(own)) return { sender: toSender(own), blocked: null };
    const addresses = ownAddresses(own);
    const same = list.filter(
      (account) =>
        account.id !== own.id &&
        [...ownAddresses(account)].some((address) => addresses.has(address)),
    );
    const match = same.find(isSendableAccount);
    if (match) return { sender: toSender(match), blocked: null };
    if (same.length > 0 || own.mailEnabled) {
      return { sender: null, blocked: "receive_only" };
    }
  }
  // 4・5. 送信できるアカウントのうち、並び順の先頭 (1 つだけならそれ)。
  const first = list.find(isSendableAccount);
  if (first) return { sender: toSender(first), blocked: null };
  // 6. 1 つも無い。
  return { sender: null, blocked: "no_sender" };
}

/**
 * カレンダーの送信元 (4.2 の「カレンダーの送信元」。上から順):
 * 1. calendars.imipAccountId が送信できる → それ (受信専用なら receive_only。ほかへ進まない)
 * 2. カレンダーの accountId のアカウント自身が送信できる → それ
 * 3. カレンダーのアカウントと同じアドレス (ownAddresses) の、送信できる別のアカウント → それ
 *    (2・3 で当たるのが受信専用だけなら receive_only)
 * 4. 利用者の送信できるアカウントが 1 つだけ → それ
 * 5. 2 つ以上 → サイドバーの並び順の先頭
 * 6. 1 つも無い → no_sender
 * local と CalDAV 以外のカレンダーでも呼べるが、scheduling には使わない。
 */
export async function resolveImipSender(
  db: Executor,
  calendar: Pick<CalendarRow, "userId" | "accountId" | "imipAccountId">,
): Promise<ImipSenderResolution> {
  // worker と同じ関数で決める (pickImipSender は一覧で何度も使うための同じ判定)。
  return resolveCalendarImipSender(db, calendar);
}

/** resolveImipSenderForAddress の中身 (アカウントを読み済みのとき)。 */
export function pickImipSenderForAddress(
  list: readonly SenderAccount[],
  address: string,
  calendar?: Pick<CalendarRow, "accountId" | "imipAccountId"> | null,
): ImipSender | null {
  const key = address.trim().toLowerCase();
  const matches = list.filter(
    (account) =>
      account.email.trim().toLowerCase() === key && isSendableAccount(account),
  );
  const preferred =
    matches.find((account) => account.id === calendar?.imipAccountId) ??
    matches.find((account) => account.id === calendar?.accountId) ??
    matches[0];
  return preferred ? toSender(preferred) : null;
}

/**
 * アドレスが決まっている役の送信元 (4.2 の表): REPLY は self の ATTENDEE のアドレス、
 * 既にある予定の REQUEST / CANCEL は events.organizer.email と同じ email の、送信できるアカウント。
 * 複数あれば calendar の imipAccountId → accountId → サイドバーの並び順。無ければ null。
 */
export async function resolveImipSenderForAddress(
  db: Executor,
  userId: string,
  address: string,
  calendar?: Pick<CalendarRow, "accountId" | "imipAccountId"> | null,
): Promise<ImipSender | null> {
  return pickImipSenderForAddress(
    await loadSenderAccounts(db, userId),
    address,
    calendar,
  );
}
