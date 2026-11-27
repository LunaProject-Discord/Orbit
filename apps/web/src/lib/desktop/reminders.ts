import type { ReminderBridge } from "@/lib/calendar/notifications/bridge";

/**
 * Desktop (Tauri) の予定のリマインダーの橋。
 * 仮置き (段取り 9 の作業 D1): 本物は作業 E が同じ名前で置き換える。それまでは予約できない (none)。
 */
export function createDesktopReminderBridge(): ReminderBridge {
  return {
    capabilities: async () => ({ schedule: "none", exact: false }),
    replaceAll: async () => {},
    clear: async () => {},
  };
}
