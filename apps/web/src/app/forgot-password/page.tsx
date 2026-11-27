"use client";

import Link from "next/link";
import { type FormEvent, useId, useState } from "react";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, NetworkError, requestPasswordReset } from "@/lib/api";

function messageOf(error: unknown): string {
  if (error instanceof NetworkError) {
    return "サーバーに接続できませんでした。ネットワークの状態を確認してください。";
  }
  if (error instanceof ApiError) {
    if (error.status === 429) {
      return "試行回数が多すぎます。しばらく待ってからもう一度お試しください。";
    }
    if (error.code === "PASSWORD_LOGIN_DISABLED") {
      return "このサーバーでは、パスワードでのログインが止められているため、パスワードを再設定できません。ログイン画面のほかの方法でログインしてください。";
    }
    if (error.code === "RESET_PASSWORD_DISABLED") {
      return "このサーバーはメールを送信できないため、パスワードを再設定できません。サーバーの管理者に連絡してください。";
    }
  }
  return "メールを送信できませんでした。時間をおいてもう一度お試しください。";
}

/** パスワードを忘れたときに、再設定のリンクをメールで受け取る画面。 */
export default function ForgotPasswordPage() {
  const emailId = useId();
  const errorId = useId();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await requestPasswordReset(email.trim());
      setSentTo(email.trim());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSubmitting(false);
    }
  }

  const back = (
    <p className="mt-6 text-center text-sm">
      <Link href="/login" className="font-medium underline underline-offset-4">
        ログイン画面に戻る
      </Link>
    </p>
  );

  if (sentTo) {
    return (
      <AuthShell lead="メールを確認してください。">
        <div className="mt-8 flex flex-col gap-3 text-sm leading-relaxed">
          <p>
            <span className="break-all font-medium">{sentTo}</span>{" "}
            が登録されていれば、パスワードを再設定するためのリンクをメールで送りました。
          </p>
          <p className="text-muted-foreground">
            リンクの有効期限は 1
            時間です。届かないときは、迷惑メールのフォルダと、入力したメールアドレスを確認してください。
          </p>
        </div>
        {back}
      </AuthShell>
    );
  }

  return (
    <AuthShell lead="ログインに使っているメールアドレスを入力してください。パスワードを再設定するためのリンクをメールで送ります。">
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
        {error && (
          <p id={errorId} role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" disabled={submitting}>
          {submitting ? "送信中…" : "再設定のメールを送る"}
        </Button>
      </form>
      {back}
    </AuthShell>
  );
}
