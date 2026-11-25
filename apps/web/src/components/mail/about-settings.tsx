"use client";

/** 設定の「バージョン情報」。アプリと画面の版、接続先のサーバー、画面の自動更新の状態を出す。 */

import {
  CircleAlertIcon,
  CircleCheckIcon,
  DownloadIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { OrbitLogo } from "@/components/brand/orbit-logo";
import { Button } from "@/components/ui/button";
import {
  applyAppUpdate,
  checkForAppUpdate,
  resetAppUpdate,
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
          <div className="flex flex-col gap-3 rounded-lg border p-3">
            {nativeTooOld ? (
              <p className="flex items-start gap-2 text-destructive text-sm">
                <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
                アプリ本体が古いため、画面の更新を確認できません。アプリを更新してください。
              </p>
            ) : (
              <output
                className={
                  tone === "error"
                    ? "flex items-start gap-2 text-destructive text-sm"
                    : tone === "ok"
                      ? "flex items-start gap-2 text-sm"
                      : "flex items-start gap-2 text-muted-foreground text-sm"
                }
              >
                {working ? (
                  <LoaderCircleIcon className="mt-0.5 size-4 shrink-0 animate-spin" />
                ) : tone === "error" ? (
                  <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
                ) : tone === "ok" ? (
                  <CircleCheckIcon className="mt-0.5 size-4 shrink-0" />
                ) : null}
                <span>{text}</span>
              </output>
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
              {(native.running || native.pending) && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={working}
                  onClick={() => void run(resetAppUpdate)}
                >
                  <RotateCcwIcon />
                  同梱の画面に戻す
                </Button>
              )}
            </div>
            {(native.running || native.pending) && (
              <p className="text-muted-foreground text-xs">
                「同梱の画面に戻す」は、取得した画面を消して、次に起動したときからアプリに同梱の画面を使います。
              </p>
            )}
          </div>
        )}
      </section>
    </>
  );
}
