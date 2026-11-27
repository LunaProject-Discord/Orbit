"use client";

import { KeyRoundIcon, LogInIcon } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { AuthShell } from "@/components/auth-shell";
import {
  BackupCodeInput,
  formatBackupCode,
  TotpInput,
} from "@/components/one-time-code-input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ApiError,
  fetchAuthFeatures,
  NetworkError,
  type SsoProviderOption,
  startSsoLogin,
} from "@/lib/api";
import { usesAppOAuth } from "@/lib/native/oauth";
import { PasskeyCancelled, passkeySupported } from "@/lib/passkey";
import { apiUrl, isBundledApp } from "@/lib/server-url";

const NETWORK_MESSAGE =
  "サーバーに接続できませんでした。ネットワークの状態を確認してください。";
const RATE_MESSAGE =
  "試行回数が多すぎます。しばらく待ってからもう一度お試しください。";

function messageOf(error: unknown): string {
  if (error instanceof NetworkError) return NETWORK_MESSAGE;
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 400) {
      return "メールアドレスまたはパスワードが正しくありません。";
    }
    if (error.status === 429) return RATE_MESSAGE;
  }
  return "ログインできませんでした。時間をおいてもう一度お試しください。";
}

function twoFactorMessageOf(error: unknown): {
  message: string;
  /** コードの入力をやり直せない (パスワードの入力からやり直す)。 */
  restart: boolean;
} {
  if (error instanceof NetworkError) {
    return { message: NETWORK_MESSAGE, restart: false };
  }
  if (error instanceof ApiError) {
    switch (error.code) {
      case "INVALID_CODE":
      case "INVALID_BACKUP_CODE":
        return { message: "コードが正しくありません。", restart: false };
      case "ACCOUNT_TEMPORARILY_LOCKED":
        return {
          message:
            "コードの間違いが続いたため、しばらくログインできません。15 分ほど待ってからお試しください。",
          restart: true,
        };
      case "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE":
      case "INVALID_TWO_FACTOR_COOKIE":
        return {
          message:
            "時間が経過したか、入力の間違いが続きました。最初からやり直してください。",
          restart: true,
        };
    }
    if (error.status === 429) return { message: RATE_MESSAGE, restart: false };
  }
  return {
    message: "確認できませんでした。時間をおいてもう一度お試しください。",
    restart: false,
  };
}

function passkeyMessageOf(error: unknown): string | null {
  if (error instanceof PasskeyCancelled) return null;
  if (error instanceof NetworkError) return NETWORK_MESSAGE;
  if (error instanceof ApiError) {
    if (error.status === 429) return RATE_MESSAGE;
    if (error.code === "PASSKEY_NOT_FOUND") {
      return "このパスキーは登録されていません。パスワードでログインしてください。";
    }
  }
  return "パスキーでログインできませんでした。パスワードでログインしてください。";
}

function ssoStartMessageOf(error: unknown): string {
  if (error instanceof NetworkError) return NETWORK_MESSAGE;
  if (error instanceof ApiError) {
    if (error.status === 429) return RATE_MESSAGE;
    if (error.code === "provider_unavailable") {
      return "このログイン方法は現在使えません。管理者にお問い合わせください。";
    }
    if (error.code === "provider_unreachable") {
      return "ログイン先のサービスに接続できませんでした。時間をおいてもう一度お試しください。";
    }
  }
  return "ログインを始められませんでした。時間をおいてもう一度お試しください。";
}

/** メールのリンクなどから戻ってきたときに、URL に付いている知らせ。 */
function noticeOf(search: string): { text: string; error: boolean } | null {
  const params = new URLSearchParams(search);
  const error = params.get("error");
  if (error === "TOKEN_EXPIRED") {
    return {
      text: "リンクの有効期限が切れています。もう一度やり直してください。",
      error: true,
    };
  }
  if (error) {
    return {
      text: "リンクが正しくないか、すでに使われています。もう一度やり直してください。",
      error: true,
    };
  }
  switch (params.get("notice")) {
    case "email-changed":
      return {
        text: "メールアドレスを変更しました。新しいメールアドレスでログインしてください。",
        error: false,
      };
    case "registered":
      return {
        text: "登録が完了しました。登録したメールアドレスとパスワードでログインしてください。",
        error: false,
      };
    case "password-reset":
      return {
        text: "パスワードを再設定しました。新しいパスワードでログインしてください。",
        error: false,
      };
    default:
      return null;
  }
}

