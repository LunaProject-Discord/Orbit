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
  | { kind: "subscription"; url: string; name: string; color: string }
  | {
      kind: "caldav";
      service: "icloud" | "generic";
      /** 一般の CalDAV のサーバーの URL (iCloud では使わない)。 */
      url: string;
      /** iCloud は Apple ID。 */
      username: string;
      password: string;
    };

const MODES = [
  { value: "local", label: "新しいカレンダー" },
  { value: "subscription", label: "URL で購読" },
  { value: "caldav", label: "iCloud / CalDAV" },
] as const;

const SERVICES = [
  { value: "icloud", label: "iCloud" },
  { value: "generic", label: "その他の CalDAV" },
] as const;

const DESCRIPTIONS: Record<AddCalendarInput["kind"], string> = {
  local: "このサーバーだけに置くカレンダーを作ります。",
  subscription:
    "公開されているカレンダー (.ics) の URL を登録すると、定期的に取得して表示します。予定は書き換えられません。",
  caldav:
    "iCloud や CalDAV サーバーのアカウントを追加し、そのカレンダーを同期します。予定の変更はサーバーにも反映されます。",
};

/**
 * カレンダーを足す。Orbit 内だけのカレンダーを作るか、ICS の URL を購読するか、
 * iCloud / CalDAV のアカウントを追加する。
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
  const [service, setService] = useState<"icloud" | "generic">("icloud");
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  useEffect(() => {
    if (open) {
      setMode("local");
      setName("");
      setUrl("");
      setColor(COLORS[0] as string);
      setService("icloud");
      setServerUrl("");
      setUsername("");
      setPassword("");
    }
  }, [open]);
  const ready =
    mode === "local"
      ? name.trim() !== ""
      : mode === "subscription"
        ? url.trim() !== ""
        : username.trim() !== "" &&
          password !== "" &&
          (service === "icloud" || serverUrl.trim() !== "");
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
          <DialogDescription>{DESCRIPTIONS[mode]}</DialogDescription>
        </DialogHeader>
        <div
          role="radiogroup"
          aria-label="追加のしかた"
          className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1"
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
                : mode === "subscription"
                  ? {
                      kind: "subscription",
                      url: url.trim(),
                      name: name.trim(),
                      color,
                    }
                  : {
                      kind: "caldav",
                      service,
                      url: serverUrl.trim(),
                      username: username.trim(),
                      password,
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
          {mode === "caldav" && (
            <CaldavFields
              busy={busy}
              service={service}
              serverUrl={serverUrl}
              username={username}
              password={password}
              onService={setService}
              onServerUrl={setServerUrl}
              onUsername={setUsername}
              onPassword={setPassword}
            />
          )}
          {mode !== "caldav" && (
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
          )}
          {mode !== "caldav" && (
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
          )}
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
            {mode === "subscription" ? "購読" : "追加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** iCloud / CalDAV のアカウントの入力欄。 */
function CaldavFields({
  busy,
  service,
  serverUrl,
  username,
  password,
  onService,
  onServerUrl,
  onUsername,
  onPassword,
}: {
  busy: boolean;
  service: "icloud" | "generic";
  serverUrl: string;
  username: string;
  password: string;
  onService: (value: "icloud" | "generic") => void;
  onServerUrl: (value: string) => void;
  onUsername: (value: string) => void;
  onPassword: (value: string) => void;
}) {
  return (
    <>
      <div
        role="radiogroup"
        aria-label="サービス"
        className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1"
      >
        {SERVICES.map((entry) => (
          // biome-ignore lint/a11y/useSemanticElements: 切り替えのボタンにラジオボタンの役割を持たせる
          <button
            key={entry.value}
            type="button"
            role="radio"
            aria-checked={service === entry.value}
            disabled={busy}
            onClick={() => onService(entry.value)}
            className={cn(
              "h-8 rounded-md text-sm transition-colors",
              service === entry.value
                ? "bg-background font-medium shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {service === "generic" && (
        <Input
          autoFocus
          type="url"
          inputMode="url"
          aria-label="サーバーの URL"
          placeholder="サーバーの URL (例: https://dav.example.com/)"
          value={serverUrl}
          maxLength={2000}
          onChange={(event) => onServerUrl(event.target.value)}
        />
      )}
      <Input
        autoFocus={service === "icloud"}
        type={service === "icloud" ? "email" : "text"}
        autoComplete="username"
        aria-label={service === "icloud" ? "Apple ID" : "ユーザー名"}
        placeholder={
          service === "icloud" ? "Apple ID (メールアドレス)" : "ユーザー名"
        }
        value={username}
        maxLength={320}
        onChange={(event) => onUsername(event.target.value)}
      />
      <Input
        type="password"
        autoComplete="current-password"
        aria-label={service === "icloud" ? "アプリ用パスワード" : "パスワード"}
        placeholder={service === "icloud" ? "アプリ用パスワード" : "パスワード"}
        value={password}
        maxLength={1024}
        onChange={(event) => onPassword(event.target.value)}
      />
      {service === "icloud" && (
        <p className="text-muted-foreground text-xs">
          Apple ID のパスワードではなく、Apple
          のアカウントのページで作るアプリ用パスワードを入れてください。iCloud
          のメールを追加済みなら、同じアプリ用パスワードが使えます。
        </p>
      )}
    </>
  );
}
