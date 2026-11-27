import type { ImipPlan } from "@orbit/core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { EventWithExtras } from "./calendar-store.js";
import type * as schema from "./schema.js";

/**
 * 招待メール (iMIP) を outbox (kind = imip_send) に積む (imip-design 6.2)。
 * API (Orbit 内のカレンダー) と worker (CalDAV の書き戻しの成功後) の両方から呼ぶ。
 */

type Executor = Pick<
  NodePgDatabase<typeof schema>,
  "select" | "insert" | "execute"
>;

export type ImipEnqueueContext = {
  userId: string;
  calendarId: string;
  /** 元の操作の対象の予定 (削除では消えた行の ID)。 */
  eventId: string;
  /**
   * 元の操作の冪等キー (eventCreateKey / eventUpdateKey / eventDeleteKey / eventRespondKey)。
   * imip_send のキーは imipSendKey(baseKey, METHOD, 通し番号)。
   */
  baseKey: string;
  /** 浮動時刻のタイムゾーン (buildItip の defaultTimeZone)。 */
  defaultTimeZone: string;
};

export type ImipEnqueueResult = {
  /** 積んだ imip_send の行の数 (積み済みで増えなかった分は数えない)。 */
  enqueued: number;
  /**
   * 積まなかった理由。not_mail = カレンダーを読み直したら scheduling が mail でない。
   * sender_unavailable = 計画の送信元が無い・送信できない。
   */
  skipped: "not_mail" | "sender_unavailable" | null;
};

/**
 * 計画 (plan) の各メッセージを、宛先 50 件ごとの imip_send にして積む。トランザクションの中で呼ぶ。
 * 1. カレンダーを読み直し、calendarScheduling(…, imipSender: 計画の送信元が送信できるか) が mail か確かめる。
 * 2. content の無いメッセージは eventRows (原本と例外、または対象の行) から buildItip で本文を作る。
 * 3. 宛先を IMIP_RECIPIENTS_PER_MESSAGE 件ごとに分けて積む (冪等キーは imipSendKey)。
 * 4. pg_notify(CHANNEL_OUTBOX, 送信元の accountId) を打つ (コミット時に届く)。
 */
export async function enqueueImip(
  _tx: Executor,
  _plan: ImipPlan,
  _eventRows: readonly EventWithExtras[],
  _context: ImipEnqueueContext,
): Promise<ImipEnqueueResult> {
  throw new Error("not implemented");
}
