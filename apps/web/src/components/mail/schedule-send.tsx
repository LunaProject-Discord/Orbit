"use client";

import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DatePicker,
  formatDateValue,
  parseDateValue,
} from "@/components/ui/date-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** 予約送信で指定できる日時の上限 (今からの期間)。サーバー側と同じ。 */
export const MAX_SCHEDULE_MS = 366 * 24 * 60 * 60_000;

/** 予約送信の候補 (よく使う日時)。 */
export type SchedulePreset = { label: string; at: Date };

function at(base: Date, days: number, hour: number): Date {
  const date = new Date(base);
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  return date;
}

/**
 * 予約送信の候補。明日の朝 (8 時)、明日の午後 (13 時)、次の月曜日の朝 (8 時)。
 * 明日が月曜日なら、月曜日の朝は「明日の朝」と同じなので出さない。
 */
export function schedulePresets(now = new Date()): SchedulePreset[] {
  const presets: SchedulePreset[] = [
    { label: "明日の朝", at: at(now, 1, 8) },
    { label: "明日の午後", at: at(now, 1, 13) },
  ];
  // 0 = 日曜日。次の月曜日までの日数 (今日が月曜日なら来週)。
  const untilMonday = (8 - now.getDay()) % 7 || 7;
  if (untilMonday > 1) {
    presets.push({ label: "月曜日の朝", at: at(now, untilMonday, 8) });
  }
  return presets;
}

/** 予約できる日時か。できなければ、その理由。 */
export function scheduleProblem(
  date: Date | null,
  now = Date.now(),
): string | null {
  if (!date || Number.isNaN(date.getTime()))
    return "日付と時刻を選んでください。";
  if (date.getTime() <= now + 60_000) return "今より後の日時を選んでください。";
  if (date.getTime() - now > MAX_SCHEDULE_MS) {
    return "予約できるのは 1 年先までです。";
  }
  return null;
}

function timeValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 日付 (YYYY-MM-DD) と時刻 (HH:MM) を、端末の時刻帯の日時にする。 */
export function combineDateTime(day: string, time: string): Date | null {
  const date = parseDateValue(day);
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!date || !match) return null;
  date.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return date;
}

/**
 * 予約送信の日時を選ぶ画面。initial は最初に選んでおく日時 (無ければ明日の朝)。
 */
export function ScheduleDialog({
  open,
  title = "送信日時を指定",
  confirmLabel = "予約する",
  initial,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  title?: string;
  confirmLabel?: string;
  initial?: Date | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (at: Date) => void;
}) {
  const id = useId();
  const [day, setDay] = useState("");
  const [time, setTime] = useState("");
  const [error, setError] = useState<string | null>(null);

  // 開くたびに、最初の日時を選び直す (開いている間に initial が作り直されても選び直さない)。
  const initialRef = useRef(initial);
  initialRef.current = initial;
  useEffect(() => {
    if (!open) return;
    const start = initialRef.current ?? schedulePresets()[0]?.at ?? new Date();
    setDay(formatDateValue(start));
    setTime(timeValue(start));
    setError(null);
  }, [open]);

  const today = new Date();
  const last = new Date(Date.now() + MAX_SCHEDULE_MS);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    const date = combineDateTime(day, time);
    const problem = scheduleProblem(date);
    if (problem || !date) {
      setError(problem);
      return;
    }
    onConfirm(date);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              指定した日時になると、サーバーが送信します。この端末を閉じていても送られます。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-day`}>日付</Label>
              <DatePicker
                id={`${id}-day`}
                aria-label="日付"
                value={day}
                min={formatDateValue(today)}
                max={formatDateValue(last)}
                onChange={(next) => {
                  setDay(next);
                  setError(null);
                }}
                className="w-44"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-time`}>時刻</Label>
              <Input
                id={`${id}-time`}
                type="time"
                required
                value={time}
                onChange={(event) => {
                  setTime(event.target.value);
                  setError(null);
                }}
                className="w-32 tabular-nums"
              />
            </div>
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              キャンセル
            </Button>
            <Button type="submit">{confirmLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
