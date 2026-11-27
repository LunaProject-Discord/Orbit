import type { CalendarProvider, CalendarProviderDeps } from "../provider.js";
import { notImplementedProvider } from "../stub.js";

/**
 * CalDAV (iCloud と一般の CalDAV サーバー) のプロバイダ (担当 6)。雛形なので、全メソッドが
 * CalendarNotImplementedError を投げる。このディレクトリの中だけで実装する。
 */
export function createCaldavProvider(
  deps: CalendarProviderDeps = {},
): CalendarProvider {
  return notImplementedProvider("caldav", deps.defaultPollSeconds ?? 300);
}
