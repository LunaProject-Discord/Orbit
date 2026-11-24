import { MAX_NOTIFICATION_ACTIONS, NOTIFICATION_ACTIONS } from "@orbit/core";
import type { DateFormatSettings, SwipeSettings } from "@orbit/db";
import { z } from "zod";

/** 一覧の行をスワイプしたときに選べる操作。 */
export const SWIPE_ACTIONS = [
  "none",
  "toggle_read",
  "star",
  "archive",
  "delete",
  "junk",
  "move",
] as const;

const swipeAction = z.enum(SWIPE_ACTIONS);

/** 左へスワイプしたときと、右へスワイプしたときの操作。 */
export const swipeSettings = z.object({
  left: swipeAction,
  right: swipeAction,
});

/** 何も保存していない利用者の設定。左で削除、右で既読 / 未読の切り替え。 */
export const DEFAULT_SWIPE: SwipeSettings = {
  left: "delete",
  right: "toggle_read",
};

/**
 * 保存してあった設定を読む。形の合わない値 (後から無くなった操作など) は、
 * その向きだけ標準の値にする。
 */
export function readSwipe(saved: unknown): SwipeSettings {
  const record =
    typeof saved === "object" && saved !== null
      ? (saved as Record<string, unknown>)
      : {};
  const left = swipeAction.safeParse(record.left);
  const right = swipeAction.safeParse(record.right);
  return {
    left: left.success ? left.data : DEFAULT_SWIPE.left,
    right: right.success ? right.data : DEFAULT_SWIPE.right,
  };
}

/**
 * 新着メールの通知に付けるボタン。出す順に並べる (重複は不可)。
 * 空の配列は、ボタンを付けない。
 */
export const notificationActionSettings = z.object({
  actions: z
    .array(z.enum(NOTIFICATION_ACTIONS))
    .max(MAX_NOTIFICATION_ACTIONS)
    .refine((actions) => new Set(actions).size === actions.length),
});

/** 日時の書式に使える文字数の上限。 */
export const DATE_FORMAT_MAX_LENGTH = 64;

const dateFormatString = z
  .string()
  .max(DATE_FORMAT_MAX_LENGTH)
  .refine((value) => value.trim().length > 0);

/** 日付と時刻の形式。書式の中身 (記号の意味) は画面側で解釈する。 */
export const dateFormatSettings = z.object({
  listDate: z.enum(["auto", "datetime"]),
  shortDateFormat: dateFormatString,
  monthDayFormat: dateFormatString,
  longDateFormat: dateFormatString,
  shortTimeFormat: dateFormatString,
  longTimeFormat: dateFormatString,
});

/** 保存してあった日時の形式を読む。保存していない (または形が合わない) なら null。 */
export function readDateFormat(saved: unknown): DateFormatSettings | null {
  const result = dateFormatSettings.safeParse(saved);
  return result.success ? result.data : null;
}
