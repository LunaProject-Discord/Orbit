import type { InviteRole } from "./event-invite.js";
import type { ICalEventData } from "./icalendar-write.js";
import type { ImipPlan } from "./outbox.js";

/**
 * 招待メールの計画 (imip-design 3.2、6.2)。API が予定の変更を受け付けた時点で、
 * 変更前後の予定から「誰に何を送るか」を決める。純粋な関数。
 */

/** 送信数の上限: 利用者ごとの、1 時間の宛先の合計 (REPLY は数えない)。 */
export const IMIP_RECIPIENTS_PER_HOUR = 200;
/** 送信数の上限: 利用者ごとの、1 日の宛先の合計 (REPLY は数えない)。 */
export const IMIP_RECIPIENTS_PER_DAY = 1000;

/** 計画に渡す予定 1 行分 (DB の行と参加者)。 */
export type ImipEvent = ICalEventData & {
  organizer: { email: string; name?: string; self?: boolean } | null;
  attendees: readonly (ICalEventData["attendees"][number] & {
    self: boolean;
  })[];
};

/** 受け付けた操作と、計画を作るのに要る値。 */
export type ImipAccepted = {
  operation: "create" | "update" | "delete" | "respond";
  /** 受け付けた時刻 (DTSTAMP)。 */
  stamp: Date;
  /** 終了済みかの判定に使う「いま」。省けば stamp。 */
  now?: Date;
  /** 浮動時刻のタイムゾーン (カレンダーか利用者のもの)。 */
  defaultTimeZone: string;
};

/** 送信元 (REQUEST / CANCEL は主催者のアカウント、REPLY は自分の ATTENDEE のアカウント)。 */
export type ImipPlanSender = { accountId: string; email: string };

/**
 * 変更前後の予定 (before は作成なら null、after は削除なら null) から計画を作る。
 * 送るものが無ければ null。scheduling が mail かどうかは呼ぶ側が確かめる。
 */
export function planImip(
  _before: ImipEvent | null,
  _after: ImipEvent | null,
  _accepted: ImipAccepted,
  _role: InviteRole,
  _sender: ImipPlanSender | null,
): ImipPlan | null {
  throw new Error("not implemented");
}

/** 送信数の上限に数える宛先の数 (REPLY を除く)。 */
export function imipRecipientCount(plan: ImipPlan | null): number {
  if (!plan) return 0;
  return plan.messages
    .filter((message) => message.method !== "REPLY")
    .reduce((sum, message) => sum + message.to.length, 0);
}
