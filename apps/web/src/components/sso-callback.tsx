"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { AddAccountDialog } from "@/components/mail/add-account-dialog";
import { showNotice } from "@/components/mail/toasts";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  ApiError,
  completeSsoLink,
  NetworkError,
  pendingSsoMode,
  type SsoMode,
} from "@/lib/api";
import {
  appOAuthUrl,
  isAppOAuthReturn,
  usesAppOAuth,
} from "@/lib/native/oauth";

/** 結び付けのあとに戻る、設定の「ログインとセキュリティ」。 */
const SECURITY_SETTINGS = "/settings/security";

function messageOf(error: unknown): string {
  if (error instanceof NetworkError) {
    return "サーバーに接続できませんでした。ネットワークの状態を確認して、もう一度お試しください。";
  }
  if (error instanceof ApiError) {
    switch (error.code) {
      case "user_disabled":
        return "このアカウントは管理者によって無効にされています。管理者にお問い合わせください。";
      case "invalid_state":
        return "ログインの有効期限が切れたか、別の端末やブラウザーで始めたログインです。もう一度最初からお試しください。";
      case "linked_to_other":
        return "この IdP のアカウントは、すでに別の Orbit の利用者に結び付いています。";
      case "already_linked":
        return "この IdP には、すでに別のアカウントを結び付けています。先に解除してください。";
      case "SESSION_NOT_FRESH":
        return "安全のため、ログインしてから時間が経った端末では結び付けられません。ログインし直してからお試しください。";
      case "provider_unavailable":
        return "このログイン方法は現在使えません。管理者にお問い合わせください。";
      case "email_missing":
        return "ログイン先のサービスからメールアドレスを受け取れませんでした。管理者にお問い合わせください。";
      case "link_required":
        return "このメールアドレスの Orbit のアカウントがすでにあります。このログイン方法で使うには、管理者にお問い合わせください。";
      case "sign_up_disabled":
        return "このログイン方法では、Orbit のアカウントを新しく作れません。管理者にお問い合わせください。";
      case "domain_not_allowed":
        return "このメールアドレスのドメインでは、Orbit のアカウントを作れません。管理者にお問い合わせください。";
      case "profile_invalid":
        return "ログイン先のサービスから利用者の情報を受け取れませんでした。管理者にお問い合わせください。";
      case "sso_failed":
        return "ログイン先のサービスでのログインを完了できませんでした。もう一度お試しください。";
    }
    if (error.status === 429 || error.code === "too_many_requests") {
      return "試行回数が多すぎます。しばらく待ってからもう一度お試しください。";
    }
  }
  return "ログインできませんでした。時間をおいてもう一度お試しください。";
}

/** ログイン画面が返すエラー (利用者による取り消しなど) の説明。 */
function providerErrorOf(params: URLSearchParams): string {
  if (params.get("error") === "access_denied") {
    return "ログインが取り消されました。";
  }
  const description = params.get("error_description")?.split(/\r?\n/)[0];
  return `ログイン先のサービスでエラーが発生しました。${description ? ` (${description})` : ""}`;
}

/**
 * IdP (シングルサインオン) のログイン画面からの戻り先 (/oauth/sso)。
 * URL に付いてきた code と state を API に渡して Orbit にログインする。
 * 2 段階認証が要ればログイン画面へ、そうでなければ受信トレイへ移る。
 */
