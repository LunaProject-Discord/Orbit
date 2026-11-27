"use client";

import { useEffect, useState } from "react";
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
import type { Calendar } from "@/lib/calendar/api";
import { type ImipAccount, imipSenderAccounts } from "@/lib/calendar/imip";

/** 選択肢の「自動」の値 (imipAccountId: null)。 */
const AUTO = "auto";

/**
 * カレンダーの「招待メールの送信元」(imip-design 12.2)。Orbit 内と、招待を自分で送らない
 * CalDAV のカレンダーで、参加者を招待するときの主催者のアドレスを選ぶ。
 * 自動はサーバーが決めた送信元 (imipSender) をそのまま出す。
 */
export function ImipSenderDialog({
  calendar,
  accounts,
  busy,
  error,
  onSave,
  onOpenSettings,
  onClose,
}: {
  /** 設定するカレンダー。null なら閉じている。 */
  calendar: Calendar | null;
  accounts: readonly ImipAccount[];
  busy: boolean;
  error: string | null;
  /** 選んだアカウント (null は自動)。 */
  onSave: (accountId: string | null) => void;
  /** 送信できるアカウントが無いときの「アカウントの設定を開く」。 */
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(AUTO);
  const calendarId = calendar?.id;
  const chosen = calendar?.imipAccountId ?? null;
  useEffect(() => {
    if (calendarId) setValue(chosen ?? AUTO);
  }, [calendarId, chosen]);
  const sendable = imipSenderAccounts(accounts);
  const auto = calendar?.imipSender?.email;
  const options = [
    { value: AUTO, label: auto ? `自動 (${auto})` : "自動" },
    ...sendable.map((account) => ({
      value: account.id,
      label: account.email,
    })),
  ];
  // 選んでいたアカウントが受信専用になった・消えたときも、いまの値として出しておく。
  if (chosen && !sendable.some((account) => account.id === chosen)) {
    const missing = accounts.find((account) => account.id === chosen);
    options.push({
      value: chosen,
      label: missing ? `${missing.email} (受信専用)` : "(使えないアカウント)",
    });
  }
  const receiveOnly = calendar?.schedulingBlocked === "receive_only";
  const noSender = sendable.length === 0;
  return (
    <Dialog
      open={calendar !== null}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent sheet className="gap-4 sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>招待メールの送信元</DialogTitle>
          <DialogDescription>
            このカレンダーから参加者を招待するとき、ここで選んだアドレスが主催者になります。既にある予定の主催者は変わりません。
          </DialogDescription>
        </DialogHeader>
        {calendar && (
          <form
            id="imip-sender-form"
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy || noSender) return;
              onSave(value === AUTO ? null : value);
            }}
          >
            <p className="truncate text-muted-foreground text-sm">
              {calendar.name}
            </p>
            {noSender ? (
              <p className="text-sm">
                招待を送るには、送信できるメールアカウントが必要です。{" "}
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="text-primary underline-offset-4 outline-none hover:underline focus-visible:underline"
                >
                  アカウントの設定を開く
                </button>
              </p>
            ) : (
              <SimpleSelect
                label="招待メールの送信元"
                value={value}
                options={options}
                onChange={setValue}
                className="w-full justify-between"
              />
            )}
            {receiveOnly && !noSender && (
              <p className="text-destructive text-xs">
                いまの送信元は受信専用のため、招待を送れません。送信できるアドレスを選んでください。
              </p>
            )}
            {error && <p className="text-destructive text-sm">{error}</p>}
          </form>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          <Button
            type="submit"
            form="imip-sender-form"
            disabled={busy || noSender}
          >
            {busy && <Spinner />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
