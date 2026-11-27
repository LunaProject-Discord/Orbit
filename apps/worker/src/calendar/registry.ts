import { createCaldavProvider } from "./caldav/index.js";
import { createGoogleProvider } from "./google/index.js";
import { createMicrosoftProvider } from "./microsoft/index.js";
import type {
  AccountRow,
  CalendarProvider,
  CalendarProviderDeps,
} from "./provider.js";

/**
 * アカウントに合うカレンダーのプロバイダを返す。対応していなければ null
 * (土台が accounts.calendarError に「未対応」と書く)。
 * - Gmail の OAuth2 → Google
 * - Microsoft Graph → Microsoft
 * - iCloud、または CalDAV の URL があるアカウント → CalDAV
 */
export function calendarProviderFor(
  account: Pick<AccountRow, "provider" | "authType" | "protocol" | "caldavUrl">,
  deps: CalendarProviderDeps = {},
): CalendarProvider | null {
  if (account.provider === "gmail" && account.authType === "oauth2") {
    return createGoogleProvider(deps);
  }
  if (account.protocol === "graph") return createMicrosoftProvider(deps);
  if (account.provider === "icloud" || account.caldavUrl) {
    return createCaldavProvider(deps);
  }
  return null;
}
