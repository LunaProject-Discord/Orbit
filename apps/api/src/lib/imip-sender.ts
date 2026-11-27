import type { calendars, Database } from "@orbit/db";

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
  _db: Executor,
  _calendar: Pick<CalendarRow, "userId" | "accountId" | "imipAccountId">,
): Promise<ImipSenderResolution> {
  throw new Error("not implemented");
}

/**
 * アドレスが決まっている役の送信元 (4.2 の表): REPLY は self の ATTENDEE のアドレス、
 * 既にある予定の REQUEST / CANCEL は events.organizer.email と同じ email の、送信できるアカウント。
 * 複数あれば calendar の imipAccountId → accountId → サイドバーの並び順。無ければ null。
 */
export async function resolveImipSenderForAddress(
  _db: Executor,
  _userId: string,
  _address: string,
  _calendar?: Pick<CalendarRow, "accountId" | "imipAccountId"> | null,
): Promise<ImipSender | null> {
  throw new Error("not implemented");
}
