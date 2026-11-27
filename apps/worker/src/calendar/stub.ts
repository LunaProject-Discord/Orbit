import {
  CalendarNotImplementedError,
  type CalendarProvider,
  type ProviderSource,
} from "./provider.js";

/**
 * 全メソッドが CalendarNotImplementedError を投げるプロバイダ。各担当が実装するまでの雛形に使う。
 * 担当は自分の index.ts でこれを使うのをやめ、本物の実装に置き換える。
 */
export function notImplementedProvider(
  source: ProviderSource,
  defaultPollSeconds: number,
): CalendarProvider {
  const fail = async (): Promise<never> => {
    throw new CalendarNotImplementedError();
  };
  return {
    source,
    defaultPollSeconds,
    listCalendars: fail,
    syncEvents: fail,
    getEvent: fail,
    parseRaw: () => {
      throw new CalendarNotImplementedError();
    },
    createEvent: fail,
    updateEvent: fail,
    deleteEvent: fail,
    respond: fail,
  };
}
