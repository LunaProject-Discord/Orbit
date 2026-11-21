"use client";

import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  type Account,
  ApiError,
  createAccount,
  NetworkError,
  startMicrosoftLogin,
} from "@/lib/api";

function messageOf(error: unknown): string {
  if (error instanceof NetworkError) {
    return "サーバーに接続できませんでした。ネットワークの状態を確認してください。";
  }
  if (error instanceof ApiError) {
    const body = (error.body ?? {}) as { host?: string; detail?: string };
    switch (error.code) {
      case "auth_failed":
        return "メールサーバーにログインできませんでした。ユーザー名とパスワードを確認してください。";
      case "connection_failed":
        return `IMAP サーバーに接続できませんでした。ホスト名、ポート、TLS の設定を確認してください。${
          body.detail ? ` (${body.detail})` : ""
        }`;
      case "account_exists":
        return "このメールアドレスはすでに追加されています。";
      case "host_not_allowed":
        return `このホストには接続できません${body.host ? `: ${body.host}` : ""}。`;
      case "microsoft_not_configured":
        return "このサーバーでは Microsoft アカウントの追加が設定されていません。サーバーの管理者に確認してください。";
      case "host_not_found":
        return `ホストが見つかりません${body.host ? `: ${body.host}` : ""}。ホスト名を確認してください。`;
    }
    if (error.status === 400) {
      return "入力内容に誤りがあります。各項目を確認してください。";
    }
  }
  return "アカウントを追加できませんでした。時間をおいてもう一度お試しください。";
}

const initialForm = {
  email: "",
  displayName: "",
  username: "",
  password: "",
  imapHost: "",
  imapPort: "993",
  imapSecure: true,
  smtpHost: "",
  smtpPort: "587",
  smtpSecure: false,
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (account: Account) => void;
};