export function SsoCallback() {
  const auth = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  /** アプリから始めたログインを、アプリへ引き渡す URL。 */
  const [appUrl, setAppUrl] = useState<string | null>(null);
  /** 作ったばかりの利用者に、メールアカウントの追加を案内する。 */
  const [suggest, setSuggest] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  /** URL から受け取った code と state。設定画面からの結び付け (link) はログインを待って送る。 */
  const [received, setReceived] = useState<{
    mode: SsoMode;
    code: string;
    state: string;
  } | null>(null);
  /** 設定画面から始めた結び付けか (表示の文言を変える)。 */
  const [linking, setLinking] = useState(false);
  /** URL は 1 回だけ読む (読んだら消す)。 */
  const read = useRef(false);
  /** code は 1 回しか使えないので、二重に送らない。 */
  const sent = useRef(false);
  const { completeSso, status } = auth;

  useEffect(() => {
    if (read.current) return;
    read.current = true;
    if (!usesAppOAuth() && isAppOAuthReturn(window.location.search)) {
      const url = appOAuthUrl("sso", window.location.search);
      // code を履歴やリファラーに残さない。
      window.history.replaceState(null, "", window.location.pathname);
      setAppUrl(url);
      // 自動で戻れないブラウザーもあるので、ボタンも出しておく。
      window.location.assign(url);
      return;
    }
    const mode = pendingSsoMode() ?? "login";
    setLinking(mode === "link");
    const params = new URLSearchParams(window.location.search);
    window.history.replaceState(null, "", window.location.pathname);
    if (params.get("error")) {
      setError(providerErrorOf(params));
      return;
    }
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) {
      setError(
        "ログインの情報が見つかりません。もう一度最初からお試しください。",
      );
      return;
    }
    setReceived({ mode, code, state });
  }, []);

  useEffect(() => {
    if (!received || sent.current) return;
    if (received.mode === "link") {
      // 結び付けはログイン中の利用者に対して行う。ログインの確認を待つ。
      if (status === "loading") return;
      sent.current = true;
      if (status !== "signed-in") {
        setError(
          "ログインの有効期限が切れました。ログインし直してから、もう一度お試しください。",
        );
        return;
      }
      completeSsoLink(received.code, received.state)
        .then((provider) => {
          showNotice(`${provider.name} を結び付けました。`, "info");
          router.replace(SECURITY_SETTINGS);
        })
        .catch((cause) => setError(messageOf(cause)));
      return;
    }
    sent.current = true;
    completeSso(received.code, received.state)
      .then((result) => {
        if (result.twoFactor) {
          router.replace("/login?step=two-factor");
        } else if (result.suggestMailAccount) {
          setSuggest(true);
        } else {
          router.replace("/");
        }
      })
      .catch((cause) => setError(messageOf(cause)));
  }, [received, status, completeSso, router]);

  if (appUrl) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="font-semibold text-xl">アプリに戻ります</h1>
        <p className="max-w-md text-muted-foreground text-sm">
          自動で戻らないときは、下のボタンを押してください。
        </p>
        <a href={appUrl} className={buttonVariants()}>
          Orbit に戻る
        </a>
      </main>
    );
  }

  if (suggest) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="font-semibold text-xl">Orbit へようこそ</h1>
        <p className="max-w-md text-muted-foreground text-sm">
          {
            "Orbit のアカウントを作りました。メールを読み書きするには、メールアカウントを追加してください。IMAP のパスワードには、メールサービスで発行したアプリパスワードが必要な場合があります。"
          }
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => setAddOpen(true)}>
            メールアカウントを追加
          </Button>
          <Button variant="outline" onClick={() => router.replace("/")}>
            あとで追加する
          </Button>
        </div>
        <AddAccountDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          onCreated={() => router.replace("/")}
        />
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      {error ? (
        <>
          <h1 className="font-semibold text-xl">
            {linking ? "結び付けられませんでした" : "ログインできませんでした"}
          </h1>
          <p role="alert" className="max-w-md text-muted-foreground text-sm">
            {error}
          </p>
          <Link
            href={linking ? SECURITY_SETTINGS : "/login"}
            className={buttonVariants({ variant: "outline" })}
          >
            {linking ? "設定に戻る" : "ログイン画面に戻る"}
          </Link>
        </>
      ) : (
        <output className="text-muted-foreground text-sm">
          {linking ? "結び付けています…" : "ログインしています…"}
        </output>
      )}
    </main>
  );
}
