"use client";

import { KeyRoundIcon } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { useAdminAuth } from "@/components/admin/admin-auth";
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
import { fetchAdminSetup } from "@/lib/admin-api";
import { ApiError, NetworkError } from "@/lib/api";
import { PasskeyCancelled, passkeySupported } from "@/lib/passkey";

const NETWORK_MESSAGE =
  "サーバーに接続できませんでした。ネットワークの状態を確認してください。";
const RATE_MESSAGE =
  "試行回数が多すぎます。しばらく待ってからもう一度お試しください。";

function messageOf(error: unknown): string {
  if (error instanceof NetworkError) return NETWORK_MESSAGE;
  if (error instanceof ApiError) {
    if ([400, 401, 422].includes(error.status)) {
      return "名前またはパスワードが正しくありません。";
    }
    if (error.status === 429) return RATE_MESSAGE;
  }
  return "ログインできませんでした。時間をおいてもう一度お試しください。";
}

function twoFactorMessageOf(error: unknown): {
  message: string;
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
      return "このパスキーは管理者として登録されていません。パスワードでログインしてください。";
    }
  }
  return "パスキーでログインできませんでした。パスワードでログインしてください。";
}

/** 管理画面のログイン。一般の利用者は、ここからはログインできない。 */
export function AdminLogin() {
  const { signIn, verifyTwoFactor, signInWithPasskey } = useAdminAuth();
  const usernameId = useId();
  const passwordId = useId();
  const codeId = useId();
  const trustId = useId();
  const errorId = useId();
  const [step, setStep] = useState<"password" | "two-factor">("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [codeKind, setCodeKind] = useState<"totp" | "backup">("totp");
  const [code, setCode] = useState("");
  const codeFormRef = useRef<HTMLFormElement>(null);
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [canPasskey, setCanPasskey] = useState(false);
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setCanPasskey(passkeySupported());
    if (new URLSearchParams(window.location.search).get("notice") === "setup") {
      setNotice(
        "管理者を作りました。決めた名前とパスワードでログインしてください。",
      );
    }
    const controller = new AbortController();
    fetchAdminSetup(controller.signal)
      .then((result) => setSetupNeeded(result.needed))
      .catch(() => {
        // 届かないときは、セットアップの案内を出さない。
      });
    return () => controller.abort();
  }, []);

  async function handlePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await signIn(username.trim(), password);
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

  if (step === "two-factor") {
    return (
      <AuthShell
        brand="orbit"
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
    <AuthShell
      brand="orbit"
      lead="管理画面です。管理者のアカウントでログインしてください。"
    >
      {notice && (
        <output className="mt-6 block rounded-lg border bg-muted/50 p-3 text-sm">
          {notice}
        </output>
      )}
      {setupNeeded && (
        <div
          className="mt-6 rounded-lg border bg-muted/50 p-3 text-sm"
          data-setup-notice
        >
          <p>管理者がまだいません。最初の管理者を作ってください。</p>
          <Link
            href="/admin/setup"
            className="mt-1 inline-block font-medium underline underline-offset-4"
          >
            初回セットアップへ
          </Link>
        </div>
      )}
      <form
        onSubmit={handlePassword}
        className="mt-8 flex flex-col gap-5"
        aria-describedby={error ? errorId : undefined}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor={usernameId}>名前</Label>
          <Input
            id={usernameId}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            autoFocus
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            aria-invalid={error ? true : undefined}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={passwordId}>パスワード</Label>
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
      {canPasskey && (
        <>
          <div className="my-5 flex items-center gap-3 text-muted-foreground text-xs">
            <span className="h-px flex-1 bg-border" />
            または
            <span className="h-px flex-1 bg-border" />
          </div>
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
        </>
      )}
      <p className="mt-6 text-center text-muted-foreground text-sm">
        Orbit を使う方 (管理者以外) は{" "}
        <a
          href="/login"
          className="font-medium text-foreground underline underline-offset-4"
        >
          こちらからログイン
        </a>
      </p>
    </AuthShell>
  );
}
