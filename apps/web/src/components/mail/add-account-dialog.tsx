"use client";

import { cn } from "cn";
import {
  ChevronLeftIcon,
  CircleCheckIcon,
  InfoIcon,
  MailIcon,
  PencilIcon,
} from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import {
  discoverySourceLabel,
  guessServerForm,
  ServerFields,
  ServerSummary,
  serverFormOf,
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
  ApiError,
  createAccount,
  type DiscoveredSettings,
  discoverAccountSettings,
  NetworkError,
  type OAuthProvider,
  startOAuthLogin,
} from "@/lib/api";
import { usesAppOAuth } from "@/lib/native/oauth";

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
          : `受信 (IMAP) サーバーに接続できませんでした。サーバー、ポート番号、セキュリティを確認してください。${
              body.detail ? ` (${body.detail})` : ""
            }`;
      case "smtp_auth_failed":
        return "送信 (SMTP) サーバーにログインできませんでした。「設定を編集」からユーザー名と送信サーバーの設定を確認してください。";
      case "smtp_connection_failed":
        return `送信 (SMTP) サーバーに接続できませんでした。「設定を編集」からサーバー、ポート番号、セキュリティを確認してください。${
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
  imap: guessServerForm("imap", ""),
  smtp: guessServerForm("smtp", ""),
  allowLegacyTls: false,
};

/**
 * 「その他のメール」の段階。credentials でメールアドレスとパスワードを受け取り、
 * 設定を探して、見つかれば review (一覧)、見つからないか「設定を編集」なら edit。
 */
type ManualPhase = "credentials" | "review" | "edit";

const descriptions: Record<Step, string> = {
  choose:
    "追加したアカウントはサーバーが常に同期し、すべての端末で同じ状態になります。",
  icloud:
    "iCloud メールのアドレスと、このアプリ専用に作ったアプリ用パスワードを入力してください。",
  manual:
    "メールアドレスとパスワードを入力してください。受信 (IMAP) と送信 (SMTP) の設定を自動で探します。",
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
  const [phase, setPhase] = useState<ManualPhase>("credentials");
  /** 自動で見つかった設定。見つからなければ null。 */
  const [discovered, setDiscovered] = useState<DiscoveredSettings | null>(null);
  const [discovering, setDiscovering] = useState(false);
  /** 設定を探したメールアドレス。同じアドレスのまま進んだら、手直しした設定を残す。 */
  const [discoveredFor, setDiscoveredFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 古い TLS のサーバーだと分かったときだけ、許可のスイッチを出す。 */
  const [legacyTlsOffered, setLegacyTlsOffered] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** ログイン画面へ移動中のサービス。 */
  const [redirecting, setRedirecting] = useState<OAuthProvider | null>(null);
  const busy = submitting || discovering || redirecting !== null;

  async function handleOAuth(provider: OAuthProvider) {
    setError(null);
    setRedirecting(provider);
    try {
      // ログイン画面へ移動する。ログイン後は /oauth/google などに戻ってくる。
      window.location.assign(await startOAuthLogin(provider));
      // スマホアプリとデスクトップ版では、ログイン画面はアプリの外のブラウザーで開き、この画面は残る。
      // ログインをやめて戻ってきたときに、もう一度押せるようにしておく。
      if (usesAppOAuth()) setRedirecting(null);
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
    setPhase("credentials");
    setDiscovered(null);
    setDiscoveredFor(null);
    setLegacyTlsOffered(false);
    setError(null);
  }

  function goTo(next: Step) {
    if (busy) return;
    setError(null);
    setLegacyTlsOffered(false);
    setPhase("credentials");
    setStep(next);
  }

  /** メールアドレスのドメインから設定を探し、一覧か入力欄を出す。 */
  async function discover() {
    const email = form.email.trim();
    if (discoveredFor === email) {
      setPhase(discovered ? "review" : "edit");
      return;
    }
    setDiscovering(true);
    let found: DiscoveredSettings | null = null;
    try {
      found = await discoverAccountSettings(email);
    } catch (cause) {
      // 探せなくても、手で入力すれば追加できる。オフラインのときだけ知らせる。
      if (cause instanceof NetworkError) {
        setError(messageOf(cause, step));
        setDiscovering(false);
        return;
      }
    }
    setDiscovering(false);
    setDiscovered(found);
    setDiscoveredFor(email);
    setForm((current) => ({
      ...current,
      username: found?.imap.username ?? email,
      imap: found ? serverFormOf(found.imap) : guessServerForm("imap", email),
      smtp: found ? serverFormOf(found.smtp) : guessServerForm("smtp", email),
    }));
    setPhase(found ? "review" : "edit");
  }

  function handleOpenChange(next: boolean) {
    if (busy) return;
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (step === "manual" && phase === "credentials") {
      await discover();
      return;
    }
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
              imap: toServerSettings(form.imap),
              smtp: toServerSettings(form.smtp),
              username: form.username.trim() || email,
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
            {phase === "credentials" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {emailField}
                {displayNameField}
                <div className="flex flex-col gap-2 sm:col-span-2">
                  <Label htmlFor={`${id}-password`}>パスワード</Label>
                  <Input
                    id={`${id}-password`}
                    type="password"
                    required
                    autoComplete="new-password"
                    value={form.password}
                    onChange={(event) => set("password", event.target.value)}
                  />
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    パスワードは、設定が見つかったあとの接続の確認にだけ使います。設定を探すときにはどこにも送りません。
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 rounded-lg border px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-sm">
                    {form.email.trim()}
                  </p>
                  {form.displayName.trim() && (
                    <p className="truncate text-muted-foreground text-xs">
                      {form.displayName.trim()}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setPhase("credentials");
                  }}
                >
                  変更
                </Button>
              </div>
            )}

            {phase !== "credentials" && (
              <DiscoveryNotice
                discovered={discovered}
                disabled={busy}
                onOAuth={(provider) => void handleOAuth(provider)}
              />
            )}

            {phase === "review" && (
              <div className="flex flex-col gap-2">
                <ServerSummary
                  imap={form.imap}
                  smtp={form.smtp}
                  username={form.username}
                  auth={
                    discovered
                      ? {
                          imap: discovered.imap.auth,
                          smtp: discovered.smtp.auth,
                        }
                      : undefined
                  }
                />
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    disabled={busy}
                    onClick={() => setPhase("edit")}
                  >
                    <PencilIcon data-icon="inline-start" />
                    設定を編集
                  </Button>
                </div>
              </div>
            )}

            {phase === "edit" && (
              <>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`${id}-username`}>ユーザー名</Label>
                  <Input
                    id={`${id}-username`}
                    required
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={form.username}
                    onChange={(event) => set("username", event.target.value)}
                  />
                </div>
                <ServerFields
                  idPrefix={`${id}-imap`}
                  kind="imap"
                  value={form.imap}
                  onChange={(value) => set("imap", value)}
                  disabled={busy}
                />
                <ServerFields
                  idPrefix={`${id}-smtp`}
                  kind="smtp"
                  value={form.smtp}
                  onChange={(value) => set("smtp", value)}
                  disabled={busy}
                />
              </>
            )}
            {alert}
            {legacyTlsOffered && phase !== "credentials" && (
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
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (phase === "credentials") {
                    goTo("choose");
                  } else {
                    setError(null);
                    setPhase("credentials");
                  }
                }}
              >
                <ChevronLeftIcon data-icon="inline-start" />
                戻る
              </Button>
              <Button type="submit" disabled={busy}>
                {phase === "credentials"
                  ? discovering
                    ? "設定を探しています…"
                    : "続ける"
                  : submitting
                    ? "接続を確認中…"
                    : "追加"}
              </Button>
            </DialogFooter>
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

/** 設定が見つかったかどうかと、Google / Microsoft のログインを勧める案内。 */
function DiscoveryNotice(props: {
  discovered: DiscoveredSettings | null;
  disabled: boolean;
  onOAuth: (provider: OAuthProvider) => void;
}) {
  const { discovered } = props;
  if (!discovered) {
    return (
      <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
        <InfoIcon
          className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden="true"
        />
        <span>
          アカウント設定を自動では見つけられませんでした。メールサービスの案内を見て、受信と送信のサーバーを入力してください。
        </span>
      </p>
    );
  }
  const oauth =
    discovered.provider === "gmail"
      ? ({ provider: "google", name: "Google" } as const)
      : discovered.provider === "microsoft"
        ? ({ provider: "microsoft", name: "Microsoft" } as const)
        : null;
  return (
    <div className="flex flex-col gap-2">
      <output className="flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm">
        <CircleCheckIcon
          className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-hidden="true"
        />
        <span className="min-w-0">
          アカウント設定が自動的に見つかりました。
          <span className="block text-muted-foreground text-xs">
            見つけた場所: {discoverySourceLabel(discovered.source)}
          </span>
        </span>
      </output>
      {oauth ? (
        <div className="flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm sm:flex-row sm:items-center">
          <p className="min-w-0 flex-1 text-muted-foreground text-xs leading-relaxed">
            このアドレスは {oauth.name}{" "}
            のメールです。パスワードではログインできないことが多いので、
            {oauth.name} でログインして追加するのがおすすめです。
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={props.disabled}
            onClick={() => props.onOAuth(oauth.provider)}
          >
            {oauth.name} でログイン
          </Button>
        </div>
      ) : (
        discovered.imap.auth === "oauth2" && (
          <p className="text-muted-foreground text-xs leading-relaxed">
            このメールサービスは OAuth2
            でのログインを求めています。パスワードでは接続できない場合があります。
          </p>
        )
      )}
    </div>
  );
}
