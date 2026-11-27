"use client";

import { Button } from "@/components/ui/button";
import type { AttendeeStatus } from "@/lib/calendar/api";

export type RsvpChoice = "accepted" | "tentative" | "declined";

const CHOICES: { status: RsvpChoice; label: string }[] = [
  { status: "accepted", label: "参加" },
  { status: "tentative", label: "未定" },
  { status: "declined", label: "不参加" },
];

/**
 * 「出席しますか?」と、参加 / 未定 / 不参加の 3 つ並びのボタン (予定の詳細とメールの招待カードで使う)。
 * いまの出欠のボタンは塗りにする。未返信 (null) ならどれも塗らない。
 */
export function RsvpButtons({
  value,
  disabled = false,
  onChange,
  note = null,
}: {
  /** いまの出欠 (未返信は null)。 */
  value: AttendeeStatus | null;
  disabled?: boolean;
  onChange: (status: RsvpChoice) => void;
  /** ボタンの下の小さな注記。 */
  note?: string | null;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className="mb-2 p-0 text-muted-foreground text-xs">
        出席しますか?
      </legend>
      <div className="grid grid-cols-3 gap-2">
        {CHOICES.map(({ status, label }) => {
          const chosen = value === status;
          return (
            <Button
              key={status}
              type="button"
              variant={chosen ? "default" : "outline"}
              aria-pressed={chosen}
              disabled={disabled}
              className="w-full"
              onClick={() => {
                if (!chosen) onChange(status);
              }}
            >
              {label}
            </Button>
          );
        })}
      </div>
      {note && (
        <p className="whitespace-pre-line text-muted-foreground text-xs">
          {note}
        </p>
      )}
    </fieldset>
  );
}
