"use client";

import {
  ChevronLeftIcon,
  CircleCheckIcon,
  InfoIcon,
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

/**
 * 画面の段階。
 * - email: 名前 (任意) とメールアドレス。ここで設定を自動で探す。
 * - oauth: Google / Microsoft のアカウントと分かったとき。それぞれのログインへ進む。
 * - password: パスワード (iCloud ならアプリ用パスワード) と、見つかった設定。
 */
type Step = "email" | "oauth" | "password";

/** password の段階で、見つかった設定を一覧で見せるか (review)、入力欄で見せるか (edit)。 */
type ServerPhase = "review" | "edit";

/** パスワードで追加するときの種類。 */
type PasswordKind = "icloud" | "gmail" | "generic";

const OAUTH_NAMES: Record<OAuthProvider, string> = {
  google: "Google",
  microsoft: "Microsoft",
};

function oauthOf(settings: DiscoveredSettings | null): OAuthProvider | null {
  if (settings?.provider === "gmail") return "google";
  if (settings?.provider === "microsoft") return "microsoft";
  return null;
}

function passwordKindOf(settings: DiscoveredSettings | null): PasswordKind {
  if (settings?.provider === "icloud") return "icloud";
  if (settings?.provider === "gmail") return "gmail";
  return "generic";
}

function messageOf(error: unknown, kind: PasswordKind): string {
  if (error instanceof NetworkError) {
    return "サーバーに接続できませんでした。ネットワークの状態を確認してください。";
  }
  if (error instanceof ApiError) {
    const body = (error.body ?? {}) as { host?: string; detail?: string };
    const detail = body.detail ? ` (${body.detail})` : "";
    switch (error.code) {
      case "auth_failed":
        return kind === "icloud"
          ? "iCloud にログインできませんでした。メールアドレスとアプリ用パスワードを確認してください (Apple Account のパスワードではログインできません)。"
          : kind === "gmail"
            ? "Gmail にログインできませんでした。Google アカウントのパスワードではなく、アプリ パスワードを入力してください。"
            : "メールサーバーにログインできませんでした。ユーザー名とパスワードを確認してください。";
      case "connection_failed":
        return kind === "icloud"
          ? `iCloud のメールサーバーに接続できませんでした。時間をおいてもう一度お試しください。${detail}`
          : `受信 (IMAP) サーバーに接続できませんでした。サーバー、ポート番号、セキュリティを確認してください。${detail}`;
      case "smtp_auth_failed":
        return "送信 (SMTP) サーバーにログインできませんでした。「設定を編集」からユーザー名と送信サーバーの設定を確認してください。";
      case "smtp_connection_failed":
        return `送信 (SMTP) サーバーに接続できませんでした。「設定を編集」からサーバー、ポート番号、セキュリティを確認してください。${detail}`;
      case "legacy_tls_required":
        return "このメールサーバーは、古い方式の TLS にしか対応していません。接続するには、下の「古い TLS のサーバーへの接続を許可する」をオンにして、もう一度「追加」を押してください。";
      case "account_exists":
        return "このメールアドレスはすでに追加されています。";
      case "host_not_allowed":
        return `このホストには接続できません${body.host ? `: ${body.host}` : ""}。`;
      case "microsoft_not_configured":
        return "このサーバーでは Microsoft でのログインが設定されていません。サーバーの管理者に確認してください。";
      case "google_not_configured":
        return "このサーバーでは Google でのログインが設定されていません。サーバーの管理者に確認するか、「アプリ パスワードで追加する」を選んでください。";
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

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (account: Account) => void;
};

export function AddAccountDialog({ open, onOpenChange, onCreated }: Props) {
  const id = useId();
  const [step, setStep] = useState<Step>("email");
  const [form, setForm] = useState(initialForm);
  const [phase, setPhase] = useState<ServerPhase>("review");
  /** 自動で見つかった設定。見つからなければ null。 */
  const [discovered, setDiscovered] = useState<DiscoveredSettings | null>(null);
  const [discovering, setDiscovering] = useState(false);
  /** 設定を探したメールアドレス。同じアドレスのまま進んだら、手直しした設定を残す。 */
  const [discoveredFor, setDiscoveredFor] = useState<string | null>(null);
  /** Google / Microsoft のアカウントでも、パスワードで追加することにした。 */
  const [passwordInstead, setPasswordInstead] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 古い TLS のサーバーだと分かったときだけ、許可のスイッチを出す。 */
  const [legacyTlsOffered, setLegacyTlsOffered] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** ログイン画面へ移動中のサービス。 */
  const [redirecting, setRedirecting] = useState<OAuthProvider | null>(null);
  const busy = submitting || discovering || redirecting !== null;
  const email = form.email.trim();
  const displayName = form.displayName.trim();
  const oauth = oauthOf(discovered);
  const kind = passwordKindOf(discovered);

  async function handleOAuth(provider: OAuthProvider, withEmail = true) {
    setError(null);
    setRedirecting(provider);
    try {
      // ログイン画面へ移動する。ログイン後は /oauth/google などに戻ってくる。
      window.location.assign(
        await startOAuthLogin(
          provider,
          undefined,
          withEmail ? { email, displayName } : {},
        ),
      );
      // スマホアプリとデスクトップ版では、ログイン画面はアプリの外のブラウザーで開き、この画面は残る。
      // ログインをやめて戻ってきたときに、もう一度押せるようにしておく。
      if (usesAppOAuth()) setRedirecting(null);
    } catch (cause) {
      setError(messageOf(cause, kind));
      setRedirecting(null);
    }
  }

  const set = <K extends keyof typeof initialForm>(
    key: K,
    value: (typeof initialForm)[K],
  ) => setForm((current) => ({ ...current, [key]: value }));

  function reset() {
    setStep("email");
    setForm(initialForm);
    setPhase("review");
    setDiscovered(null);
    setDiscoveredFor(null);
    setPasswordInstead(false);
    setLegacyTlsOffered(false);
    setError(null);
  }

  function back() {
    if (busy) return;
    setError(null);
    setLegacyTlsOffered(false);
    // Google / Microsoft のアカウントでパスワードを選んだあとは、ログインの案内へ戻る。
    if (step === "password" && oauth && passwordInstead) {
      setPasswordInstead(false);
      setStep("oauth");
      return;
    }
    setStep("email");
  }

  function handleOpenChange(next: boolean) {
    if (busy) return;
    if (!next) reset();
    onOpenChange(next);
  }

  /** 見つかった設定に合わせて、次の段階へ進む。 */
  function proceed(found: DiscoveredSettings | null) {
    if (oauthOf(found) && !passwordInstead) {
      setStep("oauth");
      return;
    }
    setPhase(found ? "review" : "edit");
    setStep("password");
  }

  /** メールアドレスのドメインから設定を探す。 */
  async function discover() {
    if (discoveredFor === email) {
      proceed(discovered);
      return;
    }
    setDiscovering(true);
    let found: DiscoveredSettings | null = null;
    try {
      found = await discoverAccountSettings(email);
    } catch (cause) {
      // 探せなくても、手で入力すれば追加できる。オフラインのときだけ知らせる。
      if (cause instanceof NetworkError) {
        setError(messageOf(cause, "generic"));
        setDiscovering(false);
        return;
      }
    }
    setDiscovering(false);
    setDiscovered(found);
    setDiscoveredFor(email);
    setPasswordInstead(false);
    setLegacyTlsOffered(false);
    setForm((current) => ({
      ...current,
      username: found?.imap.username ?? email,
      imap: found ? serverFormOf(found.imap) : guessServerForm("imap", email),
      smtp: found ? serverFormOf(found.smtp) : guessServerForm("smtp", email),
      allowLegacyTls: false,
    }));
    if (oauthOf(found)) {
      setStep("oauth");
    } else {
      setPhase(found ? "review" : "edit");
      setStep("password");
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (step === "email") {
      await discover();
      return;
    }
    if (step !== "password") return;
    setSubmitting(true);
    try {
      const common = { email, ...(displayName ? { displayName } : {}) };
      const account = await createAccount(
        kind === "icloud"
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
              // Google のアプリ パスワードも 4 文字ごとの空白入りで表示される。
              password:
                kind === "gmail"
                  ? form.password.replace(/\s+/g, "")
                  : form.password,
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
      setError(messageOf(cause, kind));
      setSubmitting(false);
    }
  }

  const alert = error && (
    <p role="alert" className="text-destructive text-sm">
      {error}
    </p>
  );

  /** 2 段階目以降で、入力したアドレスを見せて、変えたいときに戻れるようにする。 */
  const addressBar = (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-sm">{email}</p>
        {displayName && (
          <p className="truncate text-muted-foreground text-xs">
            {displayName}
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
          setStep("email");
        }}
      >
        変更
      </Button>
    </div>
  );

  const title =
    step === "oauth" && oauth
      ? `${OAUTH_NAMES[oauth]} のアカウントを追加`
      : step === "password" && kind === "icloud"
        ? "iCloud のアカウントを追加"
        : step === "password" && kind === "gmail"
          ? "Gmail をアプリ パスワードで追加"
          : "メールアカウントを追加";
  const description =
    step === "email"
      ? "名前とメールアドレスを入力してください。アドレスに合わせて、ログイン方法とサーバーの設定を自動で選びます。"
      : step === "oauth"
        ? "このアドレスは、パスワードの代わりにサービスのログイン画面で追加します。"
        : kind === "icloud"
          ? "このアプリ専用に作ったアプリ用パスワードを入力してください。"
          : "パスワードを入力してください。受信と送信のサーバーへ接続できるかを確認してから追加します。";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto sm:max-w-[560px]"
      >
        <DialogHeader>
          <DialogTitle className="font-semibold text-lg">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          {step === "email" && (
            <>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`${id}-display-name`}>名前 (任意)</Label>
                  <Input
                    id={`${id}-display-name`}
                    maxLength={200}
                    autoComplete="off"
                    placeholder="仕事、個人 など"
                    value={form.displayName}
                    onChange={(event) => set("displayName", event.target.value)}
                  />
                  <p className="text-muted-foreground text-xs">
                    アカウントの一覧に出す名前です。あとから設定で変えられます。
                  </p>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`${id}-email`}>メールアドレス</Label>
                  <Input
                    id={`${id}-email`}
                    type="email"
                    required
                    autoComplete="email"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="name@example.com"
                    value={form.email}
                    onChange={(event) => set("email", event.target.value)}
                  />
                </div>
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
                <Button type="submit" disabled={busy}>
                  {discovering ? "設定を探しています…" : "続ける"}
                </Button>
              </DialogFooter>
              <p className="text-center text-muted-foreground text-xs">
                アドレスを入れずに{" "}
                <button
                  type="button"
                  disabled={busy}
                  className="text-foreground underline underline-offset-2 disabled:opacity-60"
                  onClick={() => void handleOAuth("google", false)}
                >
                  Google でログイン
                </button>{" "}
                ・{" "}
                <button
                  type="button"
                  disabled={busy}
                  className="text-foreground underline underline-offset-2 disabled:opacity-60"
                  onClick={() => void handleOAuth("microsoft", false)}
                >
                  Microsoft でログイン
                </button>
              </p>
            </>
          )}

          {step === "oauth" && oauth && (
            <>
              {addressBar}
              <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4">
                <p className="text-sm leading-relaxed">
                  {oauth === "google"
                    ? "Gmail (Google アカウント) のアドレスです。Google のログイン画面でログインし、メールへのアクセスを許可してください。"
                    : "Microsoft 365 / Outlook.com のアドレスです。Microsoft のログイン画面でログインし、メールへのアクセスを許可してください。"}
                </p>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleOAuth(oauth)}
                >
                  {redirecting
                    ? "ログイン画面へ移動中…"
                    : `${OAUTH_NAMES[oauth]} でログイン`}
                </Button>
              </div>
              {alert}
              <DialogFooter className="gap-2 sm:justify-between">
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  disabled={busy}
                  className="px-0"
                  onClick={() => {
                    setError(null);
                    setPasswordInstead(true);
                    setPhase("review");
                    setStep("password");
                  }}
                >
                  {oauth === "google"
                    ? "アプリ パスワードで追加する"
                    : "パスワード (IMAP) で追加する"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={back}
                >
                  <ChevronLeftIcon data-icon="inline-start" />
                  戻る
                </Button>
              </DialogFooter>
            </>
          )}

          {step === "password" && (
            <>
              {addressBar}
              {kind === "generic" && !oauth && (
                <DiscoveryNotice discovered={discovered} />
              )}
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-password`}>
                  {kind === "icloud"
                    ? "アプリ用パスワード"
                    : kind === "gmail"
                      ? "アプリ パスワード"
                      : "パスワード"}
                </Label>
                <Input
                  id={`${id}-password`}
                  type="password"
                  required
                  autoComplete={kind === "generic" ? "current-password" : "off"}
                  placeholder={
                    kind === "icloud"
                      ? "xxxx-xxxx-xxxx-xxxx"
                      : kind === "gmail"
                        ? "xxxx xxxx xxxx xxxx"
                        : undefined
                  }
                  value={form.password}
                  onChange={(event) => set("password", event.target.value)}
                />
                {kind === "icloud" && (
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
                )}
                {kind === "gmail" && (
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    Google アカウントのパスワードではログインできません。
                    <a
                      href="https://myaccount.google.com/apppasswords"
                      target="_blank"
                      rel="noreferrer"
                      className="text-foreground underline underline-offset-2"
                    >
                      myaccount.google.com/apppasswords
                    </a>{" "}
                    でアプリ パスワードを作成してください (2
                    段階認証プロセスが必要です)。
                  </p>
                )}
              </div>

              {kind !== "icloud" && phase === "review" && (
                <div className="flex flex-col gap-2">
                  <ServerSummary
                    imap={form.imap}
                    smtp={form.smtp}
                    username={form.username}
                    auth={{ imap: "password", smtp: "password" }}
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

              {kind !== "icloud" && phase === "edit" && (
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
                    onCheckedChange={(checked) =>
                      set("allowLegacyTls", checked)
                    }
                  />
                </div>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={back}
                >
                  <ChevronLeftIcon data-icon="inline-start" />
                  戻る
                </Button>
                <Button type="submit" disabled={busy}>
                  {submitting ? "接続を確認中…" : "追加"}
                </Button>
              </DialogFooter>
            </>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 設定が見つかったかどうかの案内。 */
function DiscoveryNotice({
  discovered,
}: {
  discovered: DiscoveredSettings | null;
}) {
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
      {discovered.imap.auth === "oauth2" && (
        <p className="text-muted-foreground text-xs leading-relaxed">
          このメールサービスは OAuth2
          でのログインを求めています。パスワードでは接続できない場合があります。
        </p>
      )}
    </div>
  );
}
