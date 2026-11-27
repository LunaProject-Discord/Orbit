"use client";

import { cn } from "cn";
import {
  ArrowLeftIcon,
  AtSignIcon,
  BellIcon,
  BellOffIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  Clock3Icon,
  InfoIcon,
  ListIcon,
  LogOutIcon,
  type LucideIcon,
  MailOpenIcon,
  MenuIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  PanelLeftIcon,
  PlusIcon,
  PointerIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ServerIcon,
  ShieldCheckIcon,
  SignatureIcon,
  SunIcon,
  Trash2Icon,
  TypeIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useId, useState } from "react";
import { AboutSettings } from "@/components/mail/about-settings";
import { AccountCalendarSetting } from "@/components/mail/account-calendar-setting";
import {
  AccountServerDialog,
  canEditServer,
} from "@/components/mail/account-server-dialog";
import { ColorPicker } from "@/components/mail/color-picker";
import { FontPicker } from "@/components/mail/font-picker";
import { IconPicker } from "@/components/mail/icon-picker";
import { SecuritySettings } from "@/components/mail/security-settings";
import { PopNotice, popDeleteOptions } from "@/components/mail/server-settings";
import { SyncIndicator } from "@/components/mail/sync-indicator";
import { showNotice } from "@/components/mail/toasts";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
  type ComposeFormat,
  isReceiveOnly,
  type NotificationAction,
  oauthProviderOf,
  type SwipeSettings,
  type User,
  updateAccount,
} from "@/lib/api";
import { htmlHasContent } from "@/lib/compose";
import {
  changeDefaultComposeFormat,
  refreshComposeFormat,
  useDefaultComposeFormat,
} from "@/lib/compose-format-settings";
import { changeDateStyle, useDateStyle } from "@/lib/date-format-settings";
import { isDesktopApp } from "@/lib/desktop/app";
import type { FontKind } from "@/lib/font-kind";
import {
  DATE_FORMAT_MAX_LENGTH,
  type DateFormats,
  type DateStyle,
  formatDateWith,
} from "@/lib/format";
import { preloadLocalFonts, useFontListSupport } from "@/lib/local-fonts";
import { isNativeApp } from "@/lib/native/app";
import {
  changeNotificationActions,
  MAX_NOTIFICATION_ACTIONS,
  NOTIFICATION_ACTIONS,
  refreshNotificationActions,
  toggleNotificationAction,
  useNotificationActions,
} from "@/lib/notification-actions";
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
import { SETTINGS_CATEGORIES, type SettingsCategory } from "@/lib/route";
import {
  changeSenderIconGravatar,
  useSenderIconGravatar,
} from "@/lib/sender-icon-settings";
import {
  changeSwipeSettings,
  SWIPE_ACTIONS,
  useSwipeSettings,
} from "@/lib/swipe";
import type { SyncStatus } from "@/lib/sync-status";
import {
  clearWheelLog,
  setWheelLogEnabled,
  useWheelLog,
  wheelLogText,
} from "@/lib/wheel-log";

const notificationDescriptions: Record<NotificationStatus, string> = {
  unsupported: "このブラウザーでは、新着メールを通知できません。",
  off: "新着メールが届いても、通知しません。",
  blocked:
    "ブラウザーの設定で、このサイトの通知が拒否されています。通知を受け取るには、ブラウザーの設定で許可してください。",
  page: "新着メールを通知します。この画面を開いている間だけ届きます。",
  push: "新着メールを通知します。この画面を閉じていても届きます。",
};

/** スマホアプリでの説明 (許可するのはブラウザーではなく端末)。 */
const nativeNotificationDescriptions: Record<NotificationStatus, string> = {
  ...notificationDescriptions,
  unsupported:
    "このサーバー、またはこのアプリでは、新着メールの通知が設定されていません。",
  blocked:
    "端末の設定で、このアプリの通知が許可されていません。通知を受け取るには、端末の設定で許可してください。",
  push: "新着メールを通知します。アプリを閉じていても届きます。",
};

/** デスクトップ版での説明 (ウィンドウを閉じても通知領域に残って受け取る)。 */
const desktopNotificationDescriptions: Record<NotificationStatus, string> = {
  ...notificationDescriptions,
  page: "新着メールを通知します。ウィンドウを閉じていても、アプリを終了するまで届きます。",
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
  ["U / Esc", "メールを閉じる、選択を解除"],
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
  ["Z", "直前の削除・移動を元に戻す"],
];

/** 設定画面のページ (カテゴリ) の名前と説明。並びは SETTINGS_CATEGORIES の順。 */
const CATEGORIES: Record<
  SettingsCategory,
  { label: string; summary: string; description: string; icon: LucideIcon }
