"use client";

/**
 * 設定の「バージョン情報」。アプリと画面の版、接続先のサーバーの版と更新の方針、
 * 画面とアプリ本体の自動更新の状態を出す (docs/app-update.md、docs/updates.md)。
 */

import { cn } from "cn";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  DownloadIcon,
  type LucideIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { OrbitLogo } from "@/components/brand/orbit-logo";
import { showNotice } from "@/components/mail/toasts";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  type AppUpdateState,
  applyAppUpdate,
  checkForAppUpdate,
  installAndroidRelease,
  installDesktopUpdateNow,
  refreshServerInfo,
  type UpdateStatus,
  useAppUpdate,
} from "@/lib/app-update";
import type { ServerInfo } from "@/lib/app-update/body";
import { BUILD_VERSION, formatBuildVersion } from "@/lib/app-update/manifest";
import {
  backLogEnabled,
  backLogText,
  clearBackLog,
  useBackLogCount,
} from "@/lib/back-log";
import { isDesktopApp } from "@/lib/desktop/app";
import { isNativeApp } from "@/lib/native/app";
import { apiUrl } from "@/lib/server-url";

/** サーバーの更新の方針を、1 行の説明にする。 */
export function policyText(info: ServerInfo): string {
  const { channel, pinnedVersion, serverAutoUpdate, appUpdate } = info.updates;
  const follow = pinnedVersion
    ? `v${pinnedVersion} に固定`
    : channel === "edge"
      ? "開発版 (main の最新) を追う"
      : channel === "beta"
        ? "試験版 (beta) も含めて最新を追う"
        : "正式版の最新を追う";
  const server = serverAutoUpdate
    ? "サーバーは自動で更新"
    : "サーバーは手動で更新";
  const app =
    appUpdate === "auto"
      ? "アプリ本体は自動で更新"
      : appUpdate === "notify"
        ? "アプリ本体は更新を知らせるだけ"
        : "アプリ本体は配らない";
  return `${follow}、${server}、${app}`;
}

function appKind(): string {
  if (isDesktopApp()) return "デスクトップ版";
  if (isNativeApp()) return "スマホアプリ";
  return "Web 版";
}

function Row(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
      <dt className="w-28 shrink-0 text-muted-foreground text-sm">
        {props.label}
      </dt>
      <dd className="min-w-0 break-words text-sm">{props.children}</dd>
    </div>
  );
}

function statusText(status: UpdateStatus): {
  text: string;
  tone: "muted" | "ok" | "error";
} {
  switch (status.kind) {
    case "idle":
      return { text: "まだ確認していません。", tone: "muted" };
    case "checking":
      return { text: "確認しています…", tone: "muted" };
    case "up-to-date":
      return { text: "最新の画面です。", tone: "ok" };
    case "downloading":
      return {
        text: `新しい画面 (${formatBuildVersion(status.version)}) を取得しています…`,
        tone: "muted",
      };
    case "ready":
      return {
        text: `新しい画面 (${formatBuildVersion(status.version)}) を用意しました。次に起動したときに切り替わります。`,
        tone: "ok",
      };
    case "native-required":
      return {
        text: `新しい画面 (${formatBuildVersion(status.version)}) を使うには、アプリ本体の更新が必要です。`,
        tone: "error",
      };
    case "disabled":
      return {
        text: "このビルドでは、画面の自動更新は無効です。",
        tone: "muted",
      };
    case "error":
      return {
        text: `確認できませんでした (${status.message})`,
        tone: "error",
      };
  }
}

/**
 * 状態の 1 行。アイコンは 1 行目の文字の高さ (text-sm の行の高さ h-5) の中で縦の中央に置く。
 * アイコンが無いときも同じ幅を空けて、文字の左端を変えない。
 */
function StatusLine(props: {
  tone: "muted" | "ok" | "error";
  icon: LucideIcon | null;
  spin?: boolean;
  children: React.ReactNode;
}) {
  const Icon = props.icon;
  return (
    <output
      className={cn(
        "flex min-w-0 flex-1 basis-48 items-start gap-2 text-sm",
        props.tone === "error" && "text-destructive",
        props.tone === "muted" && "text-muted-foreground",
      )}
    >
      <span className="flex h-5 w-4 shrink-0 items-center justify-center">
        {props.spin ? (
          <Spinner className="size-4" />
        ) : (
          Icon && <Icon className="size-4" />
        )}
      </span>
      <span className="min-w-0">{props.children}</span>
    </output>
  );
}

