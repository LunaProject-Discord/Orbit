"use client";

/**
 * 受信 (IMAP) と送信 (SMTP) のサーバー設定の部品。アカウントの追加画面と、
 * 追加済みアカウントの「サーバー設定」で使う。
 */

import { cn } from "cn";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  DownloadIcon,
  GlobeIcon,
  HashIcon,
  KeyRoundIcon,
  ShieldIcon,
  UploadIcon,
  UserIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  DiscoveredServer,
  DiscoveredSettings,
  ServerCheck,
  ServerSettings,
} from "@/lib/api";

export type ServerKind = "imap" | "smtp";

/** 画面で選べるセキュリティ。保存するのは「最初から TLS か (secure)」だけ。 */
export type Security = "ssl" | "starttls";

/** 入力中のサーバー設定。ポートは入力の途中で空にできるよう文字列で持つ。 */
export type ServerForm = { host: string; port: string; security: Security };

export const SECURITY_OPTIONS = [
  { value: "ssl", label: "SSL/TLS" },
  { value: "starttls", label: "STARTTLS" },
] as const;

const DEFAULT_PORTS: Record<ServerKind, Record<Security, string>> = {
  imap: { ssl: "993", starttls: "143" },
  smtp: { ssl: "465", starttls: "587" },
};

export function securityLabel(security: Security): string {
  return security === "ssl" ? "SSL/TLS" : "STARTTLS";
}

/** 新しく入力するときの初めの値。ホストはメールアドレスのドメインから推し量る。 */
export function guessServerForm(kind: ServerKind, email: string): ServerForm {
  const domain = email.split("@")[1]?.trim().toLowerCase() ?? "";
  const security: Security = kind === "imap" ? "ssl" : "starttls";
  return {
    host: domain ? `${kind}.${domain}` : "",
    port: DEFAULT_PORTS[kind][security],
    security,
  };
}

export function serverFormOf(server: DiscoveredServer): ServerForm {
  // 暗号化しない設定 (plain) は持たない。STARTTLS として扱い、サーバーが対応していなければ接続できない。
  return {
    host: server.host,
    port: String(server.port),
    security: server.security === "ssl" ? "ssl" : "starttls",
  };
}

export function serverFormFromSaved(
  host: string | null,
  port: number | null,
  secure: boolean,
): ServerForm {
  return {
    host: host ?? "",
    port: port ? String(port) : "",
    security: secure ? "ssl" : "starttls",
  };
}

export function toServerSettings(form: ServerForm): ServerSettings {
  return {
    host: form.host.trim(),
    port: Number(form.port),
    secure: form.security === "ssl",
  };
}

