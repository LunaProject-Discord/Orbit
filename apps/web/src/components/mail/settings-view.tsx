"use client";

import { cn } from "cn";
import {
  BellIcon,
  BellOffIcon,
  CircleAlertIcon,
  LogOutIcon,
  MenuIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  RotateCcwIcon,
  SignatureIcon,
  SunIcon,
  Trash2Icon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useId, useState } from "react";
import { ColorPicker } from "@/components/mail/color-picker";
import { IconPicker } from "@/components/mail/icon-picker";
import { SyncIndicator } from "@/components/mail/sync-indicator";
import { Button } from "@/components/ui/button";
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
  ACCOUNT_DOT_CLASS,
  ACCOUNT_TEXT_CLASS,
  accountColorHex,
  accountColorStyle,
} from "@/lib/account-colors";
import { type AccountIconName, AccountMark } from "@/lib/account-icons";
import {
  type Account,
  oauthProviderOf,
  type SwipeSettings,
  type User,
  updateAccount,
} from "@/lib/api";
import { htmlHasContent } from "@/lib/compose";
import type { NotificationStatus } from "@/lib/notifications";
import {
  BODY_FONT_SIZES,
  BODY_LINE_HEIGHTS,
  cleanFontName,
  FONT_SIZES,
  MARK_READ_DELAYS,
  resetPreferences,
  updatePreferences,
  usePreferences,
} from "@/lib/preferences";
import {
  changeSwipeSettings,
  SWIPE_ACTIONS,
  useSwipeSettings,
} from "@/lib/swipe";
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
  /** 「サイドバーの項目と統合フォルダ」の節 (どの端末でも同じ内容になる設定)。 */
  sidebarItems: React.ReactNode;
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
  sidebarItems,
}: Props) {
  const { theme, setTheme } = useTheme();
  const preferences = usePreferences();
  const set = updatePreferences;
  const swipe = useSwipeSettings();
  const [swipeError, setSwipeError] = useState(false);
  const changeSwipe = (patch: Partial<SwipeSettings>) => {
    setSwipeError(false);
    void changeSwipeSettings(patch).then((saved) => setSwipeError(!saved));
  };
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
            description="配色、フォント、文字の大きさを選びます。ここから下の「操作」までの設定は、この端末 (ブラウザー) だけに保存します。"
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
            <SettingGroup>
              <SelectRow
                label="フォント"
                description="標準は Gen Interface JP です。"
                value={preferences.font}
                onChange={(font) => set({ font })}
                options={[
                  ["default", "標準 (Gen Interface JP)"],
                  ["system", "端末のフォント"],
                  ["serif", "明朝体"],
                  ["mono", "等幅"],
                  ["custom", "名前を指定"],
                ]}
              />
              {preferences.font === "custom" && (
                <CustomFontRow
                  value={preferences.customFont}
                  onChange={(customFont) => set({ customFont })}
                />
              )}
              <SelectRow
                label="文字の大きさ"
                description="画面全体が同じ比率で変わります。"
                value={preferences.fontSize}
                onChange={(fontSize) => set({ fontSize })}
                options={FONT_SIZES.map((size) => [
                  size,
                  size === 100 ? "100% (標準)" : `${size}%`,
                ])}
              />
              <SwitchRow
                label="動きを減らす"
                description="画面の切り替えなどの動きを止めます。オフのときは、端末の設定に従います。"
                checked={preferences.motion === "off"}
                onChange={(off) => set({ motion: off ? "off" : "system" })}
              />
            </SettingGroup>
          </Section>

          <Section title="メール一覧">
            <SettingGroup>
              <SelectRow
                label="行の間隔"
                value={preferences.density}
                onChange={(density) => set({ density })}
                options={[
                  ["compact", "せまい"],
                  ["standard", "標準"],
                  ["comfortable", "ひろい"],
                ]}
              />
              <SelectRow
                label="本文のプレビュー"
                description="件名の下に出す本文の行数です。"
                value={preferences.previewLines}
                onChange={(previewLines) => set({ previewLines })}
                options={[
                  [0, "表示しない"],
                  [1, "1 行"],
                  [2, "2 行 (標準)"],
                  [3, "3 行"],
                ]}
              />
              <SwitchRow
                label="添付・スター・返信済みの印"
                checked={preferences.showListIcons}
                onChange={(showListIcons) => set({ showListIcons })}
              />
              <SwitchRow
                label="アカウントの印"
                description="複数のアカウントのメールが並ぶ一覧で、どのアカウントのメールかを示します。"
                checked={preferences.showAccountMark}
                onChange={(showAccountMark) => set({ showAccountMark })}
              />
              <SelectRow
                label="アカウントの印の見た目"
                description="アイコンや絵文字を設定していないアカウントは、どちらでも色の点になります。"
                value={preferences.accountMarkStyle}
                onChange={(accountMarkStyle) => set({ accountMarkStyle })}
                options={[
                  ["icon", "設定したアイコン (標準)"],
                  ["dot", "色の点だけ"],
                ]}
              />
              <SelectRow
                label="日付"
                value={preferences.listDate}
                onChange={(listDate) => set({ listDate })}
                options={[
                  ["auto", "今日は時刻、それ以外は日付"],
                  ["datetime", "常に日付と時刻"],
                ]}
              />
              <SelectRow
                label="時刻"
                value={preferences.hour12 ? "12" : "24"}
                onChange={(value) => set({ hour12: value === "12" })}
                options={[
                  ["24", "24 時間 (14:30)"],
                  ["12", "12 時間 (午後2:30)"],
                ]}
              />
            </SettingGroup>
          </Section>

          <Section title="メールの表示">
            <SettingGroup>
              <SelectRow
                label="既読にするタイミング"
                description="メールを開いたときの動作です。"
                value={preferences.markRead}
                onChange={(markRead) => set({ markRead })}
                options={[
                  ["immediately", "開いたらすぐ"],
                  ["delay", "少し待ってから"],
                  ["never", "自動では既読にしない"],
                ]}
              />
              {preferences.markRead === "delay" && (
                <SelectRow
                  label="既読にするまでの時間"
                  value={preferences.markReadDelay}
                  onChange={(markReadDelay) => set({ markReadDelay })}
                  options={MARK_READ_DELAYS.map((seconds) => [
                    seconds,
                    `${seconds} 秒`,
                  ])}
                />
              )}
              <SelectRow
                label="本文のフォント"
                description="メール側でフォントや大きさを指定している場合は、そちらが使われます。"
                value={preferences.bodyFont}
                onChange={(bodyFont) => set({ bodyFont })}
                options={[
                  ["sans", "ゴシック体 (標準)"],
                  ["serif", "明朝体"],
                  ["mono", "等幅"],
                ]}
              />
              <SelectRow
                label="本文の文字の大きさ"
                value={preferences.bodyFontSize}
                onChange={(bodyFontSize) => set({ bodyFontSize })}
                options={BODY_FONT_SIZES.map((size) => [
                  size,
                  size === 14 ? "14 px (標準)" : `${size} px`,
                ])}
              />
              <SelectRow
                label="本文の行間"
                value={preferences.bodyLineHeight}
                onChange={(bodyLineHeight) => set({ bodyLineHeight })}
                options={BODY_LINE_HEIGHTS.map((height) => [
                  height,
                  height === 1.6 ? "1.6 (標準)" : String(height),
                ])}
              />
              <SelectRow
                label="外部の画像"
                description="常に表示すると、メールを開いたことが差出人に伝わる場合があります。"
                value={preferences.remoteImages}
                onChange={(remoteImages) => set({ remoteImages })}
                options={[
                  ["ask", "メールごとに確認 (標準)"],
                  ["always", "常に表示"],
                ]}
              />
              <SwitchRow
                label="見出しを折りたたむ"
                description="差出人、宛先、日時、件名を 2 行にまとめて、本文を広く表示します。メールの見出しのボタンでも切り替えられます。"
                checked={preferences.messageHeader === "collapsed"}
                onChange={(collapsed) =>
                  set({ messageHeader: collapsed ? "collapsed" : "expanded" })
                }
              />
              <SwitchRow
                label="簡易返信欄"
                description="メールの下に、すぐ返信を書ける欄を出します。"
                checked={preferences.quickReply}
                onChange={(quickReply) => set({ quickReply })}
              />
            </SettingGroup>
          </Section>

          <Section title="操作">
            <SettingGroup>
              <SwitchRow
                label="トラックパッドでスワイプ"
                description="2 本指で横へスクロールして、一覧の行をスワイプします。何をするかは、下の「スワイプ操作」で選びます。"
                checked={preferences.trackpadSwipe}
                onChange={(trackpadSwipe) => set({ trackpadSwipe })}
              />
              <SwitchRow
                label="ショートカットキー"
                description="J / K や C などの 1 文字のキーで操作します。一覧は下にあります。"
                checked={preferences.shortcuts}
                onChange={(shortcuts) => set({ shortcuts })}
              />
            </SettingGroup>
            <div>
              <Button variant="outline" size="sm" onClick={resetPreferences}>
                <RotateCcwIcon />
                表示と操作の設定を標準に戻す
              </Button>
            </div>
          </Section>

          {sidebarItems}

          <Section
            title="スワイプ操作"
            description="メール一覧の行を、指で左右にスワイプしたときの操作です。この設定はすべての端末で共通です。その行でできない操作 (アーカイブ先が無いなど) は、スワイプしても動きません。"
          >
            <SettingGroup>
              <SelectRow
                label="左へスワイプ"
                value={swipe.left}
                onChange={(left) => changeSwipe({ left })}
                options={SWIPE_ACTIONS}
              />
              <SelectRow
                label="右へスワイプ"
                value={swipe.right}
                onChange={(right) => changeSwipe({ right })}
                options={SWIPE_ACTIONS}
              />
            </SettingGroup>
            {swipeError && (
              <p role="alert" className="text-destructive text-xs">
                スワイプ操作を保存できませんでした。通信の状態を確かめて、もう一度選んでください。
              </p>
            )}
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
            description="表示名、色、アイコン、署名はすべての端末で共通です。並び順は、サイドバーでドラッグして変えられます。"
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
  const color = accountColorHex(accounts, account.id);

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
  const chooseColor = (next: string | null) => {
    if (next === account.color) return;
    saveNow({ color: next });
  };
  const chooseIcon = (next: AccountIconName | null) => {
    if (next === account.icon) return;
    saveNow({ icon: next });
  };
  const saveNow = (
    patch:
      | { color: string | null }
      | { icon: AccountIconName | null }
      | { allowLegacyTls: boolean },
  ) => {
    // 押してすぐ画面に反映し、保存できなければ元に戻す。
    onUpdated({ ...account, ...patch });
    setError(null);
    updateAccount(account.id, patch)
      .then(onUpdated)
      .catch(() => {
        onUpdated(account);
        setError("変更を保存できませんでした。もう一度お試しください。");
      });
  };

  return (
    <li className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-start gap-3">
        <AccountMark accounts={accounts} account={account} />
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
          <ColorPicker
            value={color}
            chosen={account.color !== null}
            onChange={chooseColor}
            labelledBy={`${id}-color`}
          />
        </div>
      </div>

      <div className="flex flex-col items-start gap-1.5">
        <span id={`${id}-icon`} className="text-xs">
          アイコン
        </span>
        <IconPicker
          value={account.icon}
          onChange={chooseIcon}
          labelledBy={`${id}-icon`}
          colorClass={ACCOUNT_TEXT_CLASS}
          dotClass={ACCOUNT_DOT_CLASS}
          colorStyle={accountColorStyle(color)}
        />
      </div>

      {/* 接続先を手で設定したアカウントだけ。Gmail や iCloud は新しい TLS に対応している。 */}
      {account.protocol === "imap" &&
        (account.provider === "generic" || account.allowLegacyTls) && (
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p id={`${id}-legacy-tls`} className="text-xs">
                古い TLS のサーバーへの接続を許可する
              </p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                安全な再ネゴシエーション (RFC 5746)
                に対応していないサーバー向けです。安全性が下がるので、接続できないときだけオンにしてください。
              </p>
            </div>
            <Switch
              aria-labelledby={`${id}-legacy-tls`}
              checked={account.allowLegacyTls}
              onCheckedChange={(checked) =>
                saveNow({ allowLegacyTls: checked })
              }
            />
          </div>
        )}

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

/** 設定の行をまとめる枠。行の間に区切り線を引く。 */
function SettingGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col divide-y rounded-lg border">{children}</div>
  );
}

