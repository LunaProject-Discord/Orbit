"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { buttonVariants } from "@/components/ui/button";
import {
  ApiError,
  completeOAuthLogin,
  NetworkError,
  type OAuthProvider,
} from "@/lib/api";
import {
  appOAuthUrl,
  isAppOAuthReturn,
  usesAppOAuth,
} from "@/lib/native/oauth";

const names: Record<OAuthProvider, string> = {
  google: "Google",
  microsoft: "Microsoft",
};

function messageOf(provider: OAuthProvider, error: unknown): string {
  const name = names[provider];
  if (error instanceof NetworkError) {
    return "サーバーに接続できませんでした。ネットワークの状態を確認して、もう一度お試しください。";
  }
  if (error instanceof ApiError) {
    const body = (error.body ?? {}) as { detail?: string };
    const detail = body.detail ? ` (${body.detail})` : "";
    switch (error.code) {
      case "invalid_state":
        return "ログインの有効期限が切れたか、別の利用者が始めたログインです。もう一度最初からお試しください。";
      case "account_exists":
        return "このメールアドレスは、すでに別の設定のアカウントとして追加されています。先にそのアカウントを削除してください。";
      case "no_refresh_token":
        return `${name} から継続的なアクセスの許可を得られませんでした。もう一度お試しください。`;
      case "scope_missing":
        return "Gmail のメールへのアクセスが許可されませんでした。もう一度ログインし、確認画面でメールへのアクセスにチェックを入れてください。";
      case "imap_unavailable":
        return `Gmail に IMAP で接続できませんでした。Google Workspace のアカウントでは、管理者が IMAP を無効にしている場合があります。${detail}`;
      case "oauth_failed":
        return `${name} のログインを完了できませんでした。${detail}`;
      case "connection_failed":
        return `${name} のサーバーに接続できませんでした。時間をおいてもう一度お試しください。${detail}`;
      case "google_not_configured":
      case "microsoft_not_configured":
        return `このサーバーでは ${name} アカウントの追加が設定されていません。`;
    }
  }
  return "アカウントを追加できませんでした。時間をおいてもう一度お試しください。";
}

/** ログイン画面が返すエラー (利用者による取り消しなど) の説明。 */
function providerErrorOf(
  provider: OAuthProvider,
  params: URLSearchParams,
): string {
  const name = names[provider];
  if (params.get("error") === "access_denied") {
    return `${name} へのログイン、またはアクセスの許可が取り消されました。`;
  }
  const description = params.get("error_description")?.split(/\r?\n/)[0];
  return `${name} のログインでエラーが発生しました。${description ? ` (${description})` : ""}`;
}

/**
 * Google / Microsoft のログイン画面からの戻り先。
 * URL に付いてきた code と state を API に渡してアカウントを追加し、受信トレイへ移る。
 */
export function OAuthCallback({ provider }: { provider: OAuthProvider }) {
  const auth = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  /** code は 1 回しか使えないので、二重に送らない。 */
  const started = useRef(false);
  const signedIn = auth.status === "signed-in";
  const name = names[provider];
  /**
   * スマホアプリから始めたログインが、ブラウザーの Web 版へ戻ってきたとき。
   * このページでは追加せず、受け取った内容をアプリへ引き渡す (アプリへ戻る URL を入れる)。
   */
  const [appUrl, setAppUrl] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    if (!usesAppOAuth() && isAppOAuthReturn(window.location.search)) {
      started.current = true;
      const url = appOAuthUrl(provider, window.location.search);
      // code を履歴やリファラーに残さない。
      window.history.replaceState(null, "", window.location.pathname);
      setAppUrl(url);
      // 自動で戻れないブラウザーもあるので、ボタンも出しておく。
      window.location.assign(url);
      return;
    }
    if (!signedIn) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    // code を履歴やリファラーに残さない。
    window.history.replaceState(null, "", window.location.pathname);
    const code = params.get("code");
    const state = params.get("state");
    if (params.get("error")) {
      setError(providerErrorOf(provider, params));
      return;
    }
    if (!code || !state) {
      setError(
        "ログインの情報が見つかりません。もう一度最初からお試しください。",
      );
      return;
    }
    completeOAuthLogin(provider, code, state)
      .then(() => router.replace("/"))
      .catch((cause) => setError(messageOf(provider, cause)));
  }, [signedIn, router, provider]);

  if (appUrl) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="font-semibold text-xl">アプリに戻ります</h1>
        <p className="max-w-md text-muted-foreground text-sm">
          {name}{" "}
          のログインが済みました。自動で戻らないときは、下のボタンを押してください。
        </p>
        <a href={appUrl} className={buttonVariants()}>
          Orbit Mail に戻る
        </a>
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      {error ? (
        <>
          <h1 className="font-semibold text-xl">
            {name} アカウントを追加できませんでした
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
          {name} アカウントを追加しています…
        </output>
      )}
    </main>
  );
}
