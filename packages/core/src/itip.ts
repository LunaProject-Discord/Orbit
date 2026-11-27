import type { ICalEventData } from "./icalendar-write.js";

/**
 * iTIP (RFC 5546) のメッセージの書き出し。Orbit が送る招待メール (iMIP、RFC 6047) の本体。
 * CalDAV の書き戻し (writeICalendar) と違い、既存のリソースを基にせず、送ってよい項目だけを書く
 * (VALARM、X- や未知のプロパティ、events.raw は書かない)。設計は imip-design.md の 5.1。
 */

/** 8b で扱う iTIP の METHOD。 */
export type ItipMethod = "REQUEST" | "CANCEL" | "REPLY";

export type BuildItipInput = {
  method: ItipMethod;
  /** 原本と、同じ UID の例外。REPLY と 1 回だけの REQUEST / CANCEL は 1 件。 */
  events: readonly ICalEventData[];
  /**
   * VEVENT に書く ATTENDEE を絞る (REPLY は自分だけ、参加者を外す CANCEL は外した人だけ)。
   * 省けば全員。予定の参加者にいないアドレス (外した人) も書く。
   */
  attendees?: readonly string[];
  /** REPLY のコメント。 */
  comment?: string | null;
  /** 積んだ時刻。やり直しても同じ値を使う。 */
  dtstamp: Date;
  /** 浮動時刻と、日付だけの回を読むときのタイムゾーン。 */
  defaultTimeZone: string;
};

/** iTIP のメッセージ (METHOD 付きの VCALENDAR、CRLF 区切り) を作る。 */
export function buildItip(_input: BuildItipInput): string {
  throw new Error("not implemented");
}