> = {
  accounts: {
    label: "アカウント",
    summary: "メールアカウントの追加、表示名、色、アイコン",
    description:
      "表示名、色、アイコンはすべての端末で共通です。並び順は、サイドバーでドラッグして変えられます。",
    icon: AtSignIcon,
  },
  appearance: {
    label: "外観",
    summary: "テーマ、文字の大きさ、アニメーション",
    description:
      "このページの設定は、この端末 (ブラウザー) にだけ保存されます。",
    icon: PaletteIcon,
  },
  fonts: {
    label: "フォント",
    summary: "画面とメール本文のフォント",
    description:
      "このページの設定は、この端末 (ブラウザー) にだけ保存されます。",
    icon: TypeIcon,
  },
  list: {
    label: "メール一覧",
    summary: "行の間隔、プレビュー、マーク",
    description:
      "このページの設定は、この端末 (ブラウザー) にだけ保存されます。",
    icon: ListIcon,
  },
  datetime: {
    label: "日付と時刻",
    summary: "日付と時刻の形式",
    description: "このページの設定は、すべての端末で共通です。",
    icon: Clock3Icon,
  },
  reading: {
    label: "メールの表示",
    summary:
      "既読のタイミング、外部の画像、差出人のアイコン、見出し、簡易返信欄",
    description:
      "Gravatar を使うかどうかは、すべての端末で共通です。それ以外の設定は、この端末 (ブラウザー) にだけ保存されます。",
    icon: MailOpenIcon,
  },
  actions: {
    label: "操作",
    summary: "スワイプ、ショートカットキー",
    description:
      "スワイプしたときの操作は、すべての端末で共通です。それ以外の設定は、この端末 (ブラウザー) にだけ保存されます。",
    icon: PointerIcon,
  },
  sidebar: {
    label: "サイドバー",
    summary: "項目の並び替え、統合フォルダ",
    description: "このページの設定は、すべての端末で共通です。",
    icon: PanelLeftIcon,
  },
  notifications: {
    label: "通知",
    summary: "新着メールの通知、通知に付けるボタン",
    description:
      "通知のオンとオフは端末 (ブラウザー) ごとに切り替えます。通知に付けるボタンはすべての端末で共通です。",
    icon: BellIcon,
  },
  signatures: {
    label: "作成と署名",
    summary:
      "メールの形式 (書式付き・テキスト)、アカウント・連絡先・会話ごとの署名",
    description: "このページの設定は、すべての端末で共通です。",
    icon: SignatureIcon,
  },
  security: {
    label: "ログインとセキュリティ",
    summary: "名前、メールアドレス、パスワード、2 段階認証、パスキー",
    description:
      "Orbit での名前と、ログインに使うメールアドレス、パスワード、2 段階認証、パスキーを設定します。メールアカウント (Gmail など) の設定とは別です。",
    icon: ShieldCheckIcon,
  },
  system: {
    label: "同期と端末",
    summary: "同期の状況、ログアウト、設定の初期化",
    description:
      "メールはサーバーが常に同期し、既読や移動などの操作はすべての端末に反映されます。",
    icon: RefreshCwIcon,
  },
  about: {
    label: "バージョン情報",
    summary: "アプリと画面の版、画面の更新",
    description:
      "アプリと画面の版、接続先のサーバーの版と更新の方針を確認します。アプリでは、アプリ本体と画面の更新もここで確認できます。",
    icon: InfoIcon,
  },
};

/** 広い画面で、ページを選んでいないときに出すページ。 */
const DEFAULT_CATEGORY: SettingsCategory = "accounts";

type Props = {
  user: User;
  /** 読み込み前は null。 */
  accounts: Account[] | null;
  /** 開いているページ。null なら設定の最初の画面 (狭い画面ではカテゴリの一覧)。 */
  category: SettingsCategory | null;
  onCategoryChange: (category: SettingsCategory | null) => void;
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
  /** 「連絡先・会話ごとの署名」の節。 */
  signatureRules: React.ReactNode;
};

/**
 * 設定画面。カテゴリごとのページに分かれている。
 *
 * 広い画面では、左にカテゴリの一覧、右に選んだページを並べる。狭い画面では、
 * カテゴリの一覧からページへ入り、見出しの「戻る」で一覧へ戻る。どちらの並びにするかは
 * この画面の幅で決める (コンテナクエリ) ので、表示の切り替えは CSS だけで行う。
 */