/** 入力欄。セキュリティを変えたら、よく使われるポート番号も合わせて変える。 */
export function ServerFields(props: {
  idPrefix: string;
  kind: ServerKind;
  value: ServerForm;
  onChange: (next: ServerForm) => void;
  disabled?: boolean;
  /** 接続の確認の結果。失敗していれば欄の下に理由を出す。 */
  check?: ServerCheck | null;
}) {
  const { value, onChange, kind } = props;
  const changeSecurity = (security: Security) => {
    const other: Security = security === "ssl" ? "starttls" : "ssl";
    // 前のセキュリティの決まったポートのままなら、新しいセキュリティの決まったポートにする。
    const port =
      value.port === DEFAULT_PORTS[kind][other] || value.port === ""
        ? DEFAULT_PORTS[kind][security]
        : value.port;
    onChange({ ...value, security, port });
  };
  return (
    <fieldset className="flex flex-col gap-3" disabled={props.disabled}>
      <legend className="mb-3 flex items-center gap-2 font-medium text-sm">
        <ServerKindIcon kind={kind} />
        {kind === "imap" ? "受信 (IMAP)" : "送信 (SMTP)"}
      </legend>
      <div className="grid grid-cols-[1fr_6rem] gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${props.idPrefix}-host`}>サーバー</Label>
          <Input
            id={`${props.idPrefix}-host`}
            required
            maxLength={253}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={
              kind === "imap" ? "imap.example.com" : "smtp.example.com"
            }
            value={value.host}
            onChange={(event) =>
              onChange({ ...value, host: event.target.value })
            }
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${props.idPrefix}-port`}>ポート番号</Label>
          <Input
            id={`${props.idPrefix}-port`}
            type="text"
            inputMode="numeric"
            required
            // 1〜65535 の数字だけを受け付ける (ブラウザーの数値欄の上下ボタンは使わない)。
            pattern="[1-9][0-9]{0,4}"
            maxLength={5}
            autoComplete="off"
            value={value.port}
            onChange={(event) => {
              const digits = event.target.value.replace(/\D/g, "").slice(0, 5);
              onChange({
                ...value,
                port:
                  Number(digits) > 65535 ? "65535" : digits.replace(/^0+/, ""),
              });
            }}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label id={`${props.idPrefix}-security`}>セキュリティ</Label>
        <Select
          items={SECURITY_OPTIONS}
          value={value.security}
          onValueChange={(next) => {
            if (next === "ssl" || next === "starttls") changeSecurity(next);
          }}
          disabled={props.disabled}
        >
          <SelectTrigger
            aria-labelledby={`${props.idPrefix}-security`}
            className="w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SECURITY_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {props.check && <CheckResult kind={kind} check={props.check} />}
    </fieldset>
  );
}

function ServerKindIcon({ kind }: { kind: ServerKind }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md",
        kind === "imap"
          ? "bg-sky-500/15 text-sky-600 dark:text-sky-400"
          : "bg-violet-500/15 text-violet-600 dark:text-violet-400",
      )}
    >
      {kind === "imap" ? (
        <DownloadIcon className="size-3.5" />
      ) : (
        <UploadIcon className="size-3.5" />
      )}
    </span>
  );
}

const CHECK_REASONS: Record<
  Exclude<ServerCheck, { ok: true }>["reason"],
  string
> = {
  auth_failed:
    "ログインできませんでした。ユーザー名とパスワードを確認してください。",
  connection_failed:
    "接続できませんでした。サーバー、ポート番号、セキュリティを確認してください。",
  legacy_tls_required:
    "古い方式の TLS にしか対応していないサーバーです。「古い TLS のサーバーへの接続を許可する」をオンにしてください。",
  host_not_found: "サーバーが見つかりません。サーバー名を確認してください。",
  host_not_allowed: "このサーバーには接続できません。",
};

/** 接続の確認の結果を 1 行で出す。 */
export function CheckResult({
  kind,
  check,
}: {
  kind: ServerKind;
  check: ServerCheck;
}) {
  const name = kind === "imap" ? "受信" : "送信";
  if (check.ok) {
    return (
      <p className="flex items-start gap-1.5 text-emerald-600 text-xs dark:text-emerald-400">
        <CircleCheckIcon
          className="mt-px size-3.5 shrink-0"
          aria-hidden="true"
        />
        {name}サーバーに接続し、ログインできました。
      </p>
    );
  }
  return (
    <p className="flex items-start gap-1.5 text-destructive text-xs">
      <CircleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">
        {name}サーバー: {CHECK_REASONS[check.reason]}
        {check.detail ? ` (${check.detail})` : ""}
      </span>
    </p>
  );
}

const AUTH_LABELS: Record<DiscoveredServer["auth"], string> = {
  password: "通常のパスワード認証",
  oauth2: "OAuth2",
  other: "その他",
};

/** 見つかった設定の一覧 (受信と送信を並べる)。 */
export function ServerSummary(props: {
  imap: ServerForm;
  smtp: ServerForm;
  username: string;
  auth?: { imap: DiscoveredServer["auth"]; smtp: DiscoveredServer["auth"] };
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {(["imap", "smtp"] as const).map((kind) => {
        const server = props[kind];
        return (
          <section
            key={kind}
            aria-label={kind === "imap" ? "受信サーバー" : "送信サーバー"}
            className="flex min-w-0 flex-col gap-2 rounded-lg border bg-muted/30 p-3"
          >
            <div className="flex items-center gap-2">
              <ServerKindIcon kind={kind} />
              <div className="leading-tight">
                <p className="font-medium text-sm">
                  {kind === "imap" ? "受信" : "送信"}
                </p>
                <p className="text-muted-foreground text-xs">
                  {kind === "imap" ? "IMAP" : "SMTP"}
                </p>
              </div>
            </div>
            <dl className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-x-1.5 gap-y-1.5 text-xs">
              <SummaryRow
                icon={GlobeIcon}
                label="サーバー"
                value={server.host}
              />
              <SummaryRow
                icon={HashIcon}
                label="ポート番号"
                value={server.port}
              />
              <SummaryRow
                icon={ShieldIcon}
                label="セキュリティ"
                value={securityLabel(server.security)}
              />
              <SummaryRow
                icon={UserIcon}
                label="ユーザー名"
                value={props.username}
              />
              <SummaryRow
                icon={KeyRoundIcon}
                label="認証"
                value={AUTH_LABELS[props.auth?.[kind] ?? "password"]}
              />
            </dl>
          </section>
        );
      })}
    </div>
  );
}

function SummaryRow(props: {
  icon: typeof GlobeIcon;
  label: string;
  value: string;
}) {
  const Icon = props.icon;
  return (
    <>
      <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
      <dt className="text-muted-foreground">{props.label}:</dt>
      <dd className="truncate font-medium" title={props.value}>
        {props.value}
      </dd>
    </>
  );
}

const SOURCE_LABELS: Record<DiscoveredSettings["source"], string> = {
  preset: "よく使われるメールサービスの設定",
  autoconfig: "メールサービスの自動設定 (autoconfig)",
  "well-known": "メールサービスの自動設定 (.well-known)",
  ispdb: "Thunderbird の設定データベース",
  mx: "MX レコードから分かったメールサービスの設定",
  autodiscover: "メールサービスの自動設定 (Autodiscover)",
  srv: "DNS の SRV レコード",
};

export function discoverySourceLabel(source: DiscoveredSettings["source"]) {
  return SOURCE_LABELS[source];
}
