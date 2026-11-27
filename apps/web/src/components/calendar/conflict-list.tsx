"use client";

import { cn } from "cn";
import { ArrowRightIcon, CircleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import type { Calendar, CalendarEvent } from "@/lib/calendar/api";
import {
  conflictActionLabel,
  conflictMessage,
  conflictReason,
  conflictWhen,
  displayFields,
  FIELD_LABELS,
  fieldValueLabel,
} from "@/lib/calendar/conflict-labels";
import type { ConflictAction, ConflictItem } from "@/lib/calendar/offline";

/** 押している途中のボタン (競合の ID と操作)。 */
export type ConflictBusy = { id: string; action: ConflictAction } | null;

/**
 * ヘッダーに出す「反映されなかった変更 N」。0 件なら出さない。
 * 狭い画面では印と件数だけにする。
 */
export function ConflictsButton({
  count,
  compact,
  onClick,
}: {
  count: number;
  compact: boolean;
  onClick: () => void;
}) {
  if (count === 0) return null;
  const label = `反映されなかった変更 ${count} 件`;
  if (compact) {
    return (
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        className="relative"
        onClick={onClick}
      >
        <CircleAlertIcon className="size-5 text-amber-600 dark:text-amber-500" />
        <span className="absolute top-1 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 font-semibold text-[10px] text-white tabular-nums dark:bg-amber-600">
          {count}
        </span>
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      className="shrink-0 text-muted-foreground"
      onClick={onClick}
    >
      <CircleAlertIcon className="text-amber-600 dark:text-amber-500" />
      反映されなかった変更
      <span className="rounded-full bg-amber-500/15 px-1.5 font-semibold text-amber-700 text-xs tabular-nums dark:text-amber-400">
        {count}
      </span>
    </Button>
  );
}

function ConflictRow({
  item,
  calendar,
  color,
  current,
  timeZone,
  busy,
  disabled,
  onAction,
}: {
  item: ConflictItem;
  calendar: Calendar | undefined;
  color: string | null;
  current: CalendarEvent | undefined;
  timeZone: string;
  busy: ConflictAction | null;
  disabled: boolean;
  onAction: (action: ConflictAction) => void;
}) {
  const when = conflictWhen(item, current, timeZone);
  const reason = conflictReason(item);
  const fields = displayFields(item.fields).filter(
    (field) => fieldValueLabel(field, item.lost, timeZone) !== null,
  );
  // 「閉じる」は最後に、控えめに出す。
  const actions = [
    ...item.actions.filter((action) => action !== "dismiss"),
    ...item.actions.filter((action) => action === "dismiss"),
  ];
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className="mt-1.5 size-2.5 shrink-0 rounded-sm bg-muted-foreground/40"
          style={color ? { background: color } : undefined}
        />
        <div className="min-w-0 flex-1">
          <p className="break-words leading-snug">
            {conflictMessage(item, calendar)}
          </p>
          {(when || reason) && (
            <p className="mt-0.5 text-muted-foreground text-xs">
              {[when, reason].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
      </div>
      {fields.length > 0 && (
        <dl className="ml-5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md bg-muted/60 px-3 py-2 text-xs">
          {fields.map((field) => {
            const lost = fieldValueLabel(field, item.lost, timeZone);
            const kept = fieldValueLabel(field, item.kept, timeZone);
            return (
              <div key={field} className="contents">
                <dt className="text-muted-foreground">{FIELD_LABELS[field]}</dt>
                <dd className="flex min-w-0 flex-wrap items-center gap-x-1.5">
                  <span className="break-all">
                    <span className="sr-only">自分の値: </span>
                    {lost}
                  </span>
                  {kept !== null && kept !== lost && (
                    <>
                      <ArrowRightIcon
                        aria-hidden="true"
                        className="size-3 shrink-0 text-muted-foreground"
                      />
                      <span className="break-all text-muted-foreground">
                        <span className="sr-only">採用された値: </span>
                        {kept}
                      </span>
                    </>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      <div className="ml-5 flex flex-wrap gap-2">
        {actions.map((action) => (
          <Button
            key={action}
            variant={action === "dismiss" ? "ghost" : "outline"}
            size="sm"
            disabled={disabled}
            className={cn(action === "dismiss" && "text-muted-foreground")}
            onClick={() => onAction(action)}
          >
            {busy === action && <Spinner />}
            {conflictActionLabel(item, action)}
          </Button>
        ))}
      </div>
    </li>
  );
}

/**
 * 反映されなかった変更の一覧。広い画面ではダイアログ、狭い画面では下からのシート。
 * 1 行に、予定の題名と日付、項目名、自分の値 → 採用された値、操作のボタンを並べる。
 */
export function ConflictList({
  open,
  items,
  calendarOf,
  colorOf,
  eventOf,
  timeZone,
  busy,
  onAction,
  onClose,
}: {
  open: boolean;
  items: ConflictItem[];
  calendarOf: (id: string | null) => Calendar | undefined;
  colorOf: (calendar: Calendar) => string;
  eventOf: (id: string | null) => CalendarEvent | undefined;
  timeZone: string;
  busy: ConflictBusy;
  onAction: (item: ConflictItem, action: ConflictAction) => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent sheet className="flex flex-col gap-4 sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>反映されなかった変更</DialogTitle>
          <DialogDescription>
            ほかの端末やカレンダーのサービスで後から変更された内容を優先しました。必要なら、自分の変更に戻せます。
          </DialogDescription>
        </DialogHeader>
        {items.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground">
            反映されなかった変更はありません。
          </p>
        ) : (
          <ul className="-mx-6 flex max-h-[min(60vh,560px)] flex-col divide-y overflow-y-auto px-6">
            {items.map((item) => {
              const calendar = calendarOf(item.calendarId);
              return (
                <ConflictRow
                  key={item.id}
                  item={item}
                  calendar={calendar}
                  color={calendar ? colorOf(calendar) : null}
                  current={eventOf(item.eventId)}
                  timeZone={timeZone}
                  busy={busy?.id === item.id ? busy.action : null}
                  disabled={busy !== null}
                  onAction={(action) => onAction(item, action)}
                />
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
