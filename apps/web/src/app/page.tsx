"use client";

import { useEffect } from "react";
import { useAuth } from "@/components/auth-provider";
import { CalendarApp } from "@/components/calendar/calendar-app";
import { MailApp } from "@/components/mail/mail-app";
import { navigateApp, usePathnameStore } from "@/lib/app-navigation";
import { onOpenAppUpdateSettings } from "@/lib/app-update";
import { isCalendarPath } from "@/lib/calendar/route";
import { onNotificationOpen } from "@/lib/notifications";
import { buildRoute, canonicalAppUrl, emptyRoute } from "@/lib/route";
import {
  leaveSettings,
  openSettings,
  parseSettingsRoute,
  settingsBackground,
} from "@/lib/settings-route";

/**
 * 古い形の URL (メールが / の下にあった頃の /accounts/…、/?account=…、/settings/<カテゴリ>) を、
 * いまの形 (/mail/…、/settings/<分類>/<ページ>) に書き換える。"/" もメール (/mail) にする。
 * ブックマーク、古い版の通知、サービスワーカーが保存した画面から開いたときに通る。
 */
function rewriteLegacyLocation() {
  if (typeof window === "undefined") return;
  const canonical = canonicalAppUrl(
    `${window.location.pathname}${window.location.search}`,
  );
  if (canonical === null) return;
  window.history.replaceState(
    window.history.state,
    "",
    `${canonical}${window.location.hash}`,
  );
}

/**
 * Orbit の画面 (Next.js のページは "/" の 1 つだけ。パスはここで読み取る)。
 *
 *   /mail/*       メール
 *   /calendar/*   カレンダー
 *   /settings/*   設定のダイアログ (開いた元のアプリの画面の上に出す)
 *   /contacts/*   連絡先 (アプリはまだ無いので、メールを出す)
 *   /             メール (/mail へ書き換える)
 */
export default function Home() {
  const auth = useAuth();
  rewriteLegacyLocation();
  const pathname = usePathnameStore();
  const settings = parseSettingsRoute(pathname);
  // 設定を開いている間は、開いた元 (履歴に覚えておいた URL) のアプリを後ろに出す。
  const background = settings ? settingsBackground() : pathname;
  const surface = isCalendarPath(background.split("?")[0] ?? "")
    ? "calendar"
    : "mail";

  // トレイの「更新を確認」と、アプリ本体の更新の知らせの「詳細」で、設定の「バージョン情報」を開く。
  useEffect(
    () =>
      onOpenAppUpdateSettings(() =>
        openSettings({ group: "common", page: "about" }),
      ),
    [],
  );

  // カレンダーを出している間に新着メールの通知が押されたら、メールの画面へ移ってそのメールを開く
  // (メールの画面を出している間は、メールの画面が受け取る)。
  const signedIn = auth.status === "signed-in";
  useEffect(() => {
    if (!signedIn || surface === "mail") return;
    return onNotificationOpen((messageId) => {
      const path = buildRoute({ ...emptyRoute, messageId });
      if (parseSettingsRoute(window.location.pathname)) leaveSettings(path);
      else navigateApp(path);
    });
  }, [signedIn, surface]);

  // 未ログインの間は AuthGate がログイン画面へ移すので、ここには来ない。
  if (!signedIn) return null;
  return (
    <>
      {surface === "calendar" && (
        <CalendarApp key="calendar" user={auth.user} />
      )}
      {(surface === "mail" || settings) && (
        <MailApp
          // カレンダーの上の設定では、設定のダイアログだけを受け持つ。
          key={surface === "mail" ? "mail" : "settings"}
          user={auth.user}
          settings={settings}
          host={surface !== "mail"}
          initialUrl={settings ? background : undefined}
        />
      )}
    </>
  );
}
