"use client";

import { type FormEvent, useEffect, useId, useState } from "react";
import { AuthShell, MIN_PASSWORD_LENGTH } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchAdminSetup, setupAdmin } from "@/lib/admin-api";
import { ApiError, NetworkError } from "@/lib/api";

/** ログインに使う名前に使える文字 (サーバーの ADMIN_USERNAME_PATTERN と同じ)。 */
const USERNAME_PATTERN = /^[a-z0-9_.-]{3,32}$/;

function messageOf(error: unknown): string {
  if (error instanceof NetworkError) {
    return "サーバーに接続できませんでした。ネットワークの状態を確認してください。";
  }
  if (error instanceof ApiError) {
    switch (error.code) {
      case "invalid_code":
        return "合言葉が正しくありません。サーバーのログに出ている合言葉を入力してください。";
      case "too_many_attempts":
        return "間違いが続いたため、しばらく受け付けません。1 分ほど待ってからお試しください。";
      case "already_set_up":
        return "管理者はすでにいます。管理画面からログインしてください。";
      case "invalid_username":
        return "名前は 3〜32 文字の英小文字・数字・「_」「.」「-」にしてください。";
      case "invalid_name":
        return "表示名を 1〜100 文字で入力してください。";
      case "password_too_short":
        return `パスワードは ${MIN_PASSWORD_LENGTH} 文字以上にしてください。`;
      case "password_too_long":
        return "パスワードは 128 文字以下にしてください。";
    }
  }
  return "管理者を作れませんでした。時間をおいてもう一度お試しください。";
}

/**
 * 初回セットアップ。管理者が 1 人もいないときだけ、最初の管理者を作れる。
 * 第三者に先に作られないよう、サーバーのログに出る合言葉を求める。
 */
export function AdminSetup() {
  const codeId = useId();
  const usernameId = useId();
  const nameId = useId();
  const passwordId = useId();
  const confirmId = useId();
  const errorId = useId();
  const [needed, setNeeded] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [code, setCode] = useState("");
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchAdminSetup(controller.signal)
      .then((result) => setNeeded(result.needed))
      .catch(() => {
        if (!controller.signal.aborted) setLoadError(true);
      });
    return () => controller.abort();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const login = username.trim().toLowerCase();
    if (!USERNAME_PATTERN.test(login)) {
      setError(messageOf(new ApiError(400, "invalid_username", null)));
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(messageOf(new ApiError(400, "password_too_short", null)));
      return;
    }
    if (password !== confirm) {
      setError("確認のパスワードが一致しません。");
      return;
    }
    setSubmitting(true);
    try {
      await setupAdmin({ code, username: login, name: name.trim(), password });
      window.location.replace("/admin?notice=setup");
    } catch (cause) {
      setError(messageOf(cause));
      setSubmitting(false);
    }
  }

  if (loadError) {
    return (
      <AuthShell
        brand="orbit"
        lead="サーバーに接続できませんでした。ネットワークの状態を確認して、もう一度お試しください。"
      >
        <Button
          className="mt-8 w-full"
          onClick={() => window.location.reload()}
        >
          再試行
        </Button>
      </AuthShell>
    );
  }

  if (needed === null) {
    return (
      <AuthShell brand="orbit" lead="読み込み中…">
        <span />
      </AuthShell>
    );
  }

  if (!needed) {
    return (
      <AuthShell
        brand="orbit"
        lead="管理者はすでにいます。初回セットアップは使えません。"
      >
        <Button
          className="mt-8 w-full"
          onClick={() => window.location.assign("/admin")}
        >
          管理画面のログインへ
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      brand="orbit"
      lead="最初の管理者を作ります。管理者は、利用者の招待などサーバーの管理だけを行う専用のアカウントで、メール・カレンダー・連絡先は使えません。"
    >
      <form
        onSubmit={handleSubmit}
        className="mt-8 flex flex-col gap-5"
        aria-describedby={error ? errorId : undefined}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor={codeId}>合言葉</Label>
          <Input
            id={codeId}
            required
            autoFocus
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
            className="font-mono"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <p className="text-muted-foreground text-xs leading-relaxed">
            API サーバーのログに出ています (例:{" "}
            <code>docker compose logs api</code>)。
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={usernameId}>ログインに使う名前</Label>
          <Input
            id={usernameId}
            required
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="admin"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
          <p className="text-muted-foreground text-xs leading-relaxed">
            3〜32
            文字の英小文字・数字・「_」「.」「-」。あとから変更できません。
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={nameId}>表示名</Label>
          <Input
            id={nameId}
            required
            maxLength={100}
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={passwordId}>パスワード</Label>
          <Input
            id={passwordId}
            type="password"
            required
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            {MIN_PASSWORD_LENGTH}{" "}
            文字以上。一般の利用者のパスワードとは別にしてください。
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={confirmId}>パスワード (確認)</Label>
          <Input
            id={confirmId}
            type="password"
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </div>
        {error && (
          <p id={errorId} role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" disabled={submitting}>
          {submitting ? "作成中…" : "管理者を作成"}
        </Button>
      </form>
    </AuthShell>
  );
}
