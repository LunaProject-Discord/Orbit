"use client";

import { CircleAlertIcon } from "lucide-react";
import { useId, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import {
  type Account,
  ApiError,
  calendarOAuthProviderOf,
  type OAuthProvider,
  startOAuthLogin,
  updateAccountFeatures,
} from "@/lib/api";
import { usesAppOAuth } from "@/lib/native/oauth";

const PROVIDER_NAMES: Record<OAuthProvider, string> = {
  google: "Google",
  microsoft: "Microsoft",
};

/** カレンダーの権限を足したあとに戻る画面 (設定のアカウント)。 */
const RETURN_TO = "/settings/accounts";

/**
 * 設定のアカウントの「カレンダーを使う」の行。
 *
 * カレンダーの権限が無い Google / Microsoft のアカウントでオンにすると、サーバーが
 * 409 consent_required を返す。そのときは確かめてから、カレンダーの権限を足したログイン画面へ移る。
 * 戻ってきたときの知らせ (許可されなかった場合) は、OAuth の戻り先のページ (oauth-callback) で出す。
 * カレンダーの仕組みが無いアカウント (一般の IMAP や POP3) では、使えない理由を添えて切り替えを止める。
 */
export function AccountCalendarSetting({
  account,
  onUpdated,
}: {
  account: Account;
  onUpdated: (account: Account) => void;
}) {
  const id = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** カレンダーの権限を足すためにログインし直すかの確認を出している。 */
  const [confirming, setConfirming] = useState(false);
  const [redirecting, setRedirecting] = useState(false);

  const consent = account.calendarConsent;
  // 古いサーバー (カレンダーの項目が無い) では出さない。
  if (consent === undefined) return null;
  const enabled = account.calendarEnabled === true;
  const provider = calendarOAuthProviderOf(account);
  // CalDAV で追加したアカウントなど、同意の仕組みが無くてもカレンダーを使っているものは止められる。
  const unavailable = consent === "not_applicable" && !enabled;
  const passwordGmail =
    account.provider === "gmail" && account.authType === "password";

  const change = (checked: boolean) => {
    setError(null);
    setSaving(true);
    // 押してすぐ画面に反映し、保存できなければ元に戻す。
    onUpdated({ ...account, calendarEnabled: checked });
    updateAccountFeatures(account.id, { calendarEnabled: checked })
      .then(onUpdated)
      .catch((cause) => {
        onUpdated(account);
        if (
          cause instanceof ApiError &&
          cause.code === "consent_required" &&
          provider
        ) {
          setConfirming(true);
          return;
        }
        setError("変更を保存できませんでした。もう一度お試しください。");
      })
      .finally(() => setSaving(false));
  };

  const login = async () => {
    if (!provider) return;
    setRedirecting(true);
    try {
      window.location.assign(
        await startOAuthLogin(provider, account.id, {
          calendar: true,
          returnTo: RETURN_TO,
        }),
      );
      // スマホアプリとデスクトップ版では、ログイン画面はアプリの外のブラウザーで開き、この画面は残る。
      if (usesAppOAuth()) {
        setRedirecting(false);
        setConfirming(false);
      }
    } catch {
      setRedirecting(false);
      setConfirming(false);
      setError(
        "ログイン画面を開けませんでした。時間をおいてもう一度お試しください。",
      );
    }
  };

  const name = provider ? PROVIDER_NAMES[provider] : "";
  let description: string;
  if (unavailable) {
    description =
      "このアカウントには、Orbit から使えるカレンダーがありません。メールのログインからカレンダーを使えるのは、Google と Microsoft のアカウントです。";
  } else if (provider === "google") {
    description = "Google カレンダーの予定を、Orbit のカレンダーに表示します。";
  } else if (provider === "microsoft") {
    description = "Outlook の予定表を、Orbit のカレンダーに表示します。";
  } else {
    description = "このアカウントのカレンダーを、Orbit に表示します。";
  }
  if (!enabled && consent === "required") {
    description += `オンにすると、カレンダーの権限を追加するため、${name} にもう一度ログインします。`;
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p
            id={`${id}-calendar`}
            className={
              unavailable
                ? "font-medium text-muted-foreground text-sm"
                : "font-medium text-sm"
            }
          >
            カレンダーを使う
          </p>
          <p
            id={`${id}-calendar-description`}
            className="text-muted-foreground text-xs leading-relaxed"
          >
            {description}
          </p>
        </div>
        <Switch
          aria-labelledby={`${id}-calendar`}
          aria-describedby={`${id}-calendar-description`}
          checked={enabled}
          disabled={unavailable || saving || redirecting}
          onCheckedChange={change}
        />
      </div>
      {enabled && account.calendarError && (
        <p className="flex items-start gap-1 text-destructive text-xs">
          <CircleAlertIcon
            className="mt-0.5 size-3.5 shrink-0"
            aria-hidden="true"
          />
          <span className="line-clamp-3">
            カレンダーを同期できません: {account.calendarError}
          </span>
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open && !redirecting) setConfirming(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {name} にもう一度ログインしますか？
            </AlertDialogTitle>
            <AlertDialogDescription>
              カレンダーの権限を追加するため、もう一度ログインします。
              {name} の確認画面で、カレンダーへのアクセスを許可してください。
              {passwordGmail &&
                " このアカウントは、アプリ パスワードから Google でのログインに切り替わります。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={redirecting}>
              キャンセル
            </AlertDialogCancel>
            <AlertDialogAction disabled={redirecting} onClick={login}>
              {redirecting ? "ログイン画面を開いています…" : "ログインする"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
