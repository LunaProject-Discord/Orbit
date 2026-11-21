"use client";

import { cn } from "cn";
import {
  BellIcon,
  BellOffIcon,
  CheckIcon,
  CircleAlertIcon,
  LogOutIcon,
  MenuIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  SignatureIcon,
  SunIcon,
  Trash2Icon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useId, useState } from "react";
import { SyncIndicator } from "@/components/mail/sync-indicator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ACCOUNT_COLORS,
  type AccountColorName,
  accountColorName,
} from "@/lib/account-colors";
import {
  type Account,
  oauthProviderOf,
  type User,
  updateAccount,
} from "@/lib/api";
import { htmlHasContent } from "@/lib/compose";
import type { NotificationStatus } from "@/lib/notifications";
import type { SyncStatus } from "@/lib/sync-status";

const notificationDescriptions: Record<NotificationStatus, string> = {
  unsupported: "このブラウザーでは、新着メールの通知を出せません。",
  off: "新着メールが届いても、通知は出しません。",
  blocked:
    "ブラウザーの設定で、このサイトの通知が拒否されています。通知を出すには、ブラウザーの設定で許可してください。",
  page: "新着メールを通知します。この画面を開いている間だけ届きます。",
  push: "新着メールを通知します。この画面を閉じていても届きます。",
};

const accountProblems: Partial<Record<Account["status"], string>> = {
  auth_required: "再ログインが必要です",
  error: "同期でエラーが発生しています",
  disabled: "同期を停止しています",
};

const themes = [
  { value: "light", label: "ライト", icon: SunIcon },
  { value: "dark", label: "ダーク", icon: MoonIcon },
  { value: "system", label: "システム", icon: MonitorIcon },
] as const;

const shortcuts: [keys: string, action: string][] = [
  ["J / ↓、K / ↑", "次のメール、前のメール"],
  ["U / Esc", "メールを閉じる、選択をやめる"],
  ["C", "新規作成"],
  ["R、Shift+R、F", "返信、全員に返信、転送"],
  ["/", "検索"],
  ["X", "メールを選択"],
  ["M", "既読と未読を切り替え"],
  ["Shift+I、Shift+U", "既読にする、未読にする"],
  ["S", "スターを付ける、外す"],
  ["E / A", "アーカイブ"],
  ["# / Delete", "削除"],
  ["V", "移動"],
];

type Props = {
  user: User;
  /** 読み込み前は null。 */
  accounts: Account[] | null;
  /** 狭い画面で、サイドバーを開く。 */
  onMenu: () => void;
  notificationStatus: NotificationStatus;
  notificationBusy: boolean;
  onNotificationChange: (enabled: boolean) => void;
  syncStatus: SyncStatus;
  /** いまサーバーに接続している端末の数 (この端末を含む)。 */
  devices: number;
  onAdd: () => void;
  onDelete: (account: Account) => void;
  onEditSignature: (account: Account) => void;
  onReauth: (account: Account) => void;
  /** 表示名や色を変えたアカウントを、画面に反映する。 */
  onAccountUpdated: (account: Account) => void;
  onSignOut: () => void;
};

