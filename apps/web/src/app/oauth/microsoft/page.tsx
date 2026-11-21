"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { buttonVariants } from "@/components/ui/button";
import { ApiError, completeMicrosoftLogin, NetworkError } from "@/lib/api";

function messageOf(error: unknown): string {
  if (error instanceof NetworkError) {
    return "サーバーに接続できませんでした。ネットワークの状態を確認して、もう一度お試しください。";
  }
  if (error instanceof ApiError) {
    const body = (error.body ?? {}) as { detail?: string };
    switch (error.code) {
      case "invalid_state":
        return "ログインの有効期限が切れたか、別の利用者が始めたログインです。もう一度最初からお試しください。";
      case "account_exists":
        return "このメールアドレスは、すでに IMAP のアカウントとして追加されています。先にそのアカウントを削除してください。";
      case "no_refresh_token":
        return "Microsoft から継続的なアクセスの許可を得られませんでした。もう一度お試しください。";
      case "oauth_failed":
        return `Microsoft のログインを完了できませんでした。${body.detail ? ` (${body.detail})` : ""}`;
      case "microsoft_not_configured":
        return "このサーバーでは Microsoft アカウントの追加が設定されていません。";
    }
  }
  return "アカウントを追加できませんでした。時間をおいてもう一度お試しください。";
}

/** Microsoft のログイン画面が返すエラー (利用者による取り消しなど) の説明。 */
function providerErrorOf(params: URLSearchParams): string {
  if (params.get("error") === "access_denied") {
    return "Microsoft へのログイン、またはアクセスの許可が取り消されました。";
  }
  const description = params.get("error_description")?.split(/\r?\n/)[0];
  return `Microsoft のログインでエラーが発生しました。${description ? ` (${description})` : ""}`;
}

/**
 * Microsoft のログイン画面からの戻り先。
 * URL に付いてきた code と state を API に渡してアカウントを追加し、受信トレイへ移る。
 */
export default function MicrosoftCallbackPage() {
  const auth = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  /** code は 1 回しか使えないので、二重に送らない。 */
  const started = useRef(false);
  const signedIn = auth.status === "signed-in";

  useEffect(() => {
    if (!signedIn || started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    // code を履歴やリファラーに残さない。
    window.history.replaceState(null, "", window.location.pathname);
    const code = params.get("code");
    const state = params.get("state");
    if (params.get("error")) {
      setError(providerErrorOf(params));
      return;
    }
    if (!code || !state) {
      setError(
        "ログインの情報が見つかりません。もう一度最初からお試しください。",
      );
      return;
    }
    completeMicrosoftLogin(code, state)
      .then(() => router.replace("/"))
      .catch((cause) => setError(messageOf(cause)));
  }, [signedIn, router]);

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      {error ? (
        <>
          <h1 className="font-semibold text-xl">
            Microsoft アカウントを追加できませんでした
          </h1>
          <p role="alert" className="max-w-md text-muted-foreground text-sm">
            {error}
          </p>
          <Link href="/" className={buttonVariants({ variant: "outline" })}>
            受信トレイに戻る
          </Link>
        </>
      ) : (
        <output className="text-muted-foreground text-sm">
          Microsoft アカウントを追加しています…
        </output>
      )}
    </main>
  );
}
