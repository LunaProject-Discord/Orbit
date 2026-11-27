"use client";

import { PlusIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { reminderLabel } from "@/components/calendar/event-detail";
import { REMINDER_MINUTES } from "@/components/calendar/event-editor";
import { SimpleSelect } from "@/components/calendar/simple-select";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import type { Calendar, Reminder } from "@/lib/calendar/api";

/** 既定の通知の数の上限 (予定ごとの通知と同じ)。 */
const MAX_DEFAULT_REMINDERS = 5;

/**
 * カレンダーの「既定の通知」(段取り 9、設計 10 章)。相手側に既定を持たない
 * カレンダー (Orbit 内・CalDAV・購読) だけで開く。終日の予定には使わない (設計 2.1)。
 */
export function DefaultRemindersDialog({
  calendar,
  busy,
  error,
  onSave,
  onClose,
}: {
  /** 設定するカレンダー。null なら閉じている。 */
  calendar: Calendar | null;
  busy: boolean;
  error: string | null;
  onSave: (reminders: Reminder[]) => void;
  onClose: () => void;
}) {
  const [list, setList] = useState<Reminder[]>([]);
  const calendarId = calendar?.id;
  const saved = calendar?.defaultReminders;
  useEffect(() => {
    if (calendarId) setList(saved ?? []);
  }, [calendarId, saved]);
  const options = (minutes: number) => {
    const base = REMINDER_MINUTES.map((value) => ({
      value: String(value),
      label: reminderLabel({ method: "display", minutes: value }),
    }));
    return REMINDER_MINUTES.includes(minutes)
      ? base
      : [
          ...base,
          {
            value: String(minutes),
            label: reminderLabel({ method: "display", minutes }),
          },
        ];
  };
  return (
    <Dialog
      open={calendar !== null}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      {/* 入力するフォームなので、スマホ幅でも中央のダイアログにする (Mail のフォームと同じ)。 */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-4 overflow-y-auto sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>既定の通知</DialogTitle>
          <DialogDescription>
            このカレンダーの時刻のある予定のうち、「カレンダーの既定の通知を使う」にしている予定に使います。終日の予定は、設定の「終日の予定の通知」に従います。
          </DialogDescription>
        </DialogHeader>
        {calendar && (
          <form
            id="default-reminders-form"
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) onSave(list);
            }}
          >
            <p className="truncate text-muted-foreground text-sm">
              {calendar.name}
            </p>
            {list.length === 0 && <p className="text-sm">通知しません。</p>}
            {list.map((reminder, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: 同じ時刻の通知も並べられる
                key={index}
                className="flex items-center gap-1"
              >
                <SimpleSelect
                  label="通知"
                  value={String(reminder.minutes)}
                  options={options(reminder.minutes)}
                  onChange={(value) =>
                    setList((current) =>
                      current.map((item, i) =>
                        i === index
                          ? { ...item, minutes: Number(value) }
                          : item,
                      ),
                    )
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="通知を削除"
                  onClick={() =>
                    setList((current) => current.filter((_, i) => i !== index))
                  }
                >
                  <XIcon />
                </Button>
              </div>
            ))}
            {list.length < MAX_DEFAULT_REMINDERS && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start text-muted-foreground"
                onClick={() =>
                  setList((current) => [
                    ...current,
                    { method: "display", minutes: 10 },
                  ])
                }
              >
                <PlusIcon />
                通知を追加
              </Button>
            )}
            {error && <p className="text-destructive text-sm">{error}</p>}
          </form>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          <Button type="submit" form="default-reminders-form" disabled={busy}>
            {busy && <Spinner />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
