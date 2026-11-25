"use client";

/** 設定の「バージョン情報」。アプリと画面の版、接続先のサーバー、画面の自動更新の状態を出す。 */

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
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  applyAppUpdate,
  checkForAppUpdate,
  type UpdateStatus,
  useAppUpdate,
} from "@/lib/app-update";
import { BUILD_VERSION, formatBuildVersion } from "@/lib/app-update/manifest";
import { isDesktopApp } from "@/lib/desktop/app";
import { isNativeApp } from "@/lib/native/app";
import { apiUrl } from "@/lib/server-url";

type ServerInfo = { url: string; version: string | null };

function useServerInfo(): ServerInfo | null {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  useEffect(() => {
    const url = apiUrl();
    let cancelled = false;
    setInfo({ url, version: null });
    fetch(`${url}/v1`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        if (cancelled) return;
        const version =
          typeof body === "object" &&
          body !== null &&
          typeof (body as { version?: unknown }).version === "number"
            ? `API v${(body as { version: number }).version}`
            : null;
        setInfo({ url, version });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return info;
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
  const { native, nativeTooOld, status } = useAppUpdate();
  const server = useServerInfo();
  const [busy, setBusy] = useState(false);
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
            {server?.url ?? "—"}
            {server?.version && (
              <span className="ml-2 text-muted-foreground text-xs">
                ({server.version})
              </span>
            )}
          </Row>
        </dl>
      </section>

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
    </>
  );
}