export function SettingsView(props: Props) {
  const { category, onCategoryChange, accounts } = props;
  const shown = category ?? DEFAULT_CATEGORY;
  const current = CATEGORIES[shown];
  const accountProblem =
    accounts?.some((account) => accountProblems[account.status]) ?? false;

  return (
    <section
      aria-label="設定"
      className="@container flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        {/* 狭い画面のページでは、メニューの代わりに「戻る」を出す。 */}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="メニューを開く"
          aria-controls="mail-sidebar"
          onClick={props.onMenu}
          className={cn("-ml-2 md:hidden", category && "hidden")}
        >
          <MenuIcon />
        </Button>
        {category && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="設定の一覧へ戻る"
            onClick={() => onCategoryChange(null)}
            className="-ml-2 @3xl:hidden"
          >
            <ArrowLeftIcon />
          </Button>
        )}
        <h1 className="truncate font-semibold text-lg">
          <span className={cn(category && "@max-3xl:hidden")}>設定</span>
          {category && <span className="@3xl:hidden">{current.label}</span>}
        </h1>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="設定のカテゴリ"
          className={cn(
            "min-h-0 w-full overflow-y-auto p-2 @3xl:w-56 @3xl:shrink-0 @3xl:border-r",
            category && "@max-3xl:hidden",
          )}
        >
          <ul className="flex flex-col gap-0.5">
            {SETTINGS_CATEGORIES.map((id) => {
              const item = CATEGORIES[id];
              return (
                <li key={id}>
                  <button
                    type="button"
                    aria-current={shown === id ? "page" : undefined}
                    data-settings-category={id}
                    onClick={() => onCategoryChange(id)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm outline-none transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 @3xl:py-1.5",
                      category === id && "bg-muted font-medium",
                      // ページを選んでいなくても、広い画面では最初のページが出ている。
                      category === null &&
                        id === DEFAULT_CATEGORY &&
                        "@3xl:bg-muted @3xl:font-medium",
                    )}
                  >
                    <item.icon
                      aria-hidden="true"
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{item.label}</span>
                      <span className="block truncate font-normal text-muted-foreground text-xs @3xl:hidden">
                        {item.summary}
                      </span>
                    </span>
                    {id === "accounts" && accountProblem && (
                      <CircleAlertIcon
                        role="img"
                        aria-label="確認が必要なアカウントがあります"
                        className="size-4 shrink-0 text-destructive"
                      />
                    )}
                    <ChevronRightIcon
                      aria-hidden="true"
                      className="size-4 shrink-0 text-muted-foreground @3xl:hidden"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <div
          // ページを切り替えたら、先頭から表示する。
          key={shown}
          data-settings-page={shown}
          className={cn(
            "min-h-0 min-w-0 flex-1 overflow-y-auto",
            !category && "@max-3xl:hidden",
          )}
        >
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
            <div className="flex flex-col gap-1">
              <h2 className="font-semibold text-lg @max-3xl:hidden">
                {current.label}
              </h2>
              <p className="text-muted-foreground text-sm">
                {current.description}
              </p>
            </div>
            <SettingsPage {...props} shown={shown} />
          </div>
        </div>
      </div>
    </section>
  );
}

function SettingsPage({
  shown,
  ...props
}: Props & { shown: SettingsCategory }) {
  switch (shown) {
    case "accounts":
      return <AccountsPage {...props} />;
    case "appearance":
      return <AppearancePage />;
    case "fonts":
      return <FontsPage />;
    case "list":
      return <ListPage />;
    case "datetime":
      return <DateTimePage />;
    case "reading":
      return <ReadingPage />;
    case "actions":
      return <ActionsPage />;
    case "sidebar":
      return props.sidebarItems;
    case "notifications":
      return <NotificationsPage {...props} />;
    case "signatures":
      return <SignaturesPage {...props} />;
    case "security":
      return <SecuritySettings user={props.user} />;
    case "system":
      return <SystemPage {...props} />;
    case "about":
      return <AboutSettings />;
  }
}

function AccountsPage({
  accounts,
  onAdd,
  onDelete,
  onEditSignature,
  onReauth,
  onAccountUpdated,
}: Props) {
  return (
    <>
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
    </>
  );
}

function AppearancePage() {
  const { theme, setTheme } = useTheme();
  const preferences = usePreferences();
  const set = updatePreferences;
  // テーマはこの端末に保存した値なので、サーバーで作った HTML と食い違わないよう、表示してから読む。
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <>
      <Section title="テーマ">
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
      <Section title="画面">
        <SettingGroup>
          <SelectRow
            label="文字の大きさ"
            description="画面全体の文字を、同じ比率で拡大・縮小します。"
            value={preferences.fontSize}
            onChange={(fontSize) => set({ fontSize })}
            options={FONT_SIZES.map((size) => [
              size,
              size === 100 ? "100% (標準)" : `${size}%`,
            ])}
          />
          <SwitchRow
            label="アニメーションを減らす"
            description="画面の切り替えなどのアニメーションを止めます。オフのときは、端末の設定に従います。"
            checked={preferences.motion === "off"}
            onChange={(off) => set({ motion: off ? "off" : "system" })}
          />
        </SettingGroup>
      </Section>
    </>
  );
}

function FontsPage() {
  const preferences = usePreferences();
  const set = updatePreferences;
  // フォントの一覧を取れる環境か。尋ねずに取れるときは、選んでいるフォントの名前を出すために先に取る。
  const fontList = useFontListSupport();
  useEffect(() => {
    void preloadLocalFonts();
  }, []);
  return (
    <>
      <Section title="画面のフォント">
        <SettingGroup>
          <SelectRow
            label="基本のフォント"
            description="画面全体に使うフォントです。標準は Gen Interface JP です。"
            value={preferences.font}
            onChange={(font) => set({ font })}
            options={[
              ["default", "標準 (Gen Interface JP)"],
              ["system", "システム標準"],
              ["sans", "ゴシック体"],
              ["serif", "明朝体"],
              ["mono", "等幅"],
              [
                "custom",
                fontList === "none" ? "名前を指定" : "フォント一覧から選ぶ",
              ],
            ]}
          />
          {preferences.font === "custom" &&
            (fontList === "none" ? (
              <CustomFontRow
                value={preferences.customFont}
                onChange={(customFont) => set({ customFont })}
              />
            ) : (
              <FontPickerRow
                label="使うフォント"
                description="この端末に入っているフォントから選びます。選ばなければ標準のフォントになります。"
                emptyLabel="未選択"
                value={preferences.customFont}
                onChange={(customFont) => set({ customFont })}
              />
            ))}
        </SettingGroup>
      </Section>

      <Section
        title="種類ごとのフォント"
        description="画面とメール本文の両方で、「ゴシック体」「明朝体」「等幅」を選んだときに使うフォントです。"
      >
        <SettingGroup>
          <FontPickerRow
            label="ゴシック体のフォント"
            description="基本のフォントや本文の標準フォントで「ゴシック体」を選んだときに使います。"
            emptyLabel="自動"
            fontKind="sans"
            value={preferences.sansFont}
            onChange={(sansFont) => set({ sansFont })}
          />
          <FontPickerRow
            label="明朝体のフォント"
            description="「明朝体」を選んだときに使います。"
            emptyLabel="自動"
            fontKind="serif"
            value={preferences.serifFont}
            onChange={(serifFont) => set({ serifFont })}
          />
          <FontPickerRow
            label="等幅のフォント"
            description="「等幅」を選んだときと、メール本文のコードなどの等幅の部分に使います。"
            emptyLabel="自動"
            fontKind="mono"
            value={preferences.monoFont}
            onChange={(monoFont) => set({ monoFont })}
          />
        </SettingGroup>
      </Section>

      <Section
        title="メール本文"
        description="メール側でフォントや文字の大きさが指定されている場合は、そちらが優先されます。"
      >
        <SettingGroup>
          <SelectRow
            label="本文の標準フォント"
            description="フォントが指定されていないメールに使います。"
            value={preferences.bodyFont}
            onChange={(bodyFont) => set({ bodyFont })}
            options={[
              ["sans", "ゴシック体 (標準)"],
              ["serif", "明朝体"],
              ["mono", "等幅"],
              // 一覧を取れない環境でも、ほかの端末と同じ形の設定を読めるよう、選んであれば出す。
              ...(fontList !== "none" || preferences.bodyFont === "custom"
                ? ([["custom", "フォント一覧から選ぶ"]] as const)
                : []),
            ]}
          />
          {preferences.bodyFont === "custom" && fontList !== "none" && (
            <FontPickerRow
              label="本文に使うフォント"
              description="この端末に入っているフォントから選びます。選ばなければゴシック体になります。"
              emptyLabel="未選択"
              value={preferences.bodyCustomFont}
              onChange={(bodyCustomFont) => set({ bodyCustomFont })}
            />
          )}
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
        </SettingGroup>
      </Section>
    </>
  );
}

function ListPage() {
  const preferences = usePreferences();
  const set = updatePreferences;
  return (
    <>
      <Section title="画面の配置">
        <SettingGroup>
          <SelectRow
            label="メールを表示する場所"
            description="開いたメールを一覧の右と下のどちらに表示するかです。幅の広い画面 (1024px 以上) で使われ、境目をドラッグして一覧の大きさを変えられます。"
            value={preferences.readingPane}
            onChange={(readingPane) => set({ readingPane })}
            options={[
              ["right", "右 (標準)"],
              ["bottom", "下"],
            ]}
          />
        </SettingGroup>
      </Section>
      <Section title="行の表示">
        <SettingGroup>
          <SelectRow
            label="一覧の表示"
            description="テーブル表示では、件名・差出人・日時などを列に分けて並べます。見出しを押すと並べ替え、ドラッグで列の入れ替えや幅の変更ができます。幅の狭い画面ではカード表示になります。"
            value={preferences.listLayout}
            onChange={(listLayout) => set({ listLayout })}
            options={[
              ["cards", "カード (標準)"],
              ["table", "テーブル"],
            ]}
          />
          <SelectRow
            label="行の間隔"
            value={preferences.density}
            onChange={(density) => set({ density })}
            options={[
              ["compact", "狭い"],
              ["standard", "標準"],
              ["comfortable", "広い"],
            ]}
          />
          <SelectRow
            label="本文のプレビュー"
            description="カード表示で、件名の下に表示する本文の行数です。"
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
            label="添付・スター・返信済みのマーク"
            checked={preferences.showListIcons}
            onChange={(showListIcons) => set({ showListIcons })}
          />
        </SettingGroup>
      </Section>
      <Section title="アカウントのマーク">
        <SettingGroup>
          <SwitchRow
            label="アカウントのマーク"
            description="複数のアカウントのメールが並ぶ一覧で、どのアカウントのメールかを示します。"
            checked={preferences.showAccountMark}
            onChange={(showAccountMark) => set({ showAccountMark })}
          />
          <SelectRow
            label="アカウントのマークの種類"
            description="アイコンや絵文字を設定していないアカウントは、どちらでも色の点になります。"
            value={preferences.accountMarkStyle}
            onChange={(accountMarkStyle) => set({ accountMarkStyle })}
            options={[
              ["icon", "設定したアイコン (標準)"],
              ["dot", "色の点だけ"],
            ]}
          />
        </SettingGroup>
      </Section>
    </>
  );
}

function DateTimePage() {
  const style = useDateStyle();
  const [error, setError] = useState(false);
  const change = (patch: Partial<DateStyle>) => {
    setError(false);
    void changeDateStyle(patch).then((saved) => setError(!saved));
  };
  return (
    <>
      <Section
        title="形式"
        description="Windows の「地域」の設定と同じ書き方で選べます。一覧では、今日のメールに短い時刻、今年のメールに月日、それより前のメールに短い日付を使います。メールの見出しは長い日付と短い時刻、ホバーで出す正確な日時は長い日付と長い時刻です。"
      >
        <SettingGroup>
          {DATE_FORMAT_FIELDS.map((field) => (
            <DateFormatRow
              key={field.key}
              field={field}
              value={style[field.key]}
              onChange={(value) => change({ [field.key]: value })}
            />
          ))}
        </SettingGroup>
        <DateFormatHelp />
      </Section>
      <Section title="メール一覧">
        <SettingGroup>
          <SelectRow
            label="一覧の日付"
            value={style.listDate}
            onChange={(listDate) => change({ listDate })}
            options={[
              ["auto", "今日は時刻、それ以外は日付"],
              ["datetime", "常に日付と時刻"],
            ]}
          />
        </SettingGroup>
        {error && (
          <p role="alert" className="text-destructive text-xs">
            日付と時刻の形式を保存できませんでした。通信の状態を確認して、もう一度選んでください。
          </p>
        )}
      </Section>
    </>
  );
}

function ReadingPage() {
  const preferences = usePreferences();
  const senderIconGravatar = useSenderIconGravatar();
  const [gravatarError, setGravatarError] = useState(false);
  const set = updatePreferences;
  return (
    <>
      <Section title="既読">
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
        </SettingGroup>
      </Section>
      <Section
        title="本文"
        description="本文のフォント、文字の大きさ、行間は「フォント」で選べます。"
      >
        <SettingGroup>
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
        </SettingGroup>
      </Section>
      <Section
        title="差出人のアイコン"
        description="送信元のロゴ (BIMI。認証局の証明書でロゴの持ち主を確かめられたものだけ)、Gravatar、送信元のサイトのアイコンの順に探し、無ければ名前の頭文字を表示します。なりすましの疑いがあるメールでは、ロゴとサイトのアイコンを使いません。画像はサーバーが取得するので、メールを開いたことは相手に伝わりません。"
      >
        <SettingGroup>
          <SwitchRow
            label="メール一覧に表示"
            description="カード表示の各行の左に表示します。"
            checked={preferences.senderIconInList}
            onChange={(senderIconInList) => set({ senderIconInList })}
          />
          <SwitchRow
            label="メールの詳細に表示"
            description="開いたメールの見出しと、会話の各メールに表示します。"
            checked={preferences.senderIconInMessage}
            onChange={(senderIconInMessage) => set({ senderIconInMessage })}
          />
          <SwitchRow
            label="プロフィールカードと宛先の候補に表示"
            description="名前を押したときのカードと、宛先を入力するときの候補に表示します。宛先の相手は送信元を確認できないので、証明書で確かめられたロゴと Gravatar だけを使います。"
            checked={preferences.senderIconInProfile}
            onChange={(senderIconInProfile) => set({ senderIconInProfile })}
          />
        </SettingGroup>
        <SettingGroup>
          <SwitchRow
            label="Gravatar を使う"
            description="すべての端末で共通の設定です。差出人のアドレスから作った値 (ハッシュ) をサーバーが Gravatar に送って、登録された画像を探します。"
            checked={senderIconGravatar}
            onChange={(gravatar) => {
              setGravatarError(false);
              void changeSenderIconGravatar(gravatar).then((saved) =>
                setGravatarError(!saved),
              );
            }}
          />
        </SettingGroup>
        {gravatarError && (
          <p role="alert" className="text-destructive text-xs">
            Gravatar
            の設定を保存できませんでした。通信の状態を確認して、もう一度お試しください。
          </p>
        )}
      </Section>
      <Section title="見出しと返信">
        <SettingGroup>
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
            description="メールの下に、すぐに返信を書ける欄を表示します。"
            checked={preferences.quickReply}
            onChange={(quickReply) => set({ quickReply })}
          />
        </SettingGroup>
      </Section>
    </>
  );
}

function ActionsPage() {
  const preferences = usePreferences();
  const set = updatePreferences;
  const swipe = useSwipeSettings();
  const [swipeError, setSwipeError] = useState(false);
  const changeSwipe = (patch: Partial<SwipeSettings>) => {
    setSwipeError(false);
    void changeSwipeSettings(patch).then((saved) => setSwipeError(!saved));
  };
  return (
    <>
      <Section
        title="スワイプしたときの操作"
        description="メール一覧の行を左右にスワイプしたときの操作です。その行でできない操作 (アーカイブ先が無い場合など) は、スワイプしても実行されません。"
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
            スワイプ操作を保存できませんでした。通信の状態を確認して、もう一度選んでください。
          </p>
        )}
      </Section>

      <Section title="スワイプの動作">
        <SettingGroup>
          <SelectRow
            label="開いているメールのスワイプ"
            description="メールを開いた画面を左右にスワイプしたときの動作です。「一覧と同じ操作」を選ぶと、上の「スワイプしたときの操作」で選んだ操作を実行します。"
            value={preferences.messageSwipe}
            onChange={(messageSwipe) => set({ messageSwipe })}
            options={[
              ["navigate", "前後のメールへ移動 (標準)"],
              ["actions", "一覧と同じ操作"],
              ["off", "なし"],
            ]}
          />
          <SwitchRow
            label="トラックパッドでスワイプ"
            description="2 本指で横へスクロールして、一覧の行や開いているメールをスワイプします。"
            checked={preferences.trackpadSwipe}
            onChange={(trackpadSwipe) => set({ trackpadSwipe })}
          />
          <WheelLogRow />
        </SettingGroup>
      </Section>

      <Section title="ショートカットキー">
        <SettingGroup>
          <SwitchRow
            label="ショートカットキー"
            description="J / K や C などの 1 文字のキーで操作します。"
            checked={preferences.shortcuts}
            onChange={(shortcuts) => set({ shortcuts })}
          />
        </SettingGroup>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-lg border p-3 text-sm">
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
    </>
  );
}

