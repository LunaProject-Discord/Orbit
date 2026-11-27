"use client";

import {
  CheckIcon,
  CopyIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useState,
} from "react";
import { showNotice } from "@/components/mail/toasts";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  createSsoProvider,
  deleteSsoProvider,
  listSsoProviders,
  type SsoProvider,
  type SsoProviderInput,
  type SsoTokenAuthMethod,
  updateSsoProvider,
} from "@/lib/admin-api";
import { ApiError, NetworkError } from "@/lib/api";

function messageOf(error: unknown): string {
  if (error instanceof NetworkError) {
    return "サーバーに接続できませんでした。ネットワークの状態を確認してください。";
  }
  if (error instanceof ApiError) {
    const detail = (error.body as { detail?: string } | null)?.detail;
    switch (error.code) {
      case "too_many":
        return "登録できる数の上限 (20) に達しています。不要なものを削除してください。";
      case "endpoints_required":
        return "OpenID Connect の設定の URL か、3 つの URL (認可・トークン・プロフィール) をすべて入力してください。";
      case "invalid_url":
        return "URL が正しくありません。https:// で始まる URL を入力してください。";
      case "private_url":
        return "サーバーの内部ネットワークを指す URL は使えません。";
      case "discovery_failed":
        return `OpenID Connect の設定を読み込めませんでした。URL を確かめてください。${detail ? ` (${detail})` : ""}`;
      case "not_found":
        return "このログイン方法は、すでに削除されています。";
    }
    if (error.status === 400) {
      return "入力内容が正しくありません。各項目を確かめてください。";
    }
  }
  return "処理できませんでした。時間をおいてもう一度お試しください。";
}

const AUTH_METHODS: { value: SsoTokenAuthMethod; label: string }[] = [
  { value: "client_secret_basic", label: "Basic 認証 (client_secret_basic)" },
  { value: "client_secret_post", label: "本文に含める (client_secret_post)" },
];

const ENDPOINT_MODES = [
  { value: "discovery", label: "OpenID Connect の設定から読み込む" },
  { value: "manual", label: "URL を直接入力する" },
];

/** 一覧での設定の要約。 */
function summaryOf(provider: SsoProvider): string {
  const parts = [
    provider.allowSignUp
      ? provider.allowedDomains.length > 0
        ? `自動作成 (${provider.allowedDomains.join(", ")})`
        : "自動作成"
      : "自動作成しない",
  ];
  if (provider.trustEmail) parts.push("メールアドレスを信頼");
  if (provider.skipTwoFactor) parts.push("2 段階認証を省略");
  parts.push(`結び付け ${provider.linkedUsers} 人`);
  return parts.join(" ・ ");
}

