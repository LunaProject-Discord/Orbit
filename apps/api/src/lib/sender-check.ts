import {
  type AuthResults,
  SENDER_CHECK_VERSION,
  type SenderCheck,
} from "@orbit/core";
import { type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * 保存済みの送信元の確認結果 (messages.sender_check) を、いまの決まりで作ったものだけ返す。
 *
 * 信頼する判定サーバー (authserv-id) との照合を入れる前に保存した結果は、差出人が書いた偽の
 * Authentication-Results を拾っていたかもしれないので使わない (docs/sender-auth.md)。
 * 古い結果は null (= まだ確認していない) として返し、端末が開いたときや一覧に見えたときに
 * 取り直しを頼む (POST /v1/messages/prefetch、詳細の取得)。
 */
export function currentSenderCheck(
  senderCheck: AnyPgColumn,
): SQL<SenderCheck | null> {
  return sql<SenderCheck | null>`case when ${senderCheck}->>'version' = ${String(SENDER_CHECK_VERSION)} then ${senderCheck} else null end`;
}

/** currentSenderCheck と同じ条件で、認証結果 (messages.auth_results) も古いものは返さない。 */
export function currentAuthResults(
  authResults: AnyPgColumn,
  senderCheck: AnyPgColumn,
): SQL<AuthResults | null> {
  return sql<AuthResults | null>`case when ${senderCheck}->>'version' = ${String(SENDER_CHECK_VERSION)} then ${authResults} else null end`;
}

/** 確認結果が無いか古いメール (取り直しを頼む対象)。 */
export function senderCheckStale(senderCheck: AnyPgColumn): SQL {
  return sql`(${senderCheck}->>'version') is distinct from ${String(SENDER_CHECK_VERSION)}`;
}
