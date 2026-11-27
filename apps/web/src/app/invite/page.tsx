"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { AuthShell, MIN_PASSWORD_LENGTH } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ApiError,
  acceptInvitation,
  lookupInvitation,
  NetworkError,
} from "@/lib/api";

function messageOf(error: unknown): string {
  if (error instanceof NetworkError) {
    return "サーバーに接続できませんでした。ネットワークの状態を確認してください。";
  }
  if (error instanceof ApiError) {
    switch (error.code) {
      case "invalid_invitation":
        return "この招待リンクは、期限が切れているか、すでに使われています。招待した人に、新しいリンクの発行を依頼してください。";
      case "password_login_disabled":
        return "このサーバーでは、パスワードでのログインが止められているため、招待リンクから登録できません。ログイン画面のほかの方法でログインしてください。";
      case "email_mismatch":
        return "この招待は、別のメールアドレス用です。招待されたメールアドレスを入力してください。";
      case "email_taken":
        return "このメールアドレスは、すでに登録されています。ログイン画面からログインしてください。";
      case "password_too_short":
        return `パスワードは ${MIN_PASSWORD_LENGTH} 文字以上にしてください。`;
      case "password_too_long":
        return "パスワードが長すぎます。";
    }
    if (error.status === 400) {
      return "入力した内容を確認してください。";
    }
  }
  return "登録できませんでした。時間をおいてもう一度お試しください。";
}

type Lookup =
  /** 読み込み前 (静的に書き出した HTML と食い違わないよう、読み込み後に URL を読む)。 */
  | { status: "loading" }
  | { status: "invalid" }
  /** パスワードでのログインが止められていて、パスワードでは登録できない。 */
  | { status: "password-disabled" }
  | { status: "unreachable" }
  | { status: "ready"; token: string; email: string | null };

/** 招待リンクから開く、利用者を登録する画面。 */
export default function InvitePage() {
  const auth = useAuth();
  const router = useRouter();
  const nameId = useId();
  const emailId = useId();
  const passwordId = useId();
  const confirmId = useId();
  const errorId = useId();
  const [lookup, setLookup] = useState<Lookup>({ status: "loading" });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /** URL から読んだ合言葉。undefined は読む前。 */
  const tokenRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    // 合言葉を URL から消したあとにもう一度呼ばれても (開発時の二重実行)、読んだ値を保つ。
    if (tokenRef.current === undefined) {
      tokenRef.current = new URLSearchParams(window.location.search).get(
        "token",
      );
      // 合言葉を、履歴やほかのサイトへ送る参照元 (Referer) に残さない。
      if (tokenRef.current) {
        window.history.replaceState(null, "", window.location.pathname);
      }
    }
    const token = tokenRef.current;
    if (!token) {
      setLookup({ status: "invalid" });
      return;
    }
    let cancelled = false;
    lookupInvitation(token)
      .then((invitation) => {
        if (cancelled) return;
        setLookup({ status: "ready", token, email: invitation.email });
        if (invitation.email) setEmail(invitation.email);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLookup({
          status:
            cause instanceof ApiError && cause.status === 404
              ? "invalid"
              : cause instanceof ApiError &&
                  cause.code === "password_login_disabled"
                ? "password-disabled"
                : "unreachable",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lookup.status !== "ready") return;
    if (password !== confirm) {
      setError("確認用のパスワードが一致しません。");
      return;
    }
    setError(null);
    setSubmitting(true);
    const address = email.trim();
    try {
      await acceptInvitation({
        token: lookup.token,
        name: name.trim(),
        email: address,
        password,
      });
    } catch (cause) {
      setError(messageOf(cause));
      setSubmitting(false);
      return;
    }
    // 登録できたら、そのままログインする。うまくいかなければ、ログイン画面から入ってもらう。
    try {
      await auth.signIn(address, password);
      router.replace("/");
    } catch {
      router.replace("/login?notice=registered");
    }
  }

  if (lookup.status === "loading") {
    return (
      <main
        className="flex flex-1 items-center justify-center p-8"
        aria-busy="true"
      >
        <output className="text-muted-foreground text-sm">読み込み中…</output>
      </main>
    );
  }

  if (auth.status === "signed-in" && !submitting) {
    return (
      <AuthShell lead="すでにログインしています。">
        <p className="mt-8 text-sm leading-relaxed">
          {auth.user.email}{" "}
          としてログイン中です。招待リンクで新しく登録するには、先にログアウトしてから、もう一度リンクを開いてください。
        </p>
        <p className="mt-6 text-center text-sm">
          <Link href="/" className="font-medium underline underline-offset-4">
            Orbit を開く
          </Link>
        </p>
      </AuthShell>
    );
  }

  if (lookup.status !== "ready") {
    return (
      <AuthShell
        lead={
          lookup.status === "unreachable"
            ? "サーバーに接続できませんでした。"
            : "この招待リンクは使えません。"
        }
      >
        <p className="mt-8 text-sm leading-relaxed">
          {lookup.status === "invalid"
            ? "期限が切れているか、すでに使われています。招待した人に、新しいリンクの発行を依頼してください。"
            : lookup.status === "password-disabled"
              ? "このサーバーでは、パスワードでのログインが止められているため、招待リンクから登録できません。ログイン画面のほかの方法 (シングルサインオンなど) でログインしてください。"
              : "ネットワークの状態を確認して、もう一度リンクを開いてください。"}
        </p>
        <p className="mt-6 text-center text-sm">
          <Link
            href="/login"
            className="font-medium underline underline-offset-4"
          >
            ログイン画面へ
          </Link>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell lead="Orbit に招待されました。名前、ログインに使うメールアドレス、パスワードを決めて登録してください。">
      <form
        onSubmit={handleSubmit}
        className="mt-8 flex flex-col gap-5"
        aria-describedby={error ? errorId : undefined}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor={nameId}>名前</Label>
          <Input
            id={nameId}
            autoComplete="name"
            required
            autoFocus
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={emailId}>メールアドレス</Label>
          <Input
            id={emailId}
            type="email"
            autoComplete="username"
            required
            maxLength={320}
            readOnly={lookup.email !== null}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <p className="text-muted-foreground text-xs leading-relaxed">
            {lookup.email !== null
              ? "この招待は、このメールアドレス用です。"
              : "Orbit へのログインに使います。Orbit で読み書きするメールアカウント (Gmail など) は、登録のあとで追加します。"}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={passwordId}>
            パスワード ({MIN_PASSWORD_LENGTH} 文字以上)
          </Label>
          <Input
            id={passwordId}
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={error ? true : undefined}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={confirmId}>パスワード (確認)</Label>
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
          {submitting ? "登録中…" : "登録する"}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm">
        <Link
          href="/login"
          className="font-medium underline underline-offset-4"
        >
          ログイン画面へ
        </Link>
      </p>
    </AuthShell>
  );
}