function NotificationsPage({
  accounts,
  notificationStatus,
  notificationBusy,
  onNotificationChange,
  onAccountUpdated,
}: Props) {
  const [accountError, setAccountError] = useState(false);
  const changeAccountNotify = (account: Account, notifyNewMail: boolean) => {
    // 押してすぐ画面に反映し、保存できなければ元に戻す。
    onAccountUpdated({ ...account, notifyNewMail });
    setAccountError(false);
    updateAccount(account.id, { notifyNewMail })
      .then(onAccountUpdated)
      .catch(() => {
        onAccountUpdated(account);
        setAccountError(true);
      });
  };
  const notificationActions = useNotificationActions();
  const [notificationActionsError, setNotificationActionsError] =
    useState(false);
  // ほかの端末で変えた内容を、ページを開いたときに取り込む。
  useEffect(() => {
    void refreshNotificationActions();
  }, []);
  const changeNotificationAction = (id: NotificationAction, on: boolean) => {
    setNotificationActionsError(false);
    void changeNotificationActions(
      toggleNotificationAction(notificationActions, id, on),
    ).then((saved) => setNotificationActionsError(!saved));
  };
  const notifying =
    notificationStatus === "page" || notificationStatus === "push";
  const canToggleNotification =
    notificationStatus !== "unsupported" && notificationStatus !== "blocked";
  return (
    <>
      <Section title="新着メールの通知">
        <div className="flex items-center gap-3 rounded-lg border p-3">
          {/* アイコンは説明の行ではなく、1 行目 (オン / オフ) の高さにそろえる。 */}
          <span className="flex h-5 shrink-0 items-center self-start">
            {notifying ? (
              <BellIcon className="size-4 shrink-0" aria-hidden="true" />
            ) : (
              <BellOffIcon
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-sm">
              この端末の通知: {notifying ? "オン" : "オフ"}
            </p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              {
                (isNativeApp()
                  ? nativeNotificationDescriptions
                  : isDesktopApp()
                    ? desktopNotificationDescriptions
                    : notificationDescriptions)[notificationStatus]
              }
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
      {accounts && accounts.length > 0 && (
        <Section title="アカウントごとの通知">
          <SettingGroup>
            <div className="px-3 py-2.5">
              <p className="text-muted-foreground text-xs leading-relaxed">
                新着メールを通知するアカウントを選べます。この設定はすべての端末で共通です。
                {isNativeApp() &&
                  "通知の音や表示のしかたは、Android の設定の「通知」から、アカウントごとに変えられます。"}
              </p>
            </div>
            {accounts.map((account) => (
              <SwitchRow
                key={account.id}
                label={account.displayName || account.email}
                description={account.displayName ? account.email : undefined}
                checked={account.notifyNewMail}
                onChange={(on) => changeAccountNotify(account, on)}
              />
            ))}
          </SettingGroup>
          {accountError && (
            <p role="alert" className="text-destructive text-xs">
              変更を保存できませんでした。通信の状態を確認して、もう一度お試しください。
            </p>
          )}
        </Section>
      )}
      <Section title="通知に付けるボタン">
        <SettingGroup>
          <div className="px-3 py-2.5">
            <p className="text-muted-foreground text-xs leading-relaxed">
              通知から、メールを開かずに操作できます。
              {MAX_NOTIFICATION_ACTIONS} つまで選べ、選んだ順に並びます
              (ブラウザーの通知では、先頭の 2
              つしか表示されないことがあります)。
              この設定はすべての端末で共通で、次に届く通知から反映されます。
            </p>
            <p className="mt-1 text-xs" data-notification-action-order>
              {notificationActions.length > 0
                ? `現在の並び: ${notificationActions
                    .map(
                      (id) =>
                        NOTIFICATION_ACTIONS.find((action) => action.id === id)
                          ?.label ?? id,
                    )
                    .join("、")}`
                : "ボタンは付けません。"}
            </p>
          </div>
          {NOTIFICATION_ACTIONS.map((action) => {
            const checked = notificationActions.includes(action.id);
            return (
              <SwitchRow
                key={action.id}
                label={action.label}
                description={action.description}
                checked={checked}
                disabled={
                  !checked &&
                  notificationActions.length >= MAX_NOTIFICATION_ACTIONS
                }
                onChange={(on) => changeNotificationAction(action.id, on)}
              />
            );
          })}
        </SettingGroup>
        {notificationActionsError && (
          <p role="alert" className="text-destructive text-xs">
            通知に付けるボタンを保存できませんでした。通信の状態を確認して、もう一度選んでください。
          </p>
        )}
      </Section>
    </>
  );
}

function SignaturesPage({
  accounts,
  onEditSignature,
  signatureRules,
  onAccountUpdated,
}: Props) {
  const defaultFormat = useDefaultComposeFormat();
  const [formatError, setFormatError] = useState(false);
  // ほかの端末で変えた内容を、ページを開いたときに取り込む。
  useEffect(() => {
    void refreshComposeFormat();
  }, []);
  const changeAccountFormat = (
    account: Account,
    composeFormat: ComposeFormat | null,
  ) => {
    // 選んですぐ画面に反映し、保存できなければ元に戻す。
    onAccountUpdated({ ...account, composeFormat });
    setFormatError(false);
    updateAccount(account.id, { composeFormat })
      .then(onAccountUpdated)
      .catch(() => {
        onAccountUpdated(account);
        setFormatError(true);
      });
  };
  return (
    <>
      <Section
        title="メールの形式"
        description="新しいメールや返信を書き始めるときの形式です。作成画面の「その他のオプション」で、メールごとに切り替えられます。テキストのみで書いたメールは、書式を付けずに送ります。"
      >
        <SettingGroup>
          <SelectRow
            label="既定の形式"
            value={defaultFormat}
            onChange={(format) => {
              setFormatError(false);
              void changeDefaultComposeFormat(format).then((saved) =>
                setFormatError(!saved),
              );
            }}
            options={[
              ["html", "書式付き (HTML)"],
              ["text", "テキストのみ"],
            ]}
          />
        </SettingGroup>
        {accounts && accounts.length > 1 && (
          <SettingGroup>
            {accounts.map((account) => (
              <SelectRow<"default" | ComposeFormat>
                key={account.id}
                label={account.displayName || account.email}
                description={account.displayName ? account.email : undefined}
                value={account.composeFormat ?? "default"}
                onChange={(value) =>
                  changeAccountFormat(
                    account,
                    value === "default" ? null : value,
                  )
                }
                options={[
                  ["default", "既定に従う"],
                  ["html", "書式付き (HTML)"],
                  ["text", "テキストのみ"],
                ]}
              />
            ))}
          </SettingGroup>
        )}
        {formatError && (
          <p role="alert" className="text-destructive text-xs">
            メールの形式を保存できませんでした。通信の状態を確認して、もう一度お試しください。
          </p>
        )}
      </Section>
      <Section
        title="アカウントの署名"
        description="連絡先や会話ごとの署名が設定されていないときに使います。"
      >
        {accounts === null ? (
          <p className="text-muted-foreground text-sm">読み込み中…</p>
        ) : accounts.length === 0 ? (
          <p className="rounded-lg border border-dashed p-3 text-muted-foreground text-sm">
            メールアカウントがありません。
          </p>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border">
            {accounts.map((account) => {
              const has =
                account.signatureHtml !== null &&
                htmlHasContent(account.signatureHtml);
              return (
                <li key={account.id} className="flex items-center gap-3 p-3">
                  <AccountMark accounts={accounts} account={account} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-sm">
                      {account.displayName || account.email}
                    </p>
                    <p className="truncate text-muted-foreground text-xs">
                      {has ? "設定済み" : "未設定"}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`${account.email} の署名を${has ? "編集" : "設定"}`}
                    onClick={() => onEditSignature(account)}
                  >
                    <SignatureIcon />
                    {has ? "編集" : "設定"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      {signatureRules}
    </>
  );
}

function SystemPage({ user, syncStatus, devices, onSignOut }: Props) {
  return (
    <>
      <Section title="同期">
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <SyncIndicator status={syncStatus} />
          <p className="text-muted-foreground text-xs">
            {devices > 0
              ? `現在接続している端末: ${devices} 台 (この端末を含む)`
              : "現在接続している端末の数は、サーバーに接続すると表示されます。"}
          </p>
        </div>
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

      <Section
        title="この端末の設定"
        description="外観、フォント、メール一覧、メールの表示と、操作のうちこの端末に保存している設定を、初期設定に戻します。アカウントや署名など、すべての端末で共通の設定は変わりません。"
      >
        <div>
          <Button variant="outline" size="sm" onClick={resetPreferences}>
            <RotateCcwIcon />
            この端末の設定を初期設定に戻す
          </Button>
        </div>
      </Section>
    </>
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
        <h3 className="font-semibold text-base">{props.title}</h3>
        {props.description && (
          <p className="text-muted-foreground text-sm">{props.description}</p>
        )}
      </div>
      {props.children}
    </section>
  );
}

/** 表示名・アイコン・色の見出し。Label (leading-none) と同じ高さにそろえる。 */
const FIELD_LABEL_CLASS = "font-medium text-sm leading-none";

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
  const [editingServer, setEditingServer] = useState(false);
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
      | { allowLegacyTls: boolean }
      | { pushConnections: number | null }
      | { popLeaveOnServer: boolean }
      | { popDeleteAfterDays: number | null },
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
          <p className="truncate text-muted-foreground text-xs">
            受信: {RECEIVING_LABELS[account.protocol]}
            {/* 送信サーバーを設定していないアカウントは、受信だけに使う。 */}
            {isReceiveOnly(account) && " ・ 受信専用"}
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

      {/* スマホ幅は 1 行目に表示名、2 行目にアイコンと色。広い画面ではアイコン・表示名・色を 1 行に。 */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-3">
        <div className="flex flex-col gap-2">
          <span id={`${id}-icon`} className={FIELD_LABEL_CLASS}>
            アイコン
          </span>
          <IconPicker
            compact
            value={account.icon}
            onChange={chooseIcon}
            labelledBy={`${id}-icon`}
            colorClass={ACCOUNT_TEXT_CLASS}
            dotClass={ACCOUNT_DOT_CLASS}
            colorStyle={accountColorStyle(color)}
          />
        </div>
        <div className="order-first flex min-w-0 basis-full flex-col gap-2 sm:order-none sm:flex-1 sm:basis-0">
          <Label htmlFor={`${id}-name`}>表示名</Label>
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
            className="h-9"
          />
        </div>
        <div className="flex flex-col gap-2">
          <span id={`${id}-color`} className={FIELD_LABEL_CLASS}>
            色
          </span>
          <ColorPicker
            value={color}
            chosen={account.color !== null}
            onChange={chooseColor}
            labelledBy={`${id}-color`}
            triggerClassName="h-9 pointer-coarse:h-11"
          />
        </div>
      </div>

      <AccountCalendarSetting account={account} onUpdated={onUpdated} />

      {/* 接続先を手で設定したアカウントだけ。Gmail や iCloud は新しい TLS に対応している。 */}
      {(account.protocol === "imap" || account.protocol === "pop3") &&
        (account.provider === "generic" || account.allowLegacyTls) && (
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p id={`${id}-legacy-tls`} className="font-medium text-sm">
                古い TLS のサーバーへの接続を許可する
              </p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                安全な再ネゴシエーション (RFC 5746)
                に対応していないサーバー向けです。安全性が下がるため、接続できない場合にだけオンにしてください。
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

      {/* Microsoft (Graph) は変更通知で全フォルダの変化が届き、POP3 にはフォルダが無いので、IMAP のアカウントだけ。 */}
      {account.protocol === "imap" && (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p id={`${id}-push-connections`} className="font-medium text-sm">
              受信トレイ以外のフォルダの変更をすぐに受け取る
            </p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              受信トレイ以外のフォルダ用に追加する接続の本数です。対応しているサーバーでは、1
              本ですべてのフォルダの変更を受け取ります。対応していないサーバーでは、迷惑メールや送信済みなどの重要なフォルダから順に
              1 本ずつ使い、残りのフォルダは 2
              分ごとに確認します。ほかのメールソフトで「接続が多すぎる」と表示される場合は、減らしてください。
            </p>
          </div>
          <Select
            items={PUSH_CONNECTION_OPTIONS}
            value={String(account.pushConnections ?? "auto")}
            onValueChange={(next) =>
              saveNow({
                pushConnections: next === "auto" ? null : Number(next),
              })
            }
          >
            <SelectTrigger
              size="sm"
              aria-labelledby={`${id}-push-connections`}
              className="shrink-0"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" className="w-auto">
              {PUSH_CONNECTION_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* POP3 のアカウントだけ。受信したメールをサーバーに残すかどうかと、消すまでの日数。 */}
      {account.protocol === "pop3" && (
        <>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p id={`${id}-pop-leave`} className="font-medium text-sm">
                受信したメールをサーバーに残す
              </p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                オフにすると、受信したメールをサーバーから削除します。ほかの端末やメールソフトでは受け取れなくなります。
              </p>
            </div>
            <Switch
              aria-labelledby={`${id}-pop-leave`}
              checked={account.popLeaveOnServer}
              onCheckedChange={(checked) =>
                saveNow({ popLeaveOnServer: checked })
              }
            />
          </div>
          {account.popLeaveOnServer && (
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p id={`${id}-pop-delete`} className="font-medium text-sm">
                  サーバーから削除するまでの日数
                </p>
                <p className="text-muted-foreground text-xs leading-relaxed">
                  受信してから選んだ日数がたったメールを、サーバーから削除します。このアプリで完全に削除したメールは、日数に関係なくサーバーからも削除します。
                </p>
              </div>
              <Select
                items={popDeleteOptions(account.popDeleteAfterDays)}
                value={
                  account.popDeleteAfterDays === null
                    ? "never"
                    : String(account.popDeleteAfterDays)
                }
                onValueChange={(next) =>
                  saveNow({
                    popDeleteAfterDays:
                      next === "never" || next === null ? null : Number(next),
                  })
                }
              >
                <SelectTrigger
                  size="sm"
                  aria-labelledby={`${id}-pop-delete`}
                  className="shrink-0"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end" className="w-auto">
                  {popDeleteOptions(account.popDeleteAfterDays).map(
                    (option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>
          )}
          <PopNotice />
        </>
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
        {
          <Button
            variant={problem && canEditServer(account) ? "default" : "outline"}
            size="sm"
            onClick={() => setEditingServer(true)}
          >
            <ServerIcon />
            {problem && canEditServer(account)
              ? "サーバー設定を確認"
              : "サーバー設定"}
          </Button>
        }
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
      <AccountServerDialog
        account={editingServer ? account : null}
        onOpenChange={setEditingServer}
        onUpdated={onUpdated}
        onReauth={onReauth}
      />
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

type DateFormatField = {
  key: keyof DateFormats;
  label: string;
  /** 選択肢に出す書式 (先頭が標準)。 */
  presets: readonly string[];
};

/** 日時の書式の設定項目。選択肢は Windows (日本語) の選択肢に合わせた。 */
const DATE_FORMAT_FIELDS: readonly DateFormatField[] = [
  {
    key: "shortDateFormat",
    label: "短い日付",
    presets: [
      "yyyy/MM/dd",
      "yyyy/M/d",
      "yy/MM/dd",
      "yy/M/d",
      "yyyy-MM-dd",
      "yyyy.MM.dd",
    ],
  },
  {
    key: "monthDayFormat",
    label: "月日 (今年の日付)",
    presets: ["M/d", "MM/dd", "M月d日", "M/d (ddd)"],
  },
  {
    key: "longDateFormat",
    label: "長い日付",
    presets: [
      "yyyy年M月d日 (ddd)",
      "yyyy年M月d日",
      "yyyy年MM月dd日",
      "yyyy年M月d日 dddd",
      "yyyy/M/d (ddd)",
    ],
  },
  {
    key: "shortTimeFormat",
    label: "短い時刻",
    presets: ["H:mm", "HH:mm", "tth:mm", "tt h:mm", "tt hh:mm"],
  },
  {
    key: "longTimeFormat",
    label: "長い時刻",
    presets: ["H:mm:ss", "HH:mm:ss", "tth:mm:ss", "tt h:mm:ss", "tt hh:mm:ss"],
  },
];

const CUSTOM_FORMAT = "custom";

/** 日時の書式を選ぶ行。選択肢から選ぶか、「カスタム」で書式を入力する。 */
function DateFormatRow(props: {
  field: DateFormatField;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const { field } = props;
  const isPreset = field.presets.includes(props.value);
  const [custom, setCustom] = useState(!isPreset);
  const [draft, setDraft] = useState(props.value);
  // 見本は、書式の違い (M と MM、H と h など) が見える固定の日時にする。
  const sample = new Date(2026, 0, 5, 14, 5, 9);
  const preview = formatDateWith(sample, custom ? draft : props.value);
  const options = [
    ...field.presets.map((format, index) => ({
      value: format,
      label: `${formatDateWith(sample, format)}${index === 0 ? " (標準)" : ""}`,
    })),
    { value: CUSTOM_FORMAT, label: "カスタム…" },
  ];
  const commit = () => {
    const next = draft.slice(0, DATE_FORMAT_MAX_LENGTH);
    if (!next.trim()) {
      setDraft(props.value);
      return;
    }
    props.onChange(next);
  };
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <label htmlFor={id} className="font-medium text-sm">
            {field.label}
          </label>
          <p className="text-muted-foreground text-xs tabular-nums leading-relaxed">
            例: {preview || "(空)"}
          </p>
        </div>
        <Select
          items={options}
          value={custom ? CUSTOM_FORMAT : props.value}
          onValueChange={(next) => {
            if (next === null) return;
            if (next === CUSTOM_FORMAT) {
              setDraft(props.value);
              setCustom(true);
              return;
            }
            setCustom(false);
            setDraft(next);
            props.onChange(next);
          }}
        >
          <SelectTrigger id={id} size="sm" className="max-w-full">
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
      {custom && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={`${field.label}の書式`}
            value={draft}
            maxLength={DATE_FORMAT_MAX_LENGTH}
            autoComplete="off"
            spellCheck={false}
            placeholder={field.presets[0]}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.currentTarget.blur();
              }
            }}
            className="h-8 min-w-0 flex-1 basis-48 font-mono"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const standard = field.presets[0] ?? "";
              setCustom(false);
              setDraft(standard);
              props.onChange(standard);
            }}
          >
            標準に戻す
          </Button>
        </div>
      )}
    </div>
  );
}

/** カスタムの書式で使える記号の一覧。 */
const DATE_FORMAT_TOKENS: readonly (readonly [
  token: string,
  meaning: string,
])[] = [
  ["yyyy / yy", "年 (2026 / 26)"],
  ["M / MM", "月 (1 / 01)"],
  ["d / dd", "日 (5 / 05)"],
  ["ddd / dddd", "曜日 (火 / 火曜日)"],
  ["H / HH", "時、24 時間制 (9 / 09)"],
  ["h / hh", "時、12 時間制 (9 / 09)"],
  ["tt", "午前 / 午後"],
  ["m / mm", "分 (5 / 05)"],
  ["s / ss", "秒 (5 / 05)"],
  ["'文字'", "囲んだ文字をそのまま出す"],
];

function DateFormatHelp() {
  return (
    <Collapsible className="rounded-lg border">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left font-medium text-sm hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
        カスタムの書式で使える記号
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          {DATE_FORMAT_TOKENS.map(([token, meaning]) => (
            <div key={token} className="contents">
              <dt className="font-mono">{token}</dt>
              <dd className="text-muted-foreground">{meaning}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-muted-foreground text-xs">
          ほかの文字 (年・月・日・/・: など) はそのまま出ます。
        </p>
      </CollapsibleContent>
    </Collapsible>
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

/** ほかのフォルダ用に足す接続の本数の選択肢 (サーバー側の上限は 8 本)。 */
/** アカウントの一覧に出す受信方式の名前。 */
const RECEIVING_LABELS: Record<Account["protocol"], string> = {
  imap: "IMAP",
  pop3: "POP3",
  graph: "Microsoft Graph",
};

const PUSH_CONNECTION_OPTIONS = [
  { value: "auto", label: "自動" },
  { value: "0", label: "使わない" },
  ...[1, 2, 3, 4, 5, 6, 8].map((count) => ({
    value: String(count),
    label: `${count} 本まで`,
  })),
];

/**
 * トラックパッドの動きの記録 (スワイプの反応の調査用)。オンにしてからスワイプし、
 * 記録をコピーして送ってもらう。記録はこの端末のメモリーにだけ残る。
 */
function WheelLogRow() {
  const log = useWheelLog();
  const id = useId();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wheelLogText());
      showNotice(`${log.count} 件の記録をコピーしました。`, "info");
    } catch {
      showNotice("記録をコピーできませんでした。");
    }
  };
  return (
    <SettingRow
      label="トラックパッドの動きを記録"
      labelId={id}
      description="スワイプの反応を調べるためのものです。オンにしてスワイプしたあと「コピー」を押し、内容を送ってください。最新の 3000 件だけをこの端末に残し、ほかへは送りません。"
    >
      <div className="flex items-center gap-2">
        {log.enabled && (
          <>
            <span className="text-muted-foreground text-xs tabular-nums">
              {log.count} 件
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={log.count === 0}
              onClick={copy}
            >
              コピー
            </Button>
            <Button variant="ghost" size="sm" onClick={clearWheelLog}>
              消去
            </Button>
          </>
        )}
        <Switch
          aria-labelledby={id}
          checked={log.enabled}
          onCheckedChange={(checked) => setWheelLogEnabled(checked)}
        />
      </div>
    </SettingRow>
  );
}

/** オンとオフを切り替える行。 */
function SwitchRow(props: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
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
        disabled={props.disabled}
        onCheckedChange={(checked) => props.onChange(checked)}
      />
    </SettingRow>
  );
}

/** この端末に入っているフォントの一覧から選ぶ行。 */
function FontPickerRow(props: {
  label: string;
  description: string;
  emptyLabel: string;
  fontKind?: FontKind;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <SettingRow
      label={props.label}
      labelId={id}
      description={props.description}
    >
      <FontPicker
        labelledBy={id}
        value={props.value}
        onChange={props.onChange}
        emptyLabel={props.emptyLabel}
        fontKind={props.fontKind}
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
