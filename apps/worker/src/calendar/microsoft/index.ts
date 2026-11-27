import type { CalendarProvider, CalendarProviderDeps } from "../provider.js";
import { notImplementedProvider } from "../stub.js";

/**
 * Microsoft Graph の予定のプロバイダ (担当 5)。雛形なので、全メソッドが
 * CalendarNotImplementedError を投げる。このディレクトリの中だけで実装する。
 */
export function createMicrosoftProvider(
  deps: CalendarProviderDeps = {},
): CalendarProvider {
  return notImplementedProvider("microsoft", deps.defaultPollSeconds ?? 900);
}
