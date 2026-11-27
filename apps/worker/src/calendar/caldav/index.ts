import type { CalendarProvider, CalendarProviderDeps } from "../provider.js";
import { notImplementedProvider } from "../stub.js";

/**
 * CalDAV (iCloud と一般の CalDAV サーバー) のプロバイダ (担当 6)。雛形なので、全メソッドが
 * CalendarNotImplementedError を投げる。このディレクトリの中だけで実装する。
 * 実装するときの約束 (詳しくは provider.ts):
 * - createEvent は href と UID を events.id から決め、PUT に If-None-Match: * を付ける。
 *   412 は、その href を取り直して ok を返すか、{ status: "conflict", remoteId: href } を返す。
 * - 1 つのリソース (href) の原本と例外は、必ず同じページにまとめて返す。土台は、届いた href の
 *   既存の行のうち今回届かなかった回を「リソースから消えた」として消す (書き戻し待ちは残す)。
 * - 429 と 503 は、Retry-After があれば CalendarTransientError({ retryAfterMs }) を投げる。
 */
export function createCaldavProvider(
  deps: CalendarProviderDeps = {},
): CalendarProvider {
  return notImplementedProvider("caldav", deps.defaultPollSeconds ?? 300);
}
