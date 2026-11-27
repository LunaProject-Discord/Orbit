import { isSendableAccount } from "@orbit/core";
import {
  type calendars,
  type Database,
  type ImipSenderCandidate,
  loadImipSenderCandidates,
  pickCalendarImipSender,
  resolveCalendarImipSender,
} from "@orbit/db";

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
export type SenderAccount = ImipSenderCandidate;

/** 利用者のアカウントを、サイドバーの並び順 (sortOrder → 作った順) で読む。 */
export const loadSenderAccounts: (
  db: Executor,
  userId: string,
) => Promise<SenderAccount[]> = loadImipSenderCandidates;

const toSender = (account: SenderAccount): ImipSender => ({
  accountId: account.id,
  email: account.email,
  displayName: account.displayName,
});

/**
 * カレンダーの送信元 (4.2 の「カレンダーの送信元」) を、読み済みのアカウントの一覧から決める。
 * 判定は @orbit/db の pickCalendarImipSender 1 つにまとめてある (worker の self の判定と
 * ずれないように。imip レビュー L11)。
 */
export function pickImipSender(
  list: readonly SenderAccount[],
  calendar: Pick<CalendarRow, "accountId" | "imipAccountId">,
): ImipSenderResolution {
  return pickCalendarImipSender(list, calendar);
}

/** カレンダーの送信元を、利用者のアカウントを読んで決める (@orbit/db の resolveCalendarImipSender)。 */
export async function resolveImipSender(
  db: Executor,
  calendar: Pick<CalendarRow, "userId" | "accountId" | "imipAccountId">,
): Promise<ImipSenderResolution> {
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