export default function LoginPage() {
  const { signIn, verifyTwoFactor, signInWithPasskey } = useAuth();
  const emailId = useId();
  const passwordId = useId();
  const codeId = useId();
  const trustId = useId();
  const errorId = useId();
  const [step, setStep] = useState<"password" | "two-factor">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [codeKind, setCodeKind] = useState<"totp" | "backup">("totp");
  const [code, setCode] = useState("");
  const codeFormRef = useRef<HTMLFormElement>(null);
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 同梱アプリでは、どのサーバーにログインするのかを見せて変更できるようにする。
  // 静的に書き出した HTML と食い違わないよう、表示は読み込み後に決める。
  const [server, setServer] = useState<string | null>(null);
  const [canPasskey, setCanPasskey] = useState(false);
  const [canReset, setCanReset] = useState(false);
  const [ssoProviders, setSsoProviders] = useState<SsoProviderOption[]>([]);
  const [notice, setNotice] = useState<ReturnType<typeof noticeOf>>(null);
  useEffect(() => {
    if (isBundledApp()) setServer(new URL(apiUrl()).host);
    setCanPasskey(passkeySupported());
    setNotice(noticeOf(window.location.search));
    // IdP でログインしたあと、2 段階認証のコードを求められたとき (/oauth/sso から来る)。
    if (
      new URLSearchParams(window.location.search).get("step") === "two-factor"
    ) {
      setStep("two-factor");
      window.history.replaceState(null, "", window.location.pathname);
    }
    const controller = new AbortController();
    fetchAuthFeatures(controller.signal)
      .then((features) => {
        setCanReset(features.mail);
        setSsoProviders(features.sso);
      })
      .catch(() => {
        // 届かないときは、再設定の案内を出さない。
      });
    return () => controller.abort();
  }, []);

  async function handlePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await signIn(email.trim(), password);
      // 成功すると AuthGate が受信トレイへ移す。
      if (result === "two-factor") {
        setStep("two-factor");
        setCodeKind("totp");
        setCode("");
        setSubmitting(false);
      }
    } catch (cause) {
      setError(messageOf(cause));
      setSubmitting(false);
    }
  }

  function backToPassword(message: string | null) {
    setStep("password");
    setPassword("");
    setCode("");
    setError(message);
  }

  // すべての桁が埋まったら、ボタンを押さなくても確認する。
  function submitWhenComplete() {
    if (!submitting) codeFormRef.current?.requestSubmit();
  }

  async function handleCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await verifyTwoFactor(
        codeKind,
        codeKind === "totp" ? code : formatBackupCode(code),
        trustDevice,
      );
    } catch (cause) {
      const { message, restart } = twoFactorMessageOf(cause);
      if (restart) backToPassword(message);
      else {
        // 間違えたコードは消して、すぐに入れ直せるようにする。
        setCode("");
        setError(message);
      }
      setSubmitting(false);
    }
  }

  async function handlePasskey() {
    setError(null);
    setSubmitting(true);
    try {
      await signInWithPasskey();
    } catch (cause) {
      setError(passkeyMessageOf(cause));
      setSubmitting(false);
    }
  }

  async function handleSso(providerId: string) {
    setError(null);
    setSubmitting(true);
    try {
      // 戻り先は /oauth/sso (components/sso-callback.tsx)。
      window.location.assign(await startSsoLogin(providerId));
      // アプリでは外のブラウザーで開き、この画面は残る (取りやめたら押し直せるように)。
      if (usesAppOAuth()) setSubmitting(false);
    } catch (cause) {
      setError(ssoStartMessageOf(cause));
      setSubmitting(false);
    }
  }

  if (step === "two-factor") {
    return (
      <AuthShell
        lead={
          codeKind === "totp"
            ? "認証アプリに表示されている 6 桁のコードを入力してください。"
            : "保存しておいたバックアップコードを 1 つ入力してください。使ったコードは、もう使えません。"
        }
      >
        <form
          ref={codeFormRef}
          onSubmit={handleCode}
          className="mt-8 flex flex-col gap-5"
          aria-describedby={error ? errorId : undefined}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor={codeId}>
              {codeKind === "totp" ? "コード" : "バックアップコード"}
            </Label>
            {codeKind === "totp" ? (
              <TotpInput
                // 種類を切り替えたら、入力欄を作り直してフォーカスを移す。
                key="totp"
                id={codeId}
                autoFocus
                value={code}
                onChange={setCode}
                onComplete={submitWhenComplete}
                invalid={error !== null}
                aria-describedby={error ? errorId : undefined}
              />
            ) : (
              <BackupCodeInput
                key="backup"
                id={codeId}
                autoFocus
                value={code}
                onChange={setCode}
                onComplete={submitWhenComplete}
                invalid={error !== null}
                aria-describedby={error ? errorId : undefined}
              />
            )}
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id={trustId}
              checked={trustDevice}
              onCheckedChange={(checked) => setTrustDevice(checked === true)}
            />
            <Label htmlFor={trustId} className="font-normal">
              この端末では 30 日間コードの入力を省略する
            </Label>
          </div>
          {error && (
            <p id={errorId} role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <Button type="submit" size="lg" disabled={submitting}>
            {submitting ? "確認中…" : "ログイン"}
          </Button>
        </form>
        <div className="mt-6 flex flex-col items-center gap-3 text-sm">
          <button
            type="button"
            className="font-medium underline underline-offset-4"
            onClick={() => {
              setCodeKind(codeKind === "totp" ? "backup" : "totp");
              setCode("");
              setError(null);
            }}
          >
            {codeKind === "totp"
              ? "バックアップコードを使う"
              : "認証アプリのコードを使う"}
          </button>
          <button
            type="button"
            className="text-muted-foreground underline underline-offset-4"
            onClick={() => backToPassword(null)}
          >
            最初からやり直す
          </button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell lead="アカウントにログインしてください。">
      {notice && (
        <p
          role={notice.error ? "alert" : "status"}
          className={
            notice.error
              ? "mt-6 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-destructive text-sm"
              : "mt-6 rounded-lg border bg-muted/50 p-3 text-sm"
          }
        >
          {notice.text}
        </p>
      )}
      <form
        onSubmit={handlePassword}
        className="mt-8 flex flex-col gap-5"
        aria-describedby={error ? errorId : undefined}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor={emailId}>メールアドレス</Label>
          <Input
            id={emailId}
            type="email"
            autoComplete="username"
            required
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={error ? true : undefined}
          />
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor={passwordId}>パスワード</Label>
            {canReset && (
              <Link
                href="/forgot-password"
                className="text-muted-foreground text-sm underline underline-offset-4"
              >
                パスワードを忘れた場合
              </Link>
            )}
          </div>
          <Input
            id={passwordId}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={error ? true : undefined}
          />
        </div>
        {error && (
          <p id={errorId} role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" disabled={submitting}>
          {submitting ? "ログイン中…" : "ログイン"}
        </Button>
      </form>
      {(canPasskey || ssoProviders.length > 0) && (
        <>
          <div className="my-5 flex items-center gap-3 text-muted-foreground text-xs">
            <span className="h-px flex-1 bg-border" />
            または
            <span className="h-px flex-1 bg-border" />
          </div>
          <div className="flex flex-col gap-3">
            {ssoProviders.map((provider) => (
              <Button
                key={provider.id}
                type="button"
                variant="outline"
                size="lg"
                className="w-full"
                disabled={submitting}
                onClick={() => handleSso(provider.id)}
              >
                <LogInIcon />
                <span className="truncate">{provider.name} でログイン</span>
              </Button>
            ))}
            {canPasskey && (
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="w-full"
                disabled={submitting}
                onClick={handlePasskey}
              >
                <KeyRoundIcon />
                パスキーでログイン
              </Button>
            )}
          </div>
        </>
      )}
      {server && (
        <p className="mt-6 text-center text-muted-foreground text-sm">
          接続先: <span className="break-all">{server}</span>{" "}
          <Link
            href="/server"
            className="font-medium text-foreground underline underline-offset-4"
          >
            変更
          </Link>
        </p>
      )}
    </AuthShell>
  );
}
