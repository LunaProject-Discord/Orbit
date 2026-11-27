"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

const COLORS = [
  "#8b5cf6",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#f43f5e",
  "#6366f1",
  "#14b8a6",
  "#64748b",
];

/**
 * Orbit 内だけのカレンダーを足す。
 * Google などのアカウントのカレンダーと ICS の購読は、各サービスの同期と一緒に足す。
 */
export function AddCalendarDialog({
  open,
  busy,
  error,
  onCreate,
  onClose,
}: {
  open: boolean;
  busy: boolean;
  error: string | null;
  onCreate: (input: { name: string; color: string }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[0] as string);
  useEffect(() => {
    if (open) {
      setName("");
      setColor(COLORS[0] as string);
    }
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent sheet>
        <DialogHeader>
          <DialogTitle>カレンダーを追加</DialogTitle>
          <DialogDescription>
            このサーバーだけに置くカレンダーを作ります。
          </DialogDescription>
        </DialogHeader>
        <form
          id="add-calendar-form"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && !busy) onCreate({ name: name.trim(), color });
          }}
        >
          <Input
            autoFocus
            aria-label="名前"
            placeholder="名前 (例: 仕事)"
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
          />
          <div
            className="flex flex-wrap gap-2"
            role="radiogroup"
            aria-label="色"
          >
            {COLORS.map((value) => (
              // biome-ignore lint/a11y/useSemanticElements: 色の丸を出すため、ボタンにラジオボタンの役割を持たせる
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={color === value}
                aria-label={value}
                onClick={() => setColor(value)}
                className="size-7 rounded-full ring-offset-2 ring-offset-background aria-checked:ring-2 aria-checked:ring-ring"
                style={{ background: value }}
              />
            ))}
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          <Button
            type="submit"
            form="add-calendar-form"
            disabled={!name.trim() || busy}
          >
            {busy && <Spinner />}
            追加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
