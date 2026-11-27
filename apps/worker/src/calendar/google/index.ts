import type { CalendarProvider, CalendarProviderDeps } from "../provider.js";
import { notImplementedProvider } from "../stub.js";

/**
 * Google Calendar API のプロバイダ (担当 4)。雛形なので、全メソッドが
 * CalendarNotImplementedError を投げる。このディレクトリの中だけで実装する。
 * 実装するときの約束 (詳しくは provider.ts):
 * - createEvent は events.insert の id に events.id から作った値 (base32hex) を入れて冪等にする。
 *   409 duplicate は、その予定を取り直して ok を返すか、{ status: "conflict", remoteId } を返す。
 * - 例外 (recurringEventId がある予定。取り消された回は iCalUID が無いことがある) は uid を
 *   省いてよい。土台が parentRemoteId (recurringEventId) の原本から補う。
 *   原本の uid が要るときは cursor.knownEvents() で引ける。
 * - 429 と 5xx は、Retry-After があれば CalendarTransientError({ retryAfterMs }) を投げる。
 * - stopPush は、pushChannelId のあるカレンダーにだけ呼ばれる (resourceId は providerState に残す)。
 */
export function createGoogleProvider(
  deps: CalendarProviderDeps = {},
): CalendarProvider {
  return notImplementedProvider("google", deps.defaultPollSeconds ?? 900);
}