export function AboutSettings() {
  const update = useAppUpdate();
  const { native, nativeTooOld, status, server } = update;
  const serverUrl = apiUrl();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void refreshServerInfo();
  }, []);
  const inApp = isDesktopApp() || isNativeApp();
  const builtAt = formatBuildVersion(BUILD_VERSION);
  const { text, tone } = statusText(status);
  const working =
    busy || status.kind === "checking" || status.kind === "downloading";

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <OrbitLogo className="h-8 w-auto" />
        </div>
        <p className="text-muted-foreground text-sm">by Luna Project</p>
        <dl className="flex flex-col divide-y rounded-lg border px-3">
          <Row label="アプリ">
            {appKind()}
            {native && ` ${native.nativeVersion}`}
          </Row>
          <Row label="画面">
            {builtAt ? `${builtAt} にビルド` : "開発版"}
            {BUILD_VERSION && (
              <span className="ml-2 text-muted-foreground text-xs">
                ({BUILD_VERSION})
              </span>
            )}
            {native && (
              <span className="block text-muted-foreground text-xs">
                {native.running
                  ? "サーバーから取得した画面を使っています"
                  : "アプリに同梱の画面を使っています"}
              </span>
            )}
          </Row>
          <Row label="接続先">
            {serverUrl}
            {server && (
              <span className="ml-2 text-muted-foreground text-xs">
                (v{server.version})
              </span>
            )}
          </Row>
          {server && <Row label="更新の方針">{policyText(server)}</Row>}
        </dl>
        {update.compatibility !== "ok" && (
          <div className="rounded-lg border px-3 py-2.5">
            <StatusLine tone="error" icon={CircleAlertIcon}>
              {update.compatibility === "client-too-old"
                ? "このアプリは接続先のサーバーより古いため、正しく動かないことがあります。アプリを更新してください。"
                : "接続先のサーバーがこのアプリより古いため、正しく動かないことがあります。サーバーの管理者に更新を依頼してください。"}
            </StatusLine>
          </div>
        )}
      </section>

      <BodyUpdateSection update={update} />

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="font-semibold text-base">画面の更新</h3>
          <p className="text-muted-foreground text-sm">
            {inApp
              ? "サーバーに新しい画面が配置されると、裏で取得して、次に起動したときに切り替えます。署名を確かめてから使うので、改ざんされた画面は使いません。アプリ本体の機能が変わったときは、アプリの更新が必要です。"
              : "Web 版は、開くたびにサーバーの新しい画面を自動で読み込みます。"}
          </p>
        </div>
        {inApp && native && (
          // 設定のほかの行 (settings-view.tsx の SettingRow) と同じく、状態を左、ボタンを右に置く。
          // 縦に重ねると、状態のアイコンとボタンのアイコン・文字の左端がそろわないため。
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border px-3 py-2.5">
            {nativeTooOld ? (
              <StatusLine tone="error" icon={CircleAlertIcon}>
                アプリ本体が古いため、画面の更新を確認できません。アプリを更新してください。
              </StatusLine>
            ) : (
              <StatusLine
                tone={tone}
                icon={
                  working
                    ? null
                    : tone === "error"
                      ? CircleAlertIcon
                      : tone === "ok"
                        ? CircleCheckIcon
                        : null
                }
                spin={working}
              >
                {text}
              </StatusLine>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={working || status.kind === "disabled"}
                onClick={() => void run(checkForAppUpdate)}
              >
                <RefreshCwIcon />
                更新を確認
              </Button>
              {status.kind === "ready" && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(applyAppUpdate)}
                >
                  <DownloadIcon />
                  {isDesktopApp() ? "再起動して切り替える" : "今すぐ切り替える"}
                </Button>
              )}
            </div>
          </div>
        )}
      </section>

      {isNativeApp() && backLogEnabled() && <BackLogSection />}
    </>
  );
}

/**
 * アプリ本体の更新 (lib/app-update/body.ts)。接続先のサーバーが配る版に揃える。
 * ブラウザーと iOS では出さない (iOS の本体はストアからしか更新できない)。
 */
