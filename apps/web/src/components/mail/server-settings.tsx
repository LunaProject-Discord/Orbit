"use client";

/**
 * 受信 (IMAP / POP3) と送信 (SMTP) のサーバー設定の部品。アカウントの追加画面と、
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
import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type {
  DiscoveredServer,
  DiscoveredSettings,
  IncomingProtocol,
  PopSettings,
  ServerCheck,
  ServerSettings,
} from "@/lib/api";

/**
 * サーバーの種類。imap は受信サーバーのことで、受信方式が POP3 のときも imap と呼ぶ
 * (API の項目名に合わせている)。受信方式は IncomingProtocol で別に持つ。
 */
export type ServerKind = "imap" | "smtp";

/** 画面で選べるセキュリティ。保存するのは「最初から TLS か (secure)」だけ。 */
export type Security = "ssl" | "starttls";

/** 入力中のサーバー設定。ポートは入力の途中で空にできるよう文字列で持つ。 */
export type ServerForm = { host: string; port: string; security: Security };

export const SECURITY_OPTIONS = [
  { value: "ssl", label: "SSL/TLS" },
  { value: "starttls", label: "STARTTLS" },
] as const;

const DEFAULT_PORTS: Record<ServerKind | "pop3", Record<Security, string>> = {
  imap: { ssl: "993", starttls: "143" },
  pop3: { ssl: "995", starttls: "110" },
  smtp: { ssl: "465", starttls: "587" },
};

/** よく使われるポート番号。受信サーバーは受信方式 (IMAP / POP3) で変わる。 */
function defaultPort(
  kind: ServerKind,
  protocol: IncomingProtocol,
  security: Security,
): string {
  return DEFAULT_PORTS[kind === "imap" ? protocol : "smtp"][security];
}

/** 受信方式の表示名。 */
export function incomingProtocolLabel(protocol: IncomingProtocol): string {
  return protocol === "pop3" ? "POP3" : "IMAP";
}

/** POP3 で受信するときの初めの値。受信したメールはサーバーに残し、消さない。 */
export const DEFAULT_POP_SETTINGS: PopSettings = {
  leaveOnServer: true,
  deleteAfterDays: null,
};

export function securityLabel(security: Security): string {
  return security === "ssl" ? "SSL/TLS" : "STARTTLS";
}

/** 推し量ったホスト名。imap.example.com、pop.example.com、smtp.example.com のようにする。 */
function guessHost(
  kind: ServerKind,
  protocol: IncomingProtocol,
  email: string,
): string {
  const domain = email.split("@")[1]?.trim().toLowerCase() ?? "";
  if (!domain) return "";
  const prefix =
    kind === "smtp" ? "smtp" : protocol === "pop3" ? "pop" : "imap";
  return `${prefix}.${domain}`;
}

/** 新しく入力するときの初めの値。ホストはメールアドレスのドメインから推し量る。 */
export function guessServerForm(
  kind: ServerKind,
  email: string,
  protocol: IncomingProtocol = "imap",
): ServerForm {
  const security: Security = kind === "imap" ? "ssl" : "starttls";
  return {
    host: guessHost(kind, protocol, email),
    port: defaultPort(kind, protocol, security),
    security,
  };
}

/**
 * 受信方式を切り替えたときの受信サーバーの入力。前の方式の決まったポート番号や、
 * 推し量ったホスト名のまま (手で変えていない) なら、新しい方式に合わせて変える。
 */
export function switchIncomingServerForm(
  form: ServerForm,
  from: IncomingProtocol,
  to: IncomingProtocol,
  email: string,
): ServerForm {
  if (from === to) return form;
  const port =
    form.port === "" || form.port === defaultPort("imap", from, form.security)
      ? defaultPort("imap", to, form.security)
      : form.port;
  const host =
    form.host.trim() === guessHost("imap", from, email)
      ? guessHost("imap", to, email)
      : form.host;
  return { ...form, host, port };
}

