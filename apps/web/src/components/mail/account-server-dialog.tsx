"use client";

import { CircleAlertIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import {
  ServerFields,
  type ServerForm,
  serverFormFromSaved,
  toServerSettings,
} from "@/components/mail/server-settings";
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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  type Account,
  type AccountServerInput,
  ApiError,
  NetworkError,
  ServerCheckError,
  type ServerCheckResult,
  testAccountServer,
  updateAccountServer,
} from "@/lib/api";

/** IMAP / SMTP をパスワードでつなぐアカウントだけが、接続先を変えられる。 */
export function canEditServer(account: Account): boolean {
  return account.protocol === "imap" && account.authType === "password";
}

type Props = {
  account: Account | null;
  onOpenChange: (open: boolean) => void;
  onUpdated: (account: Account) => void;
};

/**
 * 追加済みアカウントのサーバー設定 (ホスト、ポート、セキュリティ、ユーザー名、パスワード) を変える。
 * 保存する前に、受信と送信の両方へ実際にログインできるかを確かめる。
 */
export function AccountServerDialog({
  account,
  onOpenChange,
  onUpdated,
}: Props) {
  return (
    <Dialog
      open={account !== null}
      onOpenChange={(open) => {
        if (!open) onOpenChange(false);
      }}
    >
      {account && (
        <AccountServerForm
          key={account.id}
          account={account}
          onClose={() => onOpenChange(false)}
          onUpdated={onUpdated}
        />
      )}
    </Dialog>
  );
}

function AccountServerForm({
  account,
  onClose,
  onUpdated,
}: {
  account: Account;
  onClose: () => void;
  onUpdated: (account: Account) => void;
}) {
  const id = useId();
  const [username, setUsername] = useState(account.username);
  const [password, setPassword] = useState("");
  const [imap, setImap] = useState<ServerForm>(() =>
    serverFormFromSaved(account.imapHost, account.imapPort, account.imapSecure),
  );
  const [smtp, setSmtp] = useState<ServerForm>(() =>
    serverFormFromSaved(account.smtpHost, account.smtpPort, account.smtpSecure),
  );
  const [allowLegacyTls, setAllowLegacyTls] = useState(account.allowLegacyTls);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [result, setResult] = useState<ServerCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const legacyOffered =
    account.provider === "generic" &&
    (account.allowLegacyTls ||
      allowLegacyTls ||
      (result !== null &&
        [result.imap, result.smtp].some(
          (check) => !check.ok && check.reason === "legacy_tls_required",
        )));

  const input = (): AccountServerInput => ({
    imap: toServerSettings(imap),
    smtp: toServerSettings(smtp),
    username: username.trim(),
    ...(password ? { password } : {}),
    ...(account.provider === "generic" ? { allowLegacyTls } : {}),
  });

  const failure = (cause: unknown) => {
    if (cause instanceof NetworkError) {
      return "サーバーに接続できませんでした。ネットワークの状態を確認してください。";
    }
    if (cause instanceof ApiError && cause.status === 400) {
      return "入力内容に誤りがあります。各項目を確認してください。";
    }
    return "接続を確認できませんでした。時間をおいてもう一度お試しください。";
  };

  async function handleTest() {
    setBusy("test");
    setError(null);
    setResult(null);
    try {
      setResult(await testAccountServer(account.id, input()));
    } catch (cause) {
      setError(failure(cause));
    }
    setBusy(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("save");
    setError(null);
    setResult(null);
    try {
      const updated = await updateAccountServer(account.id, input());
      setBusy(null);
      onUpdated(updated);
      onClose();
    } catch (cause) {
      if (cause instanceof ServerCheckError) {
        setResult(cause.result);
        setError(
          "接続を確認できなかったため、保存していません。下の内容を確認してください。",
        );
      } else {
        setError(failure(cause));
      }
      setBusy(null);
    }
  }

  return (
    <DialogContent
      showCloseButton={false}
      className="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto sm:max-w-[560px]"
    >
      <DialogHeader>
        <DialogTitle className="font-semibold text-lg">
          サーバー設定
        </DialogTitle>
        <DialogDescription className="break-all">
          {account.email}{" "}
          の受信と送信のサーバーを変更します。保存する前に、両方のサーバーへ接続できるかを確認します。
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-username`}>ユーザー名</Label>
            <Input
              id={`${id}-username`}
              required
              maxLength={320}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-password`}>パスワード</Label>
            <Input
              id={`${id}-password`}
              type="password"
              autoComplete="new-password"
              placeholder="変更しない場合は空欄"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
        </div>
        <ServerFields
          idPrefix={`${id}-imap`}
          kind="imap"
          value={imap}
          onChange={setImap}
          disabled={busy !== null}
          check={result?.imap}
        />
        <ServerFields
          idPrefix={`${id}-smtp`}
          kind="smtp"
          value={smtp}
          onChange={setSmtp}
          disabled={busy !== null}
          check={result?.smtp}
        />
        {legacyOffered && (
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
            <div className="min-w-0 flex-1">
              <p id={`${id}-legacy-tls`} className="font-medium text-sm">
                古い TLS のサーバーへの接続を許可する
              </p>
              <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
                安全な再ネゴシエーション (RFC 5746)
                に対応していないサーバー向けです。安全性が下がるため、接続できない場合にだけオンにしてください。
              </p>
            </div>
            <Switch
              aria-labelledby={`${id}-legacy-tls`}
              checked={allowLegacyTls}
              onCheckedChange={setAllowLegacyTls}
            />
          </div>
        )}
        {error && (
          <p
            role="alert"
            className="flex items-start gap-1.5 text-destructive text-sm"
          >
            <CircleAlertIcon
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            {error}
          </p>
        )}
        {result?.ok && !error && (
          <p className="text-muted-foreground text-xs">
            この設定で接続できます。「保存」を押すと、新しい設定で同期をやり直します。
          </p>
        )}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void handleTest()}
          >
            {busy === "test" ? "確認中…" : "接続をテスト"}
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button
              type="button"
              variant="ghost"
              disabled={busy !== null}
              onClick={onClose}
            >
              キャンセル
            </Button>
            <Button type="submit" disabled={busy !== null}>
              {busy === "save" ? "接続を確認中…" : "保存"}
            </Button>
          </div>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
