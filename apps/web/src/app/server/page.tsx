"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { forgetSession } from "@/lib/api";
import { releasePush } from "@/lib/notifications";
import {
  apiUrl,
  checkServer,
  hasServerUrl,
  isBundledApp,
  normalizeServerUrl,
  setServerUrl,
} from "@/lib/server-url";

/**
 * 接続先サーバーの設定 (スマホ版・デスクトップ版)。
 * アプリには画面だけが入っているので、最初に自分のサーバーのアドレスを入力してもらう。
 * Web では配信元のサーバーに決まっているため、この画面は使わない。
 */
export default function ServerPage() {
  const auth = useAuth();
  const router = useRouter();
  const inputId = useId();
  const errorId = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  /** null は判定前 (静的に書き出した HTML と食い違わないよう、読み込み後に決める)。 */
  const [bundled, setBundled] = useState<boolean | null>(null);
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    const isBundled = isBundledApp();
    setBundled(isBundled);
    if (!isBundled) {
      router.replace("/");
      return;
    }
    const has = hasServerUrl();
    setConfigured(has);
    if (has) setValue(apiUrl());
  }, [router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const url = normalizeServerUrl(value);
    if (!url) {
      setError(
        "アドレスの形式が正しくありません。mail.example.com のように入力してください。",
      );
      return;
    }
    setChecking(true);
    const result = await checkServer(url);
    if (!result.ok) {
      setChecking(false);
      setError(
        result.reason === "unreachable"
          ? "サーバーに接続できませんでした。アドレスとネットワークの状態を確認してください。"
          : "このアドレスでは Orbit のサーバーが動いていません。アドレスを確認してください。",
      );
      return;
    }
    const changed = !configured || url !== apiUrl();
    if (changed) {
      // 前のサーバーのログイン情報は新しいサーバーでは使えない。
      // 通知の送り先も、前のサーバーから消してから切り替える。
      if (auth.status === "signed-in") await releasePush(true);
      forgetSession();
      setServerUrl(url);
      auth.reset();
    }
    router.replace(changed ? "/login" : "/");
  }

  if (!bundled) {
    return (
      <main
        className="flex flex-1 items-center justify-center p-8"
        aria-busy="true"
      >
        <output className="text-muted-foreground text-sm">読み込み中…</output>
      </main>
    );
  }

  return (
    <main className="relative flex flex-1 flex-col items-center justify-center p-6">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <h1 className="font-semibold text-3xl tracking-tight">Mail</h1>
        <p className="mt-2 text-muted-foreground text-sm">
          接続するサーバーのアドレスを入力してください。
        </p>
        <form
          onSubmit={handleSubmit}
          className="mt-8 flex flex-col gap-5"
          aria-describedby={error ? errorId : undefined}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor={inputId}>サーバーのアドレス</Label>
            <Input
              id={inputId}
              type="text"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="mail.example.com"
              required
              value={value}
              onChange={(event) => setValue(event.target.value)}
              aria-invalid={error ? true : undefined}
            />
            <p className="text-muted-foreground text-xs">
              Web 版を開くときのアドレスと同じです。
              {configured &&
                auth.status === "signed-in" &&
                " 別のサーバーに変更すると、この端末はログアウトします。"}
            </p>
          </div>
          {error && (
            <p id={errorId} role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <Button type="submit" size="lg" disabled={checking}>
            {checking ? "確認中…" : "接続"}
          </Button>
          {configured && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => router.back()}
              disabled={checking}
            >
              キャンセル
            </Button>
          )}
        </form>
      </div>
    </main>
  );
}