/**
 * 受信専用のアカウントに送信サーバーを設定し直すときの初めの値。送信サーバーは受信サーバーと
 * 同じホストであることが多いので、受信サーバーのホストと SSL/TLS の決まったポート番号にする。
 */
export function smtpFormFromIncoming(incomingHost: string | null): ServerForm {
  return {
    host: incomingHost ?? "",
    port: DEFAULT_PORTS.smtp.ssl,
    security: "ssl",
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
  /** 受信サーバー (kind が imap) の受信方式。省略すると IMAP。 */
  protocol?: IncomingProtocol;
  value: ServerForm;
  onChange: (next: ServerForm) => void;
  disabled?: boolean;
  /** 接続の確認の結果。失敗していれば欄の下に理由を出す。 */
  check?: ServerCheck | null;
}) {
  const { value, onChange, kind } = props;
  const protocol = props.protocol ?? "imap";
  const changeSecurity = (security: Security) => {
    const other: Security = security === "ssl" ? "starttls" : "ssl";
    // 前のセキュリティの決まったポートのままなら、新しいセキュリティの決まったポートにする。
    const port =
      value.port === defaultPort(kind, protocol, other) || value.port === ""
        ? defaultPort(kind, protocol, security)
        : value.port;
    onChange({ ...value, security, port });
  };
  return (
    <fieldset className="flex flex-col gap-3" disabled={props.disabled}>
      <legend className="mb-3 flex items-center gap-2 font-medium text-sm">
        <ServerKindIcon kind={kind} />
        {kind === "imap"
          ? `受信 (${incomingProtocolLabel(protocol)})`
          : "送信 (SMTP)"}
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
              kind === "smtp"
                ? "smtp.example.com"
                : protocol === "pop3"
                  ? "pop.example.com"
                  : "imap.example.com"
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
  /** 送信サーバー。null は受信専用 (送信サーバーを使わない)。 */
  smtp: ServerForm | null;
  /** 受信方式。省略すると IMAP。 */
  incomingProtocol?: IncomingProtocol;
  username: string;
  auth?: { imap: DiscoveredServer["auth"]; smtp: DiscoveredServer["auth"] };
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {(["imap", "smtp"] as const).map((kind) => {
        const server = props[kind];
        if (!server) {
          return (
            <section
              key={kind}
              aria-label="送信サーバー"
              className="flex min-w-0 flex-col gap-2 rounded-lg border border-dashed p-3"
            >
              <div className="flex items-center gap-2">
                <ServerKindIcon kind={kind} />
                <div className="leading-tight">
                  <p className="font-medium text-sm">送信</p>
                  <p className="text-muted-foreground text-xs">受信専用</p>
                </div>
              </div>
              <p className="text-muted-foreground text-xs leading-relaxed">
                {RECEIVE_ONLY_NOTE}
              </p>
            </section>
          );
        }
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
                  {kind === "imap"
                    ? incomingProtocolLabel(props.incomingProtocol ?? "imap")
                    : "SMTP"}
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

/** 受信専用にしたときの案内。 */
const RECEIVE_ONLY_NOTE =
  "送信サーバーを使いません。このアカウントからは送信できません。返信や新規作成は、ほかのアカウントから送ります。";

/**
 * 受信専用にする (送信サーバーを使わない) かのスイッチ。送信 (SMTP) の欄のすぐ上に置き、
 * オンのあいだは送信の欄を隠す。送信サーバーにつながらないメールサービスでも、受信だけは使える。
 */
export function ReceiveOnlySwitch(props: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3">
      <div className="min-w-0 flex-1">
        <p id={`${id}-label`} className="font-medium text-sm">
          受信専用にする (送信サーバーを使わない)
        </p>
        <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
          {props.checked
            ? "このアカウントからは送信できません。返信や新規作成は、ほかのアカウントから送ります。"
            : "送信サーバーにつながらない場合や、このアカウントから送ることがない場合はオンにしてください。"}
        </p>
      </div>
      <Switch
        aria-labelledby={`${id}-label`}
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onCheckedChange}
      />
    </div>
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

/**
 * 受信方式 (IMAP / POP3) を選ぶ部品。POP3 を選んでいるときは、IMAP との違いの案内も出す。
 */
export function IncomingProtocolPicker(props: {
  value: IncomingProtocol;
  onChange: (next: IncomingProtocol) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <span id={`${id}-label`} className="font-medium text-sm leading-none">
        受信方式
      </span>
      <div
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        className="grid grid-cols-2 gap-2"
      >
        {(["imap", "pop3"] as const).map((protocol) => {
          const selected = props.value === protocol;
          return (
            // biome-ignore lint/a11y/useSemanticElements: 見た目をボタンにそろえるため、radio の役割を持つボタンにしている
            <button
              key={protocol}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={props.disabled}
              onClick={() => props.onChange(protocol)}
              className={cn(
                "flex items-center justify-center rounded-lg border px-3 py-2 text-sm outline-none transition-colors hover:bg-muted/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
                selected && "border-primary bg-muted font-medium",
              )}
            >
              {incomingProtocolLabel(protocol)}
            </button>
          );
        })}
      </div>
      {props.value === "pop3" && <PopNotice />}
    </div>
  );
}

/** POP3 でできないことの案内。 */
export function PopNotice() {
  return (
    <p className="text-muted-foreground text-xs leading-relaxed">
      POP3
      では、既読やフォルダの状態をほかのメールソフトと同期できません。メールサービスが
      IMAP に対応している場合は、IMAP をおすすめします。
    </p>
  );
}

/** サーバーから消すまでの日数の選択肢。value は Select で扱うための文字列。 */
const POP_DELETE_AFTER_DAYS = [7, 14, 30, 90, 180];

/** 日数の選択肢。決まった選択肢に無い日数が保存されていれば、それも加える。 */
export function popDeleteOptions(current: number | null) {
  const days =
    current !== null && !POP_DELETE_AFTER_DAYS.includes(current)
      ? [...POP_DELETE_AFTER_DAYS, current].sort((a, b) => a - b)
      : POP_DELETE_AFTER_DAYS;
  return [
    { value: "never", label: "削除しない" },
    ...days.map((day) => ({ value: String(day), label: `${day} 日後` })),
  ];
}

/**
 * POP3 で受信したメールをサーバーに残すかどうかと、残すときに何日でサーバーから消すか。
 * アカウントの追加画面とサーバー設定で使う。
 */
export function PopOptions(props: {
  value: PopSettings;
  onChange: (next: PopSettings) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const { value, onChange } = props;
  const options = popDeleteOptions(value.deleteAfterDays);
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p id={`${id}-leave`} className="font-medium text-sm">
            受信したメールをサーバーに残す
          </p>
          <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
            {value.leaveOnServer
              ? "受信したあともサーバーにメールを残すので、ほかの端末やメールソフトでも受け取れます。"
              : "受信したメールはサーバーから削除します。ほかの端末やメールソフトでは受け取れなくなります。"}
          </p>
        </div>
        <Switch
          aria-labelledby={`${id}-leave`}
          checked={value.leaveOnServer}
          disabled={props.disabled}
          onCheckedChange={(checked) =>
            onChange({ ...value, leaveOnServer: checked })
          }
        />
      </div>
      {value.leaveOnServer && (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p id={`${id}-delete`} className="font-medium text-sm">
              サーバーから削除するまでの日数
            </p>
            <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
              受信してから選んだ日数がたったメールを、サーバーから削除します。このアプリで完全に削除したメールは、日数に関係なくサーバーからも削除します。
            </p>
          </div>
          <Select
            items={options}
            value={
              value.deleteAfterDays === null
                ? "never"
                : String(value.deleteAfterDays)
            }
            onValueChange={(next) =>
              onChange({
                ...value,
                deleteAfterDays:
                  next === "never" || next === null ? null : Number(next),
              })
            }
            disabled={props.disabled}
          >
            <SelectTrigger
              size="sm"
              aria-labelledby={`${id}-delete`}
              className="shrink-0"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" className="w-auto">
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
