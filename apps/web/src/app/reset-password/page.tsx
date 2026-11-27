"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { AuthShell, MIN_PASSWORD_LENGTH } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ApiError,
  forgetSession,
  NetworkError,
  resetPassword,
} from "@/lib/api";

function messageOf(error: unknown): string {
  if (error instanceof NetworkError) {
    return "サーバーに接続できませんでした。ネットワークの状態を確認してください。";
  }
  if (error instanceof ApiError) {
    if (error.code === "PASSWORD_LOGIN_DISABLED") {
      return "このサーバーでは、パスワードでのログインが止められているため、パスワードを再設定できません。ログイン画面のほかの方法でログインしてください。";
    }
    if (error.code === "INVALID_TOKEN") {
      return "リンクの有効期限が切れているか、すでに使われています。もう一度、再設定をやり直してください。";
    }
    if (error.code === "PASSWORD_TOO_SHORT") {
      return `パスワードは ${MIN_PASSWORD_LENGTH} 文字以上にしてください。`;
    }
    if (error.code === "PASSWORD_TOO_LONG") {
      return "パスワードが長すぎます。";
    }
    if (error.status === 429) {
      return "試行回数が多すぎます。しばらく待ってからもう一度お試しください。";
    }
  }
  return "再設定できませんでした。時間をおいてもう一度お試しください。";
}

/** メールのリンクから開く、新しいパスワードを設定する画面。 */
export default function ResetPasswordPage() {
  const auth = useAuth();
  const router = useRouter();
  const passwordId = useId();
  const confirmId = useId();
  const errorId = useId();
  /** undefined は読み込み前 (静的に書き出した HTML と食い違わないよう、読み込み後に URL を読む)。null は合言葉なし。 */
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const found = new URLSearchParams(window.location.search).get("token");
    // 合言葉を URL から消したあとにもう一度呼ばれても (開発時の二重実行)、読んだ値を保つ。
    setToken((current) => current ?? found);
    // 合言葉を、履歴やほかのサイトへ送る参照元 (Referer) に残さない。
    if (found) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    if (password !== confirm) {
      setError("確認用のパスワードが一致しません。");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await resetPassword(token, password);
      // サーバーは、どの端末のセッションも無効にする。この端末のログイン情報も捨てて、ログインし直す。
      forgetSession();
      auth.reset();
      router.replace("/login?notice=password-reset");
    } catch (cause) {
      setError(messageOf(cause));
      setSubmitting(false);
    }
  }

  if (token === undefined) {
    return (
      <main
        className="flex flex-1 items-center justify-center p-8"
        aria-busy="true"
      >
        <output className="text-muted-foreground text-sm">読み込み中…</output>
      </main>
    );
  }

  if (!token) {
    return (
      <AuthShell lead="このリンクは使えません。">
        <p className="mt-8 text-sm leading-relaxed">
          メールに書かれたリンクを、もう一度開いてください。うまくいかないときは、再設定をやり直してください。
        </p>
        <p className="mt-6 text-center text-sm">
          <Link
            href="/forgot-password"
            className="font-medium underline underline-offset-4"
          >
            再設定をやり直す
          </Link>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      lead={`新しいパスワードを設定してください (${MIN_PASSWORD_LENGTH} 文字以上)。設定すると、ログイン中のすべての端末からログアウトされます。`}
    >
      <form
        onSubmit={handleSubmit}
        className="mt-8 flex flex-col gap-5"
        aria-describedby={error ? errorId : undefined}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor={passwordId}>新しいパスワード</Label>
          <Input
            id={passwordId}
            type="password"
            autoComplete="new-password"
            required
            autoFocus
            minLength={MIN_PASSWORD_LENGTH}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={error ? true : undefined}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={confirmId}>新しいパスワード (確認)</Label>
          <Input
            id={confirmId}
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            aria-invalid={error ? true : undefined}
          />
        </div>
        {error && (
          <p id={errorId} role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" disabled={submitting}>
          {submitting ? "設定中…" : "パスワードを設定する"}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm">
        <Link
          href="/login"
          className="font-medium underline underline-offset-4"
        >
          ログイン画面に戻る
        </Link>
      </p>
    </AuthShell>
  );
}