export function AddAccountDialog({ open, onOpenChange, onCreated }: Props) {
  const id = useId();
  const [form, setForm] = useState(initialForm);
  /** ユーザー名を手で変えるまでは、メールアドレスと同じ値にする。 */
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [redirecting, setRedirecting] = useState(false);

  async function handleMicrosoft() {
    setError(null);
    setRedirecting(true);
    try {
      // Microsoft のログイン画面へ移動する。ログイン後は /oauth/microsoft に戻ってくる。
      window.location.assign(await startMicrosoftLogin());
    } catch (cause) {
      setError(messageOf(cause));
      setRedirecting(false);
    }
  }

  const set = <K extends keyof typeof initialForm>(
    key: K,
    value: (typeof initialForm)[K],
  ) => setForm((current) => ({ ...current, [key]: value }));

  function handleOpenChange(next: boolean) {
    if (submitting || redirecting) return;
    if (!next) {
      setForm(initialForm);
      setUsernameEdited(false);
      setError(null);
    }
    onOpenChange(next);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const email = form.email.trim();
      const account = await createAccount({
        email,
        ...(form.displayName.trim()
          ? { displayName: form.displayName.trim() }
          : {}),
        provider: "generic",
        imap: {
          host: form.imapHost.trim(),
          port: Number(form.imapPort),
          secure: form.imapSecure,
        },
        smtp: {
          host: form.smtpHost.trim(),
          port: Number(form.smtpPort),
          secure: form.smtpSecure,
        },
        username: usernameEdited ? form.username : email,
        password: form.password,
      });
      setSubmitting(false);
      setForm(initialForm);
      setUsernameEdited(false);
      onCreated(account);
      onOpenChange(false);
    } catch (cause) {
      setError(messageOf(cause));
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>メールアカウントを追加</DialogTitle>
          <DialogDescription>
            追加すると受信トレイの同期が始まります。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={submitting || redirecting}
            onClick={() => void handleMicrosoft()}
          >
            {redirecting
              ? "Microsoft のログイン画面へ移動中…"
              : "Microsoft アカウントでログイン"}
          </Button>
          <p className="text-muted-foreground text-xs">
            Microsoft 365 (Exchange Online) と Outlook.com
            のアカウントを追加できます。
          </p>
        </div>
        <div className="flex items-center gap-3 text-muted-foreground text-xs">
          <span className="h-px flex-1 bg-border" />
          または IMAP サーバーを設定
          <span className="h-px flex-1 bg-border" />
        </div>
        <p className="text-muted-foreground text-sm">
          iCloud や Gmail
          では、通常のパスワードではなくアプリ用パスワードを使ってください。
        </p>
        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-email`}>メールアドレス</Label>
              <Input
                id={`${id}-email`}
                type="email"
                required
                autoComplete="off"
                value={form.email}
                onChange={(event) => set("email", event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-display-name`}>表示名 (任意)</Label>
              <Input
                id={`${id}-display-name`}
                maxLength={200}
                autoComplete="off"
                value={form.displayName}
                onChange={(event) => set("displayName", event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-username`}>ユーザー名</Label>
              <Input
                id={`${id}-username`}
                required
                autoComplete="off"
                value={usernameEdited ? form.username : form.email}
                onChange={(event) => {
                  setUsernameEdited(true);
                  set("username", event.target.value);
                }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-password`}>パスワード</Label>
              <Input
                id={`${id}-password`}
                type="password"
                required
                autoComplete="new-password"
                value={form.password}
                onChange={(event) => set("password", event.target.value)}
              />
            </div>
          </div>

          <ServerFields
            idPrefix={`${id}-imap`}
            legend="受信 (IMAP)"
            host={form.imapHost}
            port={form.imapPort}
            secure={form.imapSecure}
            hostPlaceholder="imap.example.com"
            secureLabel="TLS で接続する (ポート 993)"
            onHost={(value) => set("imapHost", value)}
            onPort={(value) => set("imapPort", value)}
            onSecure={(value) => set("imapSecure", value)}
          />
          <ServerFields
            idPrefix={`${id}-smtp`}
            legend="送信 (SMTP)"
            host={form.smtpHost}
            port={form.smtpPort}
            secure={form.smtpSecure}
            hostPlaceholder="smtp.example.com"
            secureLabel="最初から TLS で接続する (ポート 465)"
            onHost={(value) => set("smtpHost", value)}
            onPort={(value) => set("smtpPort", value)}
            onSecure={(value) => set("smtpSecure", value)}
          />

          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={submitting || redirecting}
              onClick={() => handleOpenChange(false)}
            >
              キャンセル
            </Button>
            <Button type="submit" disabled={submitting || redirecting}>
              {submitting ? "接続を確認中…" : "追加"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ServerFields(props: {
  idPrefix: string;
  legend: string;
  host: string;
  port: string;
  secure: boolean;
  hostPlaceholder: string;
  secureLabel: string;
  onHost: (value: string) => void;
  onPort: (value: string) => void;
  onSecure: (value: boolean) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-3 font-medium text-sm">{props.legend}</legend>
      <div className="grid grid-cols-[1fr_6rem] gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${props.idPrefix}-host`}>ホスト</Label>
          <Input
            id={`${props.idPrefix}-host`}
            required
            maxLength={253}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={props.hostPlaceholder}
            value={props.host}
            onChange={(event) => props.onHost(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${props.idPrefix}-port`}>ポート</Label>
          <Input
            id={`${props.idPrefix}-port`}
            type="number"
            inputMode="numeric"
            required
            min={1}
            max={65535}
            value={props.port}
            onChange={(event) => props.onPort(event.target.value)}
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${props.idPrefix}-secure`}
          checked={props.secure}
          onCheckedChange={(checked) => props.onSecure(checked === true)}
        />
        <Label htmlFor={`${props.idPrefix}-secure`} className="font-normal">
          {props.secureLabel}
        </Label>
      </div>
    </fieldset>
  );
}
