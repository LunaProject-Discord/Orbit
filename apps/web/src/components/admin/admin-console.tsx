"use client";

import { cn } from "cn";
import {
  KeyRoundIcon,
  LogOutIcon,
  type LucideIcon,
  ShieldCheckIcon,
  UserCogIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminAuthProvider, useAdminAuth } from "@/components/admin/admin-auth";
import { AdminLogin } from "@/components/admin/admin-login";
import { InvitationSettings } from "@/components/admin/invitation-settings";
import { SsoSettings } from "@/components/admin/sso-settings";
import { OrbitLogo } from "@/components/brand/orbit-logo";
import {
  type SecurityClient,
  SecurityPanel,
} from "@/components/mail/security-settings";
import { showNotice } from "@/components/mail/toasts";
import { ThemeToggle } from "@/components/theme-toggle";
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
  type Admin,
  type AdminMember,
  adminPasskeyApi,
  changeAdminName,
  changeAdminPassword,
  confirmAdminTwoFactor,
  deleteAdminPasskey,
  disableAdminTwoFactor,
  disableMember,
  enableMember,
  fetchAdminSecurity,
  listAdminPasskeys,
  listAdmins,
  listMembers,
  type Member,
  regenerateAdminBackupCodes,
  renameAdminPasskey,
  startAdminTwoFactor,
} from "@/lib/admin-api";
import { ApiError, NetworkError } from "@/lib/api";
import { useDateStyle } from "@/lib/date-format-settings";
import { formatShortDate } from "@/lib/format";
import { registerPasskey } from "@/lib/passkey";
import { isBundledApp } from "@/lib/server-url";

/** 管理画面のページ。並びは画面に出す順。 */
const SECTIONS = ["users", "invitations", "sso", "admins", "security"] as const;
type Section = (typeof SECTIONS)[number];

const SECTION_INFO: Record<
  Section,
  { label: string; description: string; icon: LucideIcon }
> = {
  users: {
    label: "利用者",
    description:
      "このサーバーで Orbit (メール・カレンダー・連絡先) を使っている人です。データは利用者ごとに分かれていて、管理画面からも中身は見えません。シングルサインオン先で消された人などは、無効にするとログインできなくなります。",
    icon: UsersIcon,
  },
  invitations: {
    label: "招待",
    description:
      "招待リンクを発行して、このサーバーの利用者を追加します。リンクを開いた人は、自分で名前・メールアドレス・パスワードを決めて登録できます。",
    icon: UserPlusIcon,
  },
  sso: {
    label: "シングルサインオン",
    description:
      "ほかのサービスのアカウント (OAuth 2.0 / OpenID Connect) で Orbit にログインできるようにします。管理者のログインには使えません。",
    icon: KeyRoundIcon,
  },
  admins: {
    label: "管理者",
    description:
      "管理画面にログインできるアカウントです。管理者は Orbit のメール・カレンダー・連絡先は使えません。追加と削除は、サーバー上のコマンド (admin create / admin delete) で行います。",
    icon: UserCogIcon,
  },
  security: {
    label: "ログインとセキュリティ",
    description:
      "この管理者アカウントのパスワード、2 段階認証、パスキーを設定します。一般の利用者のアカウントとは別です。",
    icon: ShieldCheckIcon,
  },
};

function sectionFromUrl(): Section {
  const value = new URLSearchParams(window.location.search).get("section");
  return (SECTIONS as readonly string[]).includes(value ?? "")
    ? (value as Section)
    : "users";
}

function loadMessageOf(error: unknown): string {
  if (error instanceof NetworkError) {
    return "サーバーに接続できませんでした。ネットワークの状態を確認してください。";
  }
  return "読み込めませんでした。時間をおいてもう一度お試しください。";
}

/** 管理画面 (/admin)。一般の利用者とは別の、管理者のアカウントでログインする。 */
export function AdminConsole() {
  // 同梱アプリ (Desktop / Android) には管理画面を入れず、ブラウザーで開いてもらう。
  const [bundled, setBundled] = useState<boolean | null>(null);
  useEffect(() => setBundled(isBundledApp()), []);
  if (bundled === null) return null;
  if (bundled) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="font-semibold text-xl">
          管理画面はブラウザーで開いてください
        </h1>
        <p className="max-w-md text-muted-foreground text-sm">
          管理画面はアプリには入っていません。ブラウザーで Orbit
          のサーバーのアドレスに /admin を付けて開いてください。
        </p>
      </main>
    );
  }
  return (
    <AdminAuthProvider>
      <AdminGate />
    </AdminAuthProvider>
  );
}

