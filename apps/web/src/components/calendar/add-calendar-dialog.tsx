"use client";

import { cn } from "cn";
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

export type AddCalendarInput =
  | { kind: "local"; name: string; color: string }
  | { kind: "subscription"; url: string; name: string; color: string };

const MODES = [
  { value: "local", label: "新しいカレンダー" },
  { value: "subscription", label: "URL で購読" },
] as const;

/**
 * カレンダーを足す。Orbit 内だけのカレンダーを作るか、ICS の URL を購読する。
 * Google などのアカウントのカレンダーは、各サービスの同期と一緒に足す。
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
  onCreate: (input: AddCalendarInput) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<AddCalendarInput["kind"]>("local");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [color, setColor] = useState(COLORS[0] as string);
  useEffect(() => {
    if (open) {
      setMode("local");
      setName("");
      setUrl("");
      setColor(COLORS[0] as string);
    }
  }, [open]);
  const ready = mode === "local" ? name.trim() !== "" : url.trim() !== "";
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
            {mode === "local"
              ? "このサーバーだけに置くカレンダーを作ります。"
              : "公開されているカレンダー (.ics) の URL を登録すると、定期的に取得して表示します。予定は書き換えられません。"}
          </DialogDescription>
        </DialogHeader>
        <div
          role="radiogroup"
          aria-label="追加のしかた"
          className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1"
        >
          {MODES.map((entry) => (
            // biome-ignore lint/a11y/useSemanticElements: 切り替えのボタンにラジオボタンの役割を持たせる
            <button
              key={entry.value}
              type="button"
              role="radio"
              aria-checked={mode === entry.value}
              disabled={busy}
              onClick={() => setMode(entry.value)}
              className={cn(
                "h-8 rounded-md text-sm transition-colors",
                mode === entry.value
                  ? "bg-background font-medium shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <form
          id="add-calendar-form"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready || busy) return;
            onCreate(
              mode === "local"
                ? { kind: "local", name: name.trim(), color }
                : {
                    kind: "subscription",
                    url: url.trim(),
                    name: name.trim(),
                    color,
                  },
            );
          }}
        >
          {mode === "subscription" && (
            <Input
              autoFocus
              type="url"
              inputMode="url"
              aria-label="URL"
              placeholder="https://… または webcal://…"
              value={url}
              maxLength={2000}
              onChange={(event) => setUrl(event.target.value)}
            />
          )}
          <Input
            autoFocus={mode === "local"}
            aria-label="名前"
            placeholder={
              mode === "local"
                ? "名前 (例: 仕事)"
                : "名前 (空ならカレンダーに書かれた名前)"
            }
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
            disabled={!ready || busy}
          >
            {busy && <Spinner />}
            {mode === "local" ? "追加" : "購読"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
