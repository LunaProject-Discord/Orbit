import type { CalendarProvider, CalendarProviderDeps } from "../provider.js";
import { notImplementedProvider } from "../stub.js";

/**
 * Microsoft Graph の予定のプロバイダ (担当 5)。雛形なので、全メソッドが
 * CalendarNotImplementedError を投げる。このディレクトリの中だけで実装する。
 * 実装するときの約束 (詳しくは provider.ts):
 * - createEvent は transactionId に events.id を入れて冪等にする (既にあれば、その予定を ok で返す)。
 *   iCalUId は付け替わってよい (ok の uid を新しい値にすれば、土台が行の uid を直す)。
 * - 例外 (seriesMasterId がある予定。回ごとに iCalUId が違うことがある) は uid を省いてよい。
 *   土台が parentRemoteId (seriesMasterId) の原本から補う。cursor.knownEvents() でも引ける。
 * - 429 と 503 は、Retry-After があれば CalendarTransientError({ retryAfterMs }) を投げる。
 * - stopPush は、pushChannelId のあるカレンダーにだけ呼ばれる。
 */
export function createMicrosoftProvider(
  deps: CalendarProviderDeps = {},
): CalendarProvider {
  return notImplementedProvider("microsoft", deps.defaultPollSeconds ?? 900);
}