function BodyUpdateSection({ update }: { update: AppUpdateState }) {
  const [busy, setBusy] = useState(false);
  const { body, server } = update;
  if (body.kind === "none") return null;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      showNotice(
        error instanceof Error ? error.message : "更新できませんでした。",
      );
    } finally {
      setBusy(false);
    }
  }

  const mode = server?.updates.appUpdate ?? null;
  let line: { text: string; tone: "muted" | "ok" | "error"; spin?: boolean };
  let action: React.ReactNode = null;

  if (body.kind === "desktop") {
    const s = body.status;
    if (!s.configured) {
      line = {
        text: "このビルドでは、アプリ本体の自動更新は無効です。",
        tone: "muted",
      };
    } else if (mode === "off") {
      line = {
        text: "接続先のサーバーの設定で、アプリ本体の自動更新は止められています。",
        tone: "muted",
      };
    } else if (s.pending) {
      line = {
        text: `${s.pending} を用意しました。アプリを終了するときに入れ替わります。`,
        tone: "ok",
      };
      action = (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => void run(installDesktopUpdateNow)}
        >
          <DownloadIcon />
          今すぐ更新
        </Button>
      );
    } else if (s.installed) {
      line = {
        text: `${s.installed} を入れました。次に起動したときに切り替わります。`,
        tone: "ok",
      };
    } else {
      line = {
        text:
          mode === "auto"
            ? "接続先のサーバーに新しい版があれば、自動で取得して入れ替えます。"
            : "接続先のサーバーに新しい版があれば、お知らせします。",
        tone: "muted",
      };
    }
    if (s.configured && mode !== "off") {
      action = (
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void run(() => refreshServerInfo(true))}
          >
            <RefreshCwIcon />
            更新を確認
          </Button>
          {action}
        </>
      );
    }
  } else {
    if (body.info.fromPlayStore) {
      line = {
        text: "Google Play から入れたアプリは、Google Play で更新されます。",
        tone: "muted",
      };
    } else if (mode === "off") {
      line = {
        text: "接続先のサーバーの設定で、アプリ本体の自動更新は止められています。",
        tone: "muted",
      };
    } else if (body.release) {
      const version = body.release.version;
      line =
        body.phase === "downloading"
          ? { text: `${version} を取得しています…`, tone: "muted", spin: true }
          : body.phase === "installing"
            ? { text: `${version} を入れています…`, tone: "muted", spin: true }
            : {
                text: `新しい版 ${version} を入れられます。入れるときは OS の確認が出ます。`,
                tone: "ok",
              };
      action = (
        <Button
          size="sm"
          disabled={
            busy || body.phase === "downloading" || body.phase === "installing"
          }
          onClick={() => void run(installAndroidRelease)}
        >
          <DownloadIcon />
          入れる
        </Button>
      );
    } else {
      line =
        body.phase === "checking"
          ? { text: "確認しています…", tone: "muted", spin: true }
          : { text: `最新の版です (${body.info.versionName})。`, tone: "ok" };
      action = (
        <Button
          variant="outline"
          size="sm"
          disabled={busy || body.phase === "checking"}
          onClick={() => void run(() => refreshServerInfo(true))}
        >
          <RefreshCwIcon />
          更新を確認
        </Button>
      );
    }
  }

  const error = body.kind === "android" ? body.error : null;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="font-semibold text-base">アプリ本体の更新</h3>
        <p className="text-muted-foreground text-sm">
          アプリ本体は、接続先のサーバーが配る版に更新します。サーバーの版が固定されていれば、アプリもその版に揃います。
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border px-3 py-2.5">
        <StatusLine
          tone={line.tone}
          icon={line.spin ? null : line.tone === "ok" ? CircleCheckIcon : null}
          spin={line.spin}
        >
          {line.text}
          {error && (
            <span className="mt-1 block text-destructive">{error}</span>
          )}
        </StatusLine>
        {action && <div className="flex flex-wrap gap-2">{action}</div>}
      </div>
    </section>
  );
}

/**
 * 戻るボタンの記録 (lib/back-log.ts)。戻るボタンが効かないことがある原因を調べるため、
 * 押したときの状態をコピーして送ってもらう。
 */
function BackLogSection() {
  const count = useBackLogCount();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(backLogText());
      showNotice(`${count} 件の記録をコピーしました。`, "info");
    } catch {
      showNotice("記録をコピーできませんでした。");
    }
  };
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="font-semibold text-base">戻るボタンの記録</h3>
        <p className="text-muted-foreground text-sm">
          戻るボタンが効かないことがある原因を調べるためのものです。効かなかったあとにここを開いて「コピー」を押し、内容を送ってください。最新の
          300
          件だけをこの端末に残し、ほかへは送りません。アプリを閉じると消えます。
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border px-3 py-2.5">
        <span className="text-muted-foreground text-sm tabular-nums">
          {count} 件
        </span>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={count === 0}
            onClick={() => void copy()}
          >
            コピー
          </Button>
          <Button variant="ghost" size="sm" onClick={clearBackLog}>
            消去
          </Button>
        </div>
      </div>
    </section>
  );
}
