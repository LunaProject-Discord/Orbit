"use client";

import { cn } from "cn";
import { ChevronLeftIcon, MailIcon } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import {
  type Account,
  ApiError,
  createAccount,
  NetworkError,
  type OAuthProvider,
  startOAuthLogin,
} from "@/lib/api";
import { isNativeApp } from "@/lib/native/app";

/** 画面の段階。choose はサービスの選択、icloud と manual は入力フォーム。 */
type Step = "choose" | "icloud" | "manual";

function messageOf(error: unknown, step: Step): string {
  if (error instanceof NetworkError) {
    return "サーバーに接続できませんでした。ネットワークの状態を確認してください。";
  }
  if (error instanceof ApiError) {
    const body = (error.body ?? {}) as { host?: string; detail?: string };
    switch (error.code) {
      case "auth_failed":
        return step === "icloud"
          ? "iCloud にログインできませんでした。メールアドレスとアプリ用パスワードを確認してください (Apple Account のパスワードではログインできません)。"
          : "メールサーバーにログインできませんでした。ユーザー名とパスワードを確認してください。";
      case "connection_failed":
        return step === "icloud"
          ? `iCloud のメールサーバーに接続できませんでした。時間をおいてもう一度お試しください。${
              body.detail ? ` (${body.detail})` : ""
            }`
          : `IMAP サーバーに接続できませんでした。ホスト名、ポート、TLS の設定を確認してください。${
              body.detail ? ` (${body.detail})` : ""
            }`;
      case "legacy_tls_required":
        return "このメールサーバーは、古い方式の TLS にしか対応していません。接続するには、下の「古い TLS のサーバーへの接続を許可する」をオンにして、もう一度「追加」を押してください。";
      case "account_exists":
        return "このメールアドレスはすでに追加されています。";
      case "host_not_allowed":
        return `このホストには接続できません${body.host ? `: ${body.host}` : ""}。`;
      case "microsoft_not_configured":
        return "このサーバーでは Microsoft アカウントの追加が設定されていません。サーバーの管理者に確認してください。";
      case "google_not_configured":
        return "このサーバーでは Google でのログインが設定されていません。サーバーの管理者に確認するか、「その他のメール」からアプリ パスワードで追加してください。";
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
  allowLegacyTls: false,
};

const descriptions: Record<Step, string> = {
  choose:
    "追加したアカウントはサーバーが常時同期し、すべての端末に同じ状態で届きます。",
  icloud:
    "iCloud メールのアドレスと、このアプリ専用に作ったアプリ用パスワードを入力してください。",
  manual:
    "メールサービスが案内している IMAP と SMTP の設定を入力してください。",
};

const titles: Record<Step, string> = {
  choose: "メールアカウントを追加",
  icloud: "iCloud のアカウントを追加",
  manual: "その他のメールを追加",
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (account: Account) => void;
};

export function AddAccountDialog({ open, onOpenChange, onCreated }: Props) {
  const id = useId();
  const [step, setStep] = useState<Step>("choose");
  const [form, setForm] = useState(initialForm);
  /** ユーザー名を手で変えるまでは、メールアドレスと同じ値にする。 */
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 古い TLS のサーバーだと分かったときだけ、許可のスイッチを出す。 */
  const [legacyTlsOffered, setLegacyTlsOffered] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** ログイン画面へ移動中のサービス。 */
  const [redirecting, setRedirecting] = useState<OAuthProvider | null>(null);
  const busy = submitting || redirecting !== null;

  async function handleOAuth(provider: OAuthProvider) {
    setError(null);
    setRedirecting(provider);
    try {
      // ログイン画面へ移動する。ログイン後は /oauth/google などに戻ってくる。
      window.location.assign(await startOAuthLogin(provider));
      // スマホアプリでは、ログイン画面はアプリの外のブラウザーで開き、この画面は残る。
      // ログインをやめて戻ってきたときに、もう一度押せるようにしておく。
      if (isNativeApp()) setRedirecting(null);
    } catch (cause) {
      setError(messageOf(cause, step));
      setRedirecting(null);
    }
  }

  const set = <K extends keyof typeof initialForm>(
    key: K,
    value: (typeof initialForm)[K],
  ) => setForm((current) => ({ ...current, [key]: value }));

  function reset() {
    setStep("choose");
    setForm(initialForm);
    setUsernameEdited(false);
    setLegacyTlsOffered(false);
    setError(null);
  }

  function goTo(next: Step) {
    if (busy) return;
    setError(null);
    setStep(next);
  }

  function handleOpenChange(next: boolean) {
    if (busy) return;
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const email = form.email.trim();
      const common = {
        email,
        ...(form.displayName.trim()
          ? { displayName: form.displayName.trim() }
          : {}),
      };
      const account = await createAccount(
        step === "icloud"
          ? {
              ...common,
              provider: "icloud",
              // アプリ用パスワードは 4 文字ごとにハイフンで区切って表示される。
              // 空白を入れて書き写しても通るよう、空白だけ取り除く。
              password: form.password.replace(/\s+/g, ""),
            }
          : {
              ...common,
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
              ...(legacyTlsOffered && form.allowLegacyTls
                ? { allowLegacyTls: true }
                : {}),
            },
      );
      setSubmitting(false);
      reset();
      onCreated(account);
      onOpenChange(false);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "legacy_tls_required") {
        setLegacyTlsOffered(true);
      }
      setError(messageOf(cause, step));
      setSubmitting(false);
    }
  }

  const alert = error && (
    <p role="alert" className="text-destructive text-sm">
      {error}
    </p>
  );
  const emailField = (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`${id}-email`}>メールアドレス</Label>
      <Input
        id={`${id}-email`}
        type="email"
        required
        autoComplete="off"
        placeholder={step === "icloud" ? "name@icloud.com" : undefined}
        value={form.email}
        onChange={(event) => set("email", event.target.value)}
      />
    </div>
  );
  const displayNameField = (
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
  );
  const footer = (
    <DialogFooter>
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={() => goTo("choose")}
      >
        <ChevronLeftIcon data-icon="inline-start" />
        戻る
      </Button>
      <Button type="submit" disabled={busy}>
        {submitting ? "接続を確認中…" : "追加"}
      </Button>
    </DialogFooter>
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto sm:max-w-[520px]"
      >
        <DialogHeader>
          <DialogTitle className="font-semibold text-lg">
            {titles[step]}
          </DialogTitle>
          <DialogDescription>{descriptions[step]}</DialogDescription>
        </DialogHeader>

        {step === "choose" && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <ProviderTile
                name="Gmail"
                note={
                  redirecting === "google"
                    ? "ログイン画面へ移動中…"
                    : "Google でログイン"
                }
                tone="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                disabled={busy}
                onClick={() => void handleOAuth("google")}
              />
              <ProviderTile
                name="Microsoft"
                note={
                  redirecting === "microsoft"
                    ? "ログイン画面へ移動中…"
                    : "Microsoft 365 / Outlook.com"
                }
                tone="bg-violet-500/10 text-violet-600 dark:text-violet-400"
                disabled={busy}
                onClick={() => void handleOAuth("microsoft")}
              />
              <ProviderTile
                name="iCloud"
                note="アプリ用パスワード"
                tone="bg-sky-500/10 text-sky-600 dark:text-sky-400"
                disabled={busy}
                onClick={() => goTo("icloud")}
              />
              <ProviderTile
                name="その他のメール"
                note="IMAP / SMTP を手動で設定"
                tone="bg-muted"
                disabled={busy}
                onClick={() => goTo("manual")}
              />
            </div>
            {alert}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => handleOpenChange(false)}
              >
                キャンセル
              </Button>
            </DialogFooter>
          </>
        )}

        {step === "icloud" && (
          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div className="grid gap-4 sm:grid-cols-2">
              {emailField}
              {displayNameField}
              <div className="flex flex-col gap-2 sm:col-span-2">
                <Label htmlFor={`${id}-password`}>アプリ用パスワード</Label>
                <Input
                  id={`${id}-password`}
                  type="password"
                  required
                  autoComplete="off"
                  placeholder="xxxx-xxxx-xxxx-xxxx"
                  value={form.password}
                  onChange={(event) => set("password", event.target.value)}
                />
                <p className="text-muted-foreground text-xs leading-relaxed">
                  Apple Account のパスワードではログインできません。
                  <a
                    href="https://account.apple.com/"
                    target="_blank"
                    rel="noreferrer"
                    className="text-foreground underline underline-offset-2"
                  >
                    account.apple.com
                  </a>{" "}
                  にサインインし、「サインインとセキュリティ」の「アプリ用パスワード」で作成してください
                  (2 ファクタ認証が必要です)。
                </p>
              </div>
            </div>
            {alert}
            {footer}
          </form>
        )}

        {step === "manual" && (
          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div className="grid gap-4 sm:grid-cols-2">
              {emailField}
              {displayNameField}
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
            {alert}
            {legacyTlsOffered && (
              <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                <div className="min-w-0 flex-1">
                  <p id={`${id}-legacy-tls`} className="font-medium text-sm">
                    古い TLS のサーバーへの接続を許可する
                  </p>
                  <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
                    安全な再ネゴシエーション (RFC 5746)
                    に対応していないサーバーへ接続します。通信は暗号化され、証明書も確認しますが、通信経路に割り込める相手に内容を差し込まれるおそれが残ります。このアカウントの接続にだけ適用され、あとから設定で変えられます。
                  </p>
                </div>
                <Switch
                  aria-labelledby={`${id}-legacy-tls`}
                  checked={form.allowLegacyTls}
                  onCheckedChange={(checked) => set("allowLegacyTls", checked)}
                />
              </div>
            )}
            {footer}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ProviderTile(props: {
  name: string;
  note: string;
  /** アイコンの背景と文字の色。 */
  tone: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className="flex items-center gap-3 rounded-lg border p-3 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-60"
    >
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-md",
          props.tone,
        )}
      >
        <MailIcon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-sm">{props.name}</span>
        <span className="block text-muted-foreground text-xs">
          {props.note}
        </span>
      </span>
    </button>
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
            type="text"
            inputMode="numeric"
            required
            // 1〜65535 の数字だけを受け付ける (ブラウザーの数値欄の上下ボタンは使わない)。
            pattern="[1-9][0-9]{0,4}"
            maxLength={5}
            autoComplete="off"
            value={props.port}
            onChange={(event) => {
              const digits = event.target.value.replace(/\D/g, "").slice(0, 5);
              props.onPort(
                Number(digits) > 65535 ? "65535" : digits.replace(/^0+/, ""),
              );
            }}
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
