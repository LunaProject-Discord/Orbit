import type { CalendarProvider, CalendarProviderDeps } from "../provider.js";
import { notImplementedProvider } from "../stub.js";

/**
 * Google Calendar API のプロバイダ (担当 4)。雛形なので、全メソッドが
 * CalendarNotImplementedError を投げる。このディレクトリの中だけで実装する。
 */
export function createGoogleProvider(
  deps: CalendarProviderDeps = {},
): CalendarProvider {
  return notImplementedProvider("google", deps.defaultPollSeconds ?? 900);
}