function AdminGate() {
  const auth = useAdminAuth();
  if (auth.status === "loading") {
    return (
      <main
        className="flex flex-1 items-center justify-center p-8"
        aria-busy="true"
      >
        <output className="text-muted-foreground text-sm">読み込み中…</output>
      </main>
    );
  }
  if (auth.status === "unreachable") {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="font-semibold text-xl">サーバーに接続できません</h1>
        <p className="text-muted-foreground text-sm">
          ネットワークの状態を確認して、もう一度お試しください。
        </p>
        <Button variant="outline" onClick={auth.retry}>
          再試行
        </Button>
      </main>
    );
  }
  if (auth.status === "signed-out") return <AdminLogin />;
  return <AdminShell admin={auth.admin} />;
}

function AdminShell({ admin }: { admin: Admin }) {
  const { signOut, refresh } = useAdminAuth();
  const [section, setSection] = useState<Section>("users");
  useEffect(() => {
    setSection(sectionFromUrl());
    const onPop = () => setSection(sectionFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const open = (next: Section) => {
    setSection(next);
    const url = next === "users" ? "/admin" : `/admin?section=${next}`;
    window.history.pushState(null, "", url);
  };

  const info = SECTION_INFO[section];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <OrbitLogo className="h-7" product="orbit" />
        <Badge variant="secondary">管理画面</Badge>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden truncate text-muted-foreground text-sm sm:inline">
            {admin.name} ({admin.username})
          </span>
          <ThemeToggle />
          <Button variant="outline" size="sm" onClick={() => void signOut()}>
            <LogOutIcon />
            <span className="max-sm:sr-only">ログアウト</span>
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label="管理画面のページ"
          className="shrink-0 overflow-x-auto border-b p-2 md:w-56 md:border-r md:border-b-0"
        >
          <ul className="flex gap-0.5 md:flex-col">
            {SECTIONS.map((id) => {
              const item = SECTION_INFO[id];
              const Icon = item.icon;
              return (
                <li key={id} className="shrink-0">
                  <button
                    type="button"
                    aria-current={section === id ? "page" : undefined}
                    data-admin-section={id}
                    onClick={() => open(id)}
                    className={cn(
                      "flex w-full items-center gap-3 whitespace-nowrap rounded-lg px-3 py-1.5 text-left text-sm outline-none transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50",
                      section === id && "bg-muted font-medium",
                    )}
                  >
                    <Icon
                      aria-hidden="true"
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    {item.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <main key={section} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
            <div className="flex flex-col gap-1">
              <h1 className="font-semibold text-lg">{info.label}</h1>
              <p className="text-muted-foreground text-sm">
                {info.description}
              </p>
            </div>
            {section === "users" && <MemberList />}
            {section === "invitations" && <InvitationSettings />}
            {section === "sso" && <SsoSettings />}
            {section === "admins" && <AdminList self={admin} />}
            {section === "security" && (
              <AdminSecurity admin={admin} refresh={refresh} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

/** 読み込みと失敗の表示をまとめた、一覧の取得。 */
function useList<T>(load: (signal?: AbortSignal) => Promise<T[]>) {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setItems(await load(signal));
        setError(null);
      } catch (cause) {
        if (signal?.aborted) return;
        if (cause instanceof ApiError && cause.status === 401) return;
        setError(loadMessageOf(cause));
      }
    },
    [load],
  );
  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);
  return { items, error, reload };
}

function ListState(props: {
  error: string | null;
  loading: boolean;
  empty: boolean;
  emptyText: string;
  onRetry: () => void;
}) {
  if (props.error) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {props.error}{" "}
        <button
          type="button"
          className="underline underline-offset-4"
          onClick={props.onRetry}
        >
          再試行
        </button>
      </p>
    );
  }
  if (props.loading) {
    return <p className="text-muted-foreground text-sm">読み込み中…</p>;
  }
  if (props.empty) {
    return (
      <p className="rounded-lg border px-3 py-2.5 text-muted-foreground text-sm">
        {props.emptyText}
      </p>
    );
  }
  return null;
}

function MemberList() {
  const dateStyle = useDateStyle();
  const { items, error, reload } = useList<Member>(listMembers);
  /** 無効にする・戻す確認の相手。 */
  const [target, setTarget] = useState<Member | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function toggle(member: Member) {
    const disabling = !member.disabledAt;
    setBusy(member.id);
    try {
      if (disabling) await disableMember(member.id);
      else await enableMember(member.id);
      showNotice(
        disabling
          ? `${member.name} さんを無効にしました。すべての端末からログアウトしました。`
          : `${member.name} さんを有効に戻しました。`,
        "info",
      );
    } catch (cause) {
      showNotice(
        cause instanceof ApiError && cause.status === 404
          ? "この利用者は、すでに削除されています。"
          : cause instanceof NetworkError
            ? "サーバーに接続できませんでした。ネットワークの状態を確認してください。"
            : "変更できませんでした。時間をおいてもう一度お試しください。",
      );
    } finally {
      setBusy(null);
      void reload();
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <ListState
        error={error}
        loading={items === null}
        empty={items?.length === 0}
        emptyText="まだ利用者はいません。「招待」から招待リンクを発行してください。"
        onRetry={() => void reload()}
      />
      {items && items.length > 0 && (
        <ul className="flex flex-col divide-y rounded-lg border" data-members>
          {items.map((member) => (
            <li key={member.id} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-medium text-sm">
                  <span className="truncate">{member.name}</span>
                  {member.disabledAt && (
                    <Badge variant="secondary" className="shrink-0">
                      無効
                    </Badge>
                  )}
                  {member.twoFactorEnabled && (
                    <Badge variant="outline" className="shrink-0">
                      2 段階認証
                    </Badge>
                  )}
                </p>
                <p className="truncate text-muted-foreground text-xs">
                  {member.email} ・{" "}
                  {formatShortDate(member.createdAt, dateStyle)} に登録
                  {member.disabledAt &&
                    ` ・ ${formatShortDate(member.disabledAt, dateStyle)} に無効化`}
                </p>
              </div>
              {member.disabledAt !== undefined && (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={busy === member.id}
                  onClick={() => {
                    if (member.disabledAt) void toggle(member);
                    else setTarget(member);
                  }}
                >
                  {member.disabledAt ? "有効に戻す" : "無効にする"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <AlertDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {target?.name} さんを無効にしますか？
            </AlertDialogTitle>
            <AlertDialogDescription>
              すべての端末からログアウトし、パスワード・パスキー・シングルサインオンのどの方法でもログインできなくなります。端末への通知も止まります。メールなどのデータは消えず、あとで有効に戻せます。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const member = target;
                setTarget(null);
                if (member) void toggle(member);
              }}
            >
              無効にする
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function AdminList({ self }: { self: Admin }) {
  const dateStyle = useDateStyle();
  const { items, error, reload } = useList<AdminMember>(listAdmins);
  return (
    <section className="flex flex-col gap-3">
      <ListState
        error={error}
        loading={items === null}
        empty={items?.length === 0}
        emptyText="管理者はいません。"
        onRetry={() => void reload()}
      />
      {items && items.length > 0 && (
        <ul className="flex flex-col divide-y rounded-lg border" data-admins>
          {items.map((member) => (
            <li key={member.id} className="px-3 py-2">
              <p className="flex items-center gap-2 font-medium text-sm">
                <span className="truncate">{member.name}</span>
                {member.id === self.id && (
                  <Badge variant="outline" className="shrink-0">
                    自分
                  </Badge>
                )}
                {!member.twoFactorEnabled && (
                  <Badge variant="secondary" className="shrink-0">
                    2 段階認証なし
                  </Badge>
                )}
              </p>
              <p className="truncate text-muted-foreground text-xs">
                {member.username} ・{" "}
                {formatShortDate(member.createdAt, dateStyle)} に作成
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AdminSecurity({
  admin,
  refresh,
}: {
  admin: Admin;
  refresh: () => Promise<void>;
}) {
  const client = useMemo<SecurityClient>(
    () => ({
      fetchStatus: fetchAdminSecurity,
      changeName: changeAdminName,
      requestEmailChange: null,
      changePassword: changeAdminPassword,
      startTwoFactor: startAdminTwoFactor,
      confirmTwoFactor: confirmAdminTwoFactor,
      disableTwoFactor: disableAdminTwoFactor,
      regenerateBackupCodes: regenerateAdminBackupCodes,
      listPasskeys: listAdminPasskeys,
      registerPasskey: (name) => registerPasskey(name, adminPasskeyApi),
      renamePasskey: renameAdminPasskey,
      deletePasskey: deleteAdminPasskey,
      refreshUser: refresh,
    }),
    [refresh],
  );
  return (
    <SecurityPanel
      client={client}
      name={admin.name}
      email={null}
      loginName={admin.username}
    />
  );
}