/** 管理画面の「シングルサインオン」のページ。 */
export function SsoSettings() {
  const [data, setData] = useState<{
    redirectUri: string;
    providers: SsoProvider[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 編集中の設定。null は閉じている、"new" は追加。 */
  const [editing, setEditing] = useState<SsoProvider | "new" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SsoProvider | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setData(await listSsoProviders(signal));
      setError(null);
    } catch (cause) {
      if (signal?.aborted) return;
      setError(messageOf(cause));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <>
      {data && <RedirectUri value={data.redirectUri} />}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
            <h3 className="font-semibold text-base">ログイン方法</h3>
            <p className="text-muted-foreground text-sm">
              有効なものが、ログイン画面に「〇〇
              でログイン」のボタンとして並びます。
            </p>
          </div>
          <Button size="sm" onClick={() => setEditing("new")}>
            <PlusIcon />
            追加
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        {data === null && !error && (
          <p className="text-muted-foreground text-sm">読み込み中…</p>
        )}
        {data && data.providers.length === 0 && (
          <p className="rounded-lg border px-3 py-2.5 text-muted-foreground text-sm">
            まだ登録されていません。
          </p>
        )}
        {data && data.providers.length > 0 && (
          <ul
            className="flex flex-col divide-y rounded-lg border"
            data-sso-providers
          >
            {data.providers.map((provider) => (
              <li
                key={provider.id}
                className="flex items-center gap-2 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-medium text-sm">
                    <span className="truncate">{provider.name}</span>
                    {!provider.enabled && (
                      <Badge variant="outline" className="shrink-0">
                        無効
                      </Badge>
                    )}
                  </p>
                  <p className="truncate text-muted-foreground text-xs">
                    {summaryOf(provider)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${provider.name} を編集`}
                  onClick={() => setEditing(provider)}
                >
                  <PencilIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${provider.name} を削除`}
                  onClick={() => setDeleteTarget(provider)}
                >
                  <Trash2Icon />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ProviderDialog
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              「{deleteTarget?.name}」を削除しますか？
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget && deleteTarget.linkedUsers > 0
                ? `結び付けている ${deleteTarget.linkedUsers} 人の利用者は、このログイン方法ではログインできなくなります。パスワードなどほかの方法を持たない利用者は、ログインできなくなります。一時的に止めるだけなら、編集で「有効」をオフにしてください。`
                : "ログイン画面からボタンがなくなります。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const target = deleteTarget;
                if (!target) return;
                setDeleteTarget(null);
                deleteSsoProvider(target.id)
                  .catch((cause: unknown) => {
                    if (!(cause instanceof ApiError && cause.status === 404)) {
                      showNotice(messageOf(cause));
                    }
                  })
                  .finally(() => void load());
              }}
            >
              削除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function RedirectUri({ value }: { value: string }) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  return (
    <section className="flex flex-col gap-2">
      <Label htmlFor={id} className="font-semibold text-base">
        リダイレクト URI
      </Label>
      <p className="text-muted-foreground text-sm">
        IdP (ログイン先のサービス) にアプリを登録するときに、この URL
        を指定してください。すべてのログイン方法で同じです。
      </p>
      <div className="flex gap-2">
        <Input
          id={id}
          readOnly
          value={value}
          className="font-mono text-xs"
          onFocus={(event) => event.target.select()}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(value)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "コピーしました" : "コピー"}
        </Button>
      </div>
    </section>
  );
}

type Form = Omit<SsoProviderInput, "allowedDomains"> & {
  endpointMode: "discovery" | "manual";
  /** 空白・カンマ・改行で区切ったドメイン。 */
  allowedDomains: string;
};

const EMPTY_FORM: Form = {
  name: "",
  clientId: "",
  clientSecret: "",
  endpointMode: "discovery",
  discoveryUrl: "",
  authorizationUrl: "",
  tokenUrl: "",
  userInfoUrl: "",
  scopes: "openid email profile",
  subjectClaim: "sub",
  emailClaim: "email",
  nameClaim: "name",
  tokenAuthMethod: "client_secret_basic",
  usePkce: true,
  allowSignUp: false,
  allowedDomains: "",
  trustEmail: false,
  skipTwoFactor: false,
  suggestMailAccount: false,
  enabled: true,
};

function formOf(provider: SsoProvider): Form {
  return {
    ...provider,
    clientSecret: "",
    endpointMode: provider.discoveryUrl ? "discovery" : "manual",
    discoveryUrl: provider.discoveryUrl ?? "",
    authorizationUrl: provider.authorizationUrl ?? "",
    tokenUrl: provider.tokenUrl ?? "",
    userInfoUrl: provider.userInfoUrl ?? "",
    allowedDomains: provider.allowedDomains.join(", "),
  };
}

function inputOf(form: Form): SsoProviderInput {
  const discovery = form.endpointMode === "discovery";
  const text = (value: string | null) => value?.trim() || null;
  return {
    name: form.name.trim(),
    clientId: form.clientId.trim(),
    clientSecret: form.clientSecret,
    discoveryUrl: discovery ? text(form.discoveryUrl) : null,
    authorizationUrl: discovery ? null : text(form.authorizationUrl),
    tokenUrl: discovery ? null : text(form.tokenUrl),
    userInfoUrl: discovery ? null : text(form.userInfoUrl),
    scopes: form.scopes.trim(),
    subjectClaim: form.subjectClaim.trim(),
    emailClaim: form.emailClaim.trim(),
    nameClaim: form.nameClaim.trim(),
    tokenAuthMethod: form.tokenAuthMethod,
    usePkce: form.usePkce,
    allowSignUp: form.allowSignUp,
    allowedDomains: form.allowedDomains
      .split(/[\s,、]+/)
      .map((domain) => domain.trim().replace(/^@/, "").toLowerCase())
      .filter(Boolean),
    trustEmail: form.trustEmail,
    skipTwoFactor: form.skipTwoFactor,
    suggestMailAccount: form.suggestMailAccount,
    enabled: form.enabled,
  };
}

function ProviderDialog(props: {
  target: SsoProvider | "new" | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const id = useId();
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { target } = props;
  const isNew = target === "new";

  // 開くたびに、入力を対象の設定に戻す。
  useEffect(() => {
    if (target === null) return;
    setForm(target === "new" ? EMPTY_FORM : formOf(target));
    setError(null);
    setSubmitting(false);
  }, [target]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (target === null) return;
    setError(null);
    setSubmitting(true);
    try {
      const input = inputOf(form);
      if (target === "new") await createSsoProvider(input);
      else await updateSsoProvider(target.id, input);
      props.onSaved();
    } catch (cause) {
      setError(messageOf(cause));
      setSubmitting(false);
    }
  }

  const field = (
    key: keyof Form,
    label: string,
    options: {
      type?: string;
      required?: boolean;
      placeholder?: string;
      hint?: ReactNode;
      maxLength?: number;
    } = {},
  ) => (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`${id}-${key}`}>{label}</Label>
      <Input
        id={`${id}-${key}`}
        type={options.type ?? "text"}
        required={options.required}
        placeholder={options.placeholder}
        maxLength={options.maxLength ?? 2000}
        autoComplete="off"
        value={String(form[key] ?? "")}
        onChange={(event) => set(key, event.target.value as never)}
      />
      {options.hint && (
        <p className="text-muted-foreground text-xs leading-relaxed">
          {options.hint}
        </p>
      )}
    </div>
  );

  const toggle = (
    key:
      | "usePkce"
      | "allowSignUp"
      | "trustEmail"
      | "skipTwoFactor"
      | "suggestMailAccount"
      | "enabled",
    label: string,
    description: string,
  ) => (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label id={`${id}-${key}`}>{label}</Label>
        <p
          id={`${id}-${key}-description`}
          className="text-muted-foreground text-xs leading-relaxed"
        >
          {description}
        </p>
      </div>
      <Switch
        aria-labelledby={`${id}-${key}`}
        aria-describedby={`${id}-${key}-description`}
        checked={form[key]}
        onCheckedChange={(checked) => set(key, checked === true)}
      />
    </div>
  );

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto sm:max-w-[560px]">
        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>
              {isNew ? "ログイン方法を追加" : "ログイン方法を編集"}
            </DialogTitle>
            <DialogDescription>
              OAuth 2.0 / OpenID Connect に対応した IdP を登録します。値は IdP
              にアプリを登録したときに表示されます。
            </DialogDescription>
          </DialogHeader>

          {field("name", "表示名", {
            required: true,
            maxLength: 60,
            placeholder: "例: 社内アカウント",
            hint: "ログイン画面に「表示名 でログイン」と表示します。",
          })}
          {field("clientId", "クライアント ID", {
            required: true,
            maxLength: 500,
          })}
          {field("clientSecret", "クライアントシークレット", {
            type: "password",
            required: isNew,
            hint: isNew
              ? "暗号化して保存します。あとから表示することはできません。"
              : "変更するときだけ入力してください。空のままなら、保存してあるものを使います。",
          })}

          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-endpointMode`}>IdP の URL</Label>
            <Select
              items={ENDPOINT_MODES}
              value={form.endpointMode}
              onValueChange={(next) => {
                if (next === "discovery" || next === "manual") {
                  set("endpointMode", next);
                }
              }}
            >
              <SelectTrigger id={`${id}-endpointMode`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENDPOINT_MODES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {form.endpointMode === "discovery" ? (
            field("discoveryUrl", "OpenID Connect の設定の URL", {
              type: "url",
              required: true,
              placeholder:
                "https://idp.example.com/.well-known/openid-configuration",
              hint: "保存するときに読み込んで確かめます。",
            })
          ) : (
            <>
              {field("authorizationUrl", "認可 URL", {
                type: "url",
                required: true,
                placeholder: "https://mail.example.com/oauth/authorize",
              })}
              {field("tokenUrl", "トークン URL", {
                type: "url",
                required: true,
                placeholder: "https://mail.example.com/oauth/token",
              })}
              {field("userInfoUrl", "プロフィール (UserInfo) URL", {
                type: "url",
                required: true,
                placeholder: "https://mail.example.com/oauth/profile",
              })}
            </>
          )}
          {field("scopes", "スコープ", {
            maxLength: 500,
            hint: "空白で区切ります。OpenID Connect なら「openid email profile」が一般的です。",
          })}

          <fieldset className="flex flex-col gap-4 rounded-lg border p-3">
            <legend className="px-1 font-medium text-sm">
              プロフィールの項目名
            </legend>
            <p className="-mt-2 text-muted-foreground text-xs leading-relaxed">
              IdP
              のプロフィールのどの項目を使うか。入れ子の項目は「a.b」と書きます。ID
              は利用者ごとに変わらない値にしてください。ID の項目名か IdP の URL
              のホストを変えると、結び付けは解除され、次のログインで結び付け直します。
            </p>
            {field("subjectClaim", "ID", { required: true, maxLength: 100 })}
            {field("emailClaim", "メールアドレス", {
              required: true,
              maxLength: 100,
            })}
            {field("nameClaim", "名前", { required: true, maxLength: 100 })}
          </fieldset>

          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-tokenAuthMethod`}>
              トークン取得時のシークレットの送り方
            </Label>
            <Select
              items={AUTH_METHODS}
              value={form.tokenAuthMethod}
              onValueChange={(next) => {
                if (
                  next === "client_secret_basic" ||
                  next === "client_secret_post"
                ) {
                  set("tokenAuthMethod", next);
                }
              }}
            >
              <SelectTrigger id={`${id}-tokenAuthMethod`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUTH_METHODS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {toggle(
            "usePkce",
            "PKCE を使う",
            "対応していない IdP でログインが失敗するときだけ、オフにしてください。",
          )}

          <div className="h-px bg-border" />

          {toggle(
            "allowSignUp",
            "Orbit のアカウントを自動で作る",
            "初めてログインした人の Orbit のアカウントを作ります。オフなら、すでにある利用者だけがログインできます。",
          )}
          {form.allowSignUp &&
            field("allowedDomains", "自動で作るメールアドレスのドメイン", {
              maxLength: 13000,
              placeholder: "例: example.com, example.jp",
              hint: "カンマか空白で区切ります。空なら、すべてのドメインで作ります。",
            })}
          {toggle(
            "trustEmail",
            "メールアドレスを信頼する",
            "同じメールアドレスの利用者がいれば、自動で結び付けます。IdP がメールアドレスの持ち主を確かめている場合だけオンにしてください。IdP が「確かめていない」(email_verified: false) と返したときと、メールアドレスを決めない招待で登録した利用者には結び付けません。",
          )}
          {toggle(
            "skipTwoFactor",
            "Orbit の 2 段階認証を省略する",
            "IdP 側で 2 段階認証をしている場合に。オフなら、2 段階認証を設定した利用者にはコードを求めます。",
          )}
          {toggle(
            "suggestMailAccount",
            "メールアカウントの追加を案内する",
            "自動で作った利用者が初めてログインしたときに、メールアカウントの追加を案内します。",
          )}
          {toggle(
            "enabled",
            "有効",
            "オフにすると、ログイン画面に表示されず、この方法ではログインできなくなります。",
          )}

          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              キャンセル
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
