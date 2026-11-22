"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { OrbitLogo } from "@/components/brand/orbit-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, NetworkError } from "@/lib/api";
import { apiUrl, isBundledApp } from "@/lib/server-url";

function messageOf(error: unknown): string {
  if (error instanceof NetworkError) {
    return "サーバーに接続できませんでした。ネットワークの状態を確認してください。";
  }
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 400) {
      return "メールアドレスまたはパスワードが正しくありません。";
    }
    if (error.status === 429) {
      return "試行回数が多すぎます。しばらく待ってからもう一度お試しください。";
    }
  }
  return "ログインできませんでした。時間をおいてもう一度お試しください。";
}

export default function LoginPage() {
  const { signIn } = useAuth();
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 同梱アプリでは、どのサーバーにログインするのかを見せて変更できるようにする。
  // 静的に書き出した HTML と食い違わないよう、表示は読み込み後に決める。
  const [server, setServer] = useState<string | null>(null);
  useEffect(() => {
    if (isBundledApp()) setServer(new URL(apiUrl()).host);
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email.trim(), password);
      // 成功すると AuthGate が受信トレイへ移す。
    } catch (cause) {
      setError(messageOf(cause));
      setSubmitting(false);
    }
  }

  return (
    <main className="relative flex flex-1 flex-col items-center justify-center p-6">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <h1>
          <OrbitLogo className="h-11" />
        </h1>
        <p className="mt-4 text-muted-foreground text-sm">
          アカウントにログインしてください。
        </p>
        <form
          onSubmit={handleSubmit}
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
      </div>
    </main>
  );
}
