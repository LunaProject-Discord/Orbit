"use client";

import { CircleAlertIcon, TriangleAlertIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import {
  IncomingProtocolPicker,
  PopOptions,
  ReceiveOnlySwitch,
  ServerFields,
  type ServerForm,
  ServerSummary,
  serverFormFromSaved,
  smtpFormFromIncoming,
  switchIncomingServerForm,
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
  type IncomingProtocol,
  isReceiveOnly,
  NetworkError,
  type PopSettings,
  ServerCheckError,
  type ServerCheckResult,
  testAccountServer,
  updateAccountServer,
} from "@/lib/api";

/**
 * 接続先を入力欄で変えられるか。パスワードで接続する IMAP と POP3 のアカウントが対象。
 * Google でログインした Gmail は、アプリ パスワードへ切り替えるときだけ変えられる。
 * Microsoft Graph のアカウントは IMAP / POP3 / SMTP を使わない。
 */
export function canEditServer(account: Account): boolean {
  return (
    (account.protocol === "imap" || account.protocol === "pop3") &&
    account.authType === "password"
  );
}

type Props = {
  account: Account | null;
  onOpenChange: (open: boolean) => void;
  onUpdated: (account: Account) => void;
  /** Google / Microsoft のログインをやり直す。 */
  onReauth: (account: Account) => void;
};

/**
 * 追加済みアカウントのサーバー設定 (ホスト、ポート、セキュリティ、ユーザー名、パスワード) を変える。
 * 保存する前に、受信と送信の両方へ実際にログインできるかを確かめる。
 */
export function AccountServerDialog({
  account,
  onOpenChange,
  onUpdated,
  onReauth,
}: Props) {
  return (
    <Dialog
      open={account !== null}
      onOpenChange={(open) => {
        if (!open) onOpenChange(false);
      }}
    >
      {account && (
        <AccountServerContent
          key={account.id}
          account={account}
          onClose={() => onOpenChange(false)}
          onUpdated={onUpdated}
          onReauth={onReauth}
        />
      )}
    </Dialog>
  );
}

/** アカウントの種類に合わせて、入力欄か、ログインの案内を出す。 */
function AccountServerContent(props: {
  account: Account;
  onClose: () => void;
  onUpdated: (account: Account) => void;
  onReauth: (account: Account) => void;
}) {
  const { account } = props;
  /** Google でログインした Gmail を、アプリ パスワードでの接続に切り替える。 */
  const [switching, setSwitching] = useState(false);
  if (canEditServer(account) || switching) {
    return (
      <AccountServerForm
        account={account}
        onClose={props.onClose}
        onUpdated={props.onUpdated}
        requirePassword={!canEditServer(account)}
      />
    );
  }
  const graph = account.protocol === "graph";
  const providerName = graph ? "Microsoft" : "Google";
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
          {account.email} は {providerName}{" "}
          でログインして接続しています。サーバーは自動で決まるので、変更するものはありません。うまく同期できないときは、ログインし直してください。
        </DialogDescription>
      </DialogHeader>
      {graph ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border bg-muted/30 p-3 text-sm">
          <dt className="text-muted-foreground">接続方法</dt>
          <dd>Microsoft Graph (Exchange Online / Outlook.com)</dd>
          <dt className="text-muted-foreground">サーバー</dt>
          <dd className="truncate">graph.microsoft.com</dd>
          <dt className="text-muted-foreground">ユーザー名</dt>
          <dd className="truncate">{account.username}</dd>
          <dt className="text-muted-foreground">認証</dt>
          <dd>OAuth2 (Microsoft でログイン)</dd>
        </dl>
      ) : (
        <ServerSummary
          imap={serverFormFromSaved(
            account.imapHost,
            account.imapPort,
            account.imapSecure,
          )}
          smtp={serverFormFromSaved(
            account.smtpHost,
            account.smtpPort,
            account.smtpSecure,
          )}
          username={account.username}
          auth={{ imap: "oauth2", smtp: "oauth2" }}
        />
      )}
      <DialogFooter className="gap-2 sm:justify-between">
        {graph ? (
          <span />
        ) : (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="px-0"
            onClick={() => setSwitching(true)}
          >
            アプリ パスワードでの接続に切り替える
          </Button>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="ghost" onClick={props.onClose}>
            閉じる
          </Button>
          <Button
            type="button"
            onClick={() => {
              props.onClose();
              props.onReauth(account);
            }}
          >
            {providerName} にログインし直す
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  );
}

function AccountServerForm({
  account,
  onClose,
  onUpdated,
  requirePassword,
}: {
  account: Account;
  onClose: () => void;
  onUpdated: (account: Account) => void;
  /** 保存済みのパスワードが無い (Google のログインから切り替える) ので、入力を必須にする。 */
  requirePassword: boolean;
}) {
  const id = useId();
  const [username, setUsername] = useState(account.username);
  const [password, setPassword] = useState("");
  const [imap, setImap] = useState<ServerForm>(() =>
    serverFormFromSaved(account.imapHost, account.imapPort, account.imapSecure),
  );
  /** 受信専用 (送信サーバーを使わない) にするか。今の設定から始める。 */
  const [receiveOnly, setReceiveOnly] = useState(() => isReceiveOnly(account));
  // 受信専用のアカウントは送信サーバーの設定を持たないので、オフにしたときに備えて、
  // 受信サーバーと同じホストと SSL/TLS の決まったポート番号を入れておく。
  const [smtp, setSmtp] = useState<ServerForm>(() =>
    isReceiveOnly(account)
      ? smtpFormFromIncoming(account.imapHost)
      : serverFormFromSaved(
          account.smtpHost,
          account.smtpPort,
          account.smtpSecure,
        ),
  );
  /** 今の受信方式。Google のログインから切り替えるときは IMAP のまま。 */
  const savedProtocol: IncomingProtocol =
    account.protocol === "pop3" ? "pop3" : "imap";
  const [protocol, setProtocol] = useState<IncomingProtocol>(savedProtocol);
  const [pop, setPop] = useState<PopSettings>({
    leaveOnServer: account.popLeaveOnServer,
    deleteAfterDays: account.popDeleteAfterDays,
  });
  /** 受信方式を変えると、取り込み済みのメールとフォルダを消して取り込み直す。 */
  const switchingProtocol = protocol !== savedProtocol;
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
    // Google のログインから切り替えるときは受信方式を選ばないので、今の方式のまま (省略)。
    ...(requirePassword ? {} : { incomingProtocol: protocol }),
    ...(protocol === "pop3" ? { pop } : {}),
    imap: toServerSettings(imap),
    // 受信専用なら null を送る。送信サーバーは確かめない。
    smtp: receiveOnly ? null : toServerSettings(smtp),
    username: username.trim(),
    // Google のアプリ パスワードは 4 文字ごとの空白入りで表示される。
    ...(password
      ? { password: requirePassword ? password.replace(/\s+/g, "") : password }
      : {}),
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
          {requirePassword
            ? `${account.email} を、Google のログインの代わりにアプリ パスワードで接続します。保存する前に、受信と送信のサーバーへ接続できるかを確認します。`
            : receiveOnly
              ? `${account.email} の受信サーバーを変更します。保存する前に、受信サーバーへ接続できるかを確認します。`
              : `${account.email} の受信と送信のサーバーを変更します。保存する前に、両方のサーバーへ接続できるかを確認します。`}
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
            <Label htmlFor={`${id}-password`}>
              {requirePassword ? "アプリ パスワード" : "パスワード"}
            </Label>
            <Input
              id={`${id}-password`}
              type="password"
              required={requirePassword}
              autoComplete="new-password"
              placeholder={
                requirePassword ? "xxxx xxxx xxxx xxxx" : "変更しない場合は空欄"
              }
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
        </div>
        {!requirePassword && (
          <IncomingProtocolPicker
            value={protocol}
            onChange={(next) => {
              // 手で変えていなければ、ポート番号とホスト名を新しい方式に合わせる。
              setImap((current) =>
                switchIncomingServerForm(
                  current,
                  protocol,
                  next,
                  account.email,
                ),
              );
              setProtocol(next);
              setResult(null);
            }}
            disabled={busy !== null}
          />
        )}
        {switchingProtocol && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
          >
            <TriangleAlertIcon
              className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
              aria-hidden="true"
            />
            <span className="min-w-0">
              受信方式を変えると、このアカウントで取り込み済みのメールとフォルダをいったん消して、新しい方式で取り込み直します。POP3
              でサーバーから削除済みのメールは戻りません。
            </span>
          </div>
        )}
        <ServerFields
          idPrefix={`${id}-imap`}
          kind="imap"
          protocol={protocol}
          value={imap}
          onChange={setImap}
          disabled={busy !== null}
          check={result?.imap}
        />
        {protocol === "pop3" && (
          <PopOptions value={pop} onChange={setPop} disabled={busy !== null} />
        )}
        {/* Google のログインから切り替えるときは、受信方式と同じく今の送信の設定のまま。 */}
        {!requirePassword && (
          <ReceiveOnlySwitch
            checked={receiveOnly}
            onCheckedChange={(checked) => {
              setReceiveOnly(checked);
              setResult(null);
            }}
            disabled={busy !== null}
          />
        )}
        {/* 受信専用のときは、送信サーバーの欄を隠す (入力した値は残しておく)。 */}
        {!receiveOnly && (
          <ServerFields
            idPrefix={`${id}-smtp`}
            kind="smtp"
            value={smtp}
            onChange={setSmtp}
            disabled={busy !== null}
            check={result?.smtp}
          />
        )}
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
            {switchingProtocol
              ? "この設定で接続できます。「保存して取り込み直す」を押すと、取り込み済みのメールを消して新しい受信方式で取り込み直します。"
              : "この設定で接続できます。「保存」を押すと、新しい設定で同期をやり直します。"}
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
              {busy === "save"
                ? "接続を確認中…"
                : switchingProtocol
                  ? "保存して取り込み直す"
                  : "保存"}
            </Button>
          </div>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