/** 設定画面。表示、通知、メールアカウント、同期の状況、ログアウトをまとめる。 */
export function SettingsView({
  user,
  accounts,
  onMenu,
  notificationStatus,
  notificationBusy,
  onNotificationChange,
  syncStatus,
  devices,
  onAdd,
  onDelete,
  onEditSignature,
  onReauth,
  onAccountUpdated,
  onSignOut,
}: Props) {
  const { theme, setTheme } = useTheme();
  // テーマはこの端末に保存した値なので、サーバーで作った HTML と食い違わないよう、表示してから読む。
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const notifying =
    notificationStatus === "page" || notificationStatus === "push";
  const canToggleNotification =
    notificationStatus !== "unsupported" && notificationStatus !== "blocked";

  return (
    <section aria-label="設定" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="メニューを開く"
          aria-controls="mail-sidebar"
          onClick={onMenu}
          className="-ml-2 md:hidden"
        >
          <MenuIcon />
        </Button>
        <h1 className="font-semibold text-lg">設定</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-4 sm:p-6">
          <Section
            title="表示"
            description="画面の配色を選びます。システムにすると、端末の設定に合わせて切り替わります。"
          >
            <div
              role="radiogroup"
              aria-label="テーマ"
              className="grid grid-cols-3 gap-2"
            >
              {themes.map((item) => {
                const selected = mounted && theme === item.value;
                return (
                  // biome-ignore lint/a11y/useSemanticElements: 見た目をボタンにそろえるため、radio の役割を持つボタンにしている
                  <button
                    key={item.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setTheme(item.value)}
                    className={cn(
                      "flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm outline-none transition-colors hover:bg-muted/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-4",
                      selected && "border-primary bg-muted font-medium",
                    )}
                  >
                    <item.icon aria-hidden="true" />
                    {item.label}
                  </button>
                );
              })}
            </div>
          </Section>

          <Section
            title="通知"
            description="新着メールの通知は、端末 (ブラウザー) ごとに切り替えます。"
          >
            <div className="flex items-center gap-3 rounded-lg border p-3">
              {notifying ? (
                <BellIcon className="size-4 shrink-0" aria-hidden="true" />
              ) : (
                <BellOffIcon
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-medium text-sm">
                  この端末の通知: {notifying ? "オン" : "オフ"}
                </p>
                <p className="text-muted-foreground text-xs leading-relaxed">
                  {notificationDescriptions[notificationStatus]}
                </p>
              </div>
              {canToggleNotification && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={notificationBusy}
                  onClick={() => onNotificationChange(!notifying)}
                >
                  {notifying ? "オフにする" : "オンにする"}
                </Button>
              )}
            </div>
          </Section>

          <Section
            title="メールアカウント"
            description="表示名、色、署名はすべての端末で共通です。並び順は、サイドバーでドラッグして変えられます。"
          >
            {accounts === null ? (
              <p className="text-muted-foreground text-sm">読み込み中…</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {accounts.map((account) => (
                  <AccountCard
                    key={account.id}
                    account={account}
                    accounts={accounts}
                    onDelete={onDelete}
                    onEditSignature={onEditSignature}
                    onReauth={onReauth}
                    onUpdated={onAccountUpdated}
                  />
                ))}
              </ul>
            )}
            <div>
              <Button variant="outline" onClick={onAdd}>
                <PlusIcon />
                アカウントを追加
              </Button>
            </div>
          </Section>

          <Section
            title="同期"
            description="メールはサーバーが常に同期し、既読や移動などの操作はすべての端末に反映されます。"
          >
            <div className="flex flex-col gap-2 rounded-lg border p-3">
              <SyncIndicator status={syncStatus} />
              <p className="text-muted-foreground text-xs">
                {devices > 0
                  ? `いま接続している端末: ${devices} 台 (この端末を含む)`
                  : "いま接続している端末の数は、サーバーに接続すると表示されます。"}
              </p>
            </div>
          </Section>

          <Section title="ショートカットキー">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              {shortcuts.map(([keys, action]) => (
                <div key={keys} className="contents">
                  <dt>
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 font-sans text-xs">
                      {keys}
                    </kbd>
                  </dt>
                  <dd className="text-muted-foreground">{action}</dd>
                </div>
              ))}
            </dl>
          </Section>

          <Section title="ログイン中の利用者">
            <div className="flex items-center gap-3 rounded-lg border p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-sm">{user.name}</p>
                <p className="truncate text-muted-foreground text-xs">
                  {user.email}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={onSignOut}>
                <LogOutIcon />
                ログアウト
              </Button>
            </div>
          </Section>
        </div>
      </div>
    </section>
  );
}

function Section(props: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold text-base">{props.title}</h2>
        {props.description && (
          <p className="text-muted-foreground text-sm">{props.description}</p>
        )}
      </div>
      {props.children}
    </section>
  );
}