function SettingRow(props: {
  label: string;
  labelFor?: string;
  labelId?: string;
  description?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2.5">
      <div className="min-w-0 flex-1 basis-48">
        {props.labelFor ? (
          <label htmlFor={props.labelFor} className="font-medium text-sm">
            {props.label}
          </label>
        ) : (
          <span id={props.labelId} className="font-medium text-sm">
            {props.label}
          </span>
        )}
        {props.description && (
          <p className="text-muted-foreground text-xs leading-relaxed">
            {props.description}
          </p>
        )}
      </div>
      {props.children}
    </div>
  );
}

/** 選択肢から 1 つ選ぶ行。値は文字列でも数でもよい。 */
function SelectRow<T extends string | number>(props: {
  label: string;
  description?: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly (readonly [value: T, label: string])[];
}) {
  const id = useId();
  return (
    <SettingRow
      label={props.label}
      labelFor={id}
      description={props.description}
    >
      <Select
        items={props.options.map(([value, label]) => ({
          value: String(value),
          label,
        }))}
        value={String(props.value)}
        onValueChange={(next) => {
          const option = props.options.find(
            ([value]) => String(value) === next,
          );
          if (option) props.onChange(option[0]);
        }}
      >
        <SelectTrigger id={id} size="sm" className="max-w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end" className="w-auto">
          {props.options.map(([value, label]) => (
            <SelectItem key={String(value)} value={String(value)}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  );
}

/** オンとオフを切り替える行。 */
function SwitchRow(props: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <SettingRow
      label={props.label}
      labelId={id}
      description={props.description}
    >
      <Switch
        aria-labelledby={id}
        checked={props.checked}
        onCheckedChange={(checked) => props.onChange(checked)}
      />
    </SettingRow>
  );
}

/** フォントを名前で指定する行。入力を終えたときに反映する。 */
function CustomFontRow(props: {
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const [name, setName] = useState(props.value);
  return (
    <SettingRow
      label="フォントの名前"
      labelFor={id}
      description="この端末に入っているフォントの名前を入力します (例: BIZ UDPGothic)。見つからなければ標準のフォントになります。"
    >
      <Input
        id={id}
        value={name}
        maxLength={100}
        autoComplete="off"
        spellCheck={false}
        placeholder="フォントの名前"
        onChange={(event) => setName(event.target.value)}
        onBlur={() => {
          const cleaned = cleanFontName(name);
          setName(cleaned);
          props.onChange(cleaned);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.currentTarget.blur();
          }
        }}
        className="h-8 w-48"
      />
    </SettingRow>
  );
}