function AccountCard({
  account,
  accounts,
  onDelete,
  onEditSignature,
  onReauth,
  onUpdated,
}: {
  account: Account;
  accounts: Account[];
  onDelete: Props["onDelete"];
  onEditSignature: Props["onEditSignature"];
  onReauth: Props["onReauth"];
  onUpdated: Props["onAccountUpdated"];
}) {
  const id = useId();
  const [name, setName] = useState(account.displayName ?? "");
  const [error, setError] = useState<string | null>(null);
  // ほかの端末で変わった表示名を、入力していない間は反映する。
  const [shownName, setShownName] = useState(account.displayName);
  if (shownName !== account.displayName) {
    setShownName(account.displayName);
    setName(account.displayName ?? "");
  }
  const problem = accountProblems[account.status];
  const provider = oauthProviderOf(account);
  const color = accountColorName(accounts, account.id);

  const save = (patch: Parameters<typeof updateAccount>[1]) => {
    setError(null);
    updateAccount(account.id, patch)
      .then(onUpdated)
      .catch(() => {
        setError("変更を保存できませんでした。もう一度お試しください。");
        setName(account.displayName ?? "");
      });
  };
  const saveName = () => {
    const next = name.trim() || null;
    if (next !== account.displayName) save({ displayName: next });
  };
  const chooseColor = (next: AccountColorName) => {
    if (next === account.color) return;
    // 押してすぐ画面に反映し、保存できなければ元に戻す。
    onUpdated({ ...account, color: next });
    setError(null);
    updateAccount(account.id, { color: next })
      .then(onUpdated)
      .catch(() => {
        onUpdated(account);
        setError("変更を保存できませんでした。もう一度お試しください。");
      });
  };

  return (
    <li className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={cn(
            "mt-1.5 size-2.5 shrink-0 rounded-full",
            ACCOUNT_COLORS.find((item) => item.name === color)?.dot,
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-sm">
            {account.displayName || account.email}
          </p>
          <p className="truncate text-muted-foreground text-xs">
            {account.email}
          </p>
          {problem && (
            <p className="mt-1 flex items-start gap-1 text-destructive text-xs">
              <CircleAlertIcon
                className="mt-0.5 size-3.5 shrink-0"
                aria-hidden="true"
              />
              <span className="line-clamp-3">
                {account.lastError
                  ? `${problem}: ${account.lastError}`
                  : problem}
              </span>
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-[1fr_auto]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`} className="font-normal text-xs">
            表示名
          </Label>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={200}
            placeholder={account.email}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
            onBlur={saveName}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.currentTarget.blur();
              }
            }}
            className="h-8"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span id={`${id}-color`} className="text-xs">
            色
          </span>
          <div
            role="radiogroup"
            aria-labelledby={`${id}-color`}
            className="flex h-8 items-center gap-1.5"
          >
            {ACCOUNT_COLORS.map((item) => (
              // biome-ignore lint/a11y/useSemanticElements: 色の見本をそのまま選択肢にするため、radio の役割を持つボタンにしている
              <button
                key={item.name}
                type="button"
                role="radio"
                aria-checked={color === item.name}
                aria-label={item.label}
                title={item.label}
                onClick={() => chooseColor(item.name)}
                className={cn(
                  "flex size-6 items-center justify-center rounded-full text-white outline-none ring-offset-2 ring-offset-background transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
                  item.dot,
                  color === item.name && "ring-2 ring-foreground/40",
                )}
              >
                {color === item.name && (
                  <CheckIcon className="size-3.5" aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onEditSignature(account)}
        >
          <SignatureIcon />
          {account.signatureHtml && htmlHasContent(account.signatureHtml)
            ? "署名を編集"
            : "署名を設定"}
        </Button>
        {account.status === "auth_required" && provider && (
          <Button variant="outline" size="sm" onClick={() => onReauth(account)}>
            {provider === "google"
              ? "Google にログインし直す"
              : "Microsoft にログインし直す"}
          </Button>
        )}
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${account.email} を削除`}
          onClick={() => onDelete(account)}
          className="text-destructive hover:text-destructive"
        >
          <Trash2Icon />
          削除
        </Button>
      </div>
    </li>
  );
}
