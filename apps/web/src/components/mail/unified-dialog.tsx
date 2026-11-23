"use client";

import { cn } from "cn";
import { ChevronRightIcon, LayersIcon } from "lucide-react";
import { type FormEvent, useId, useMemo, useState } from "react";
import { ColorPicker } from "@/components/mail/color-picker";
import { IconPicker } from "@/components/mail/icon-picker";
import { MailboxIcon, MailboxMark } from "@/components/mail/mailbox-icon";
import { BUILTIN_ICONS } from "@/components/mail/unified-mark";
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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { ACCOUNT_TEXT_CLASS, accountColorStyle } from "@/lib/account-colors";
import { AccountMark } from "@/lib/account-icons";
import {
  type Account,
  ApiError,
  type BuiltinStyle,
  createUnifiedFolder,
  deleteUnifiedFolder,
  type MailboxSummary,
  saveBuiltinStyle,
  type UnifiedFilters,
  type UnifiedFolder,
  type UnifiedFolderInput,
  type UnifiedRole,
  type UnifiedScope,
  updateUnifiedFolder,
} from "@/lib/api";
import {
  buildMailboxTree,
  type MailboxNode,
  mailboxLabel,
} from "@/lib/mailboxes";
import {
  BUILTIN_LABELS,
  type BuiltinView,
  emptyUnifiedFilters,
  emptyUnifiedScope,
  isScopeEmpty,
  scopeMailboxes,
  UNIFIED_ROLES,
  WITHIN_DAYS,
} from "@/lib/unified";

/** 開いている統合フォルダのダイアログ。 */
export type UnifiedDialogTarget =
  | { kind: "create" }
  | { kind: "edit"; folder: UnifiedFolder }
  | { kind: "delete"; folder: UnifiedFolder }
  /** 初めからある項目 (すべての受信トレイなど) の名前・アイコン・色を変える。 */
  | { kind: "builtin"; view: BuiltinView; style: BuiltinStyle };

type Props = {
  target: UnifiedDialogTarget | null;
  accounts: Account[];
  mailboxes: MailboxSummary[];
  onClose: () => void;
  /** 作成または変更を保存した。created は、新しく作ったフォルダ。 */
  onSaved: (created: UnifiedFolder | null) => void;
  /** 初めからある項目の見た目を保存した。 */
  onBuiltinsSaved: (builtins: Record<string, BuiltinStyle>) => void;
  onDeleted: (folder: UnifiedFolder) => void;
  /** 編集中のフォルダを削除したい (確認のダイアログへ切り替える)。 */
  onRequestDelete: (folder: UnifiedFolder) => void;
};

/** 色を選んでいないときに、色を選ぶ画面の出だしにする色。 */
const DEFAULT_COLOR = "#737373";
const NO_PERIOD = "none";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "too_many") {
      return "統合フォルダの数が上限に達しています。使っていないものを削除してください。";
    }
    if (error.code === "not_found") {
      return "この統合フォルダは、ほかの端末で削除されました。";
    }
  }
  return "保存できませんでした。時間をおいて、もう一度お試しください。";
}

type Form = UnifiedFolderInput;

const newForm = (): Form => ({
  name: "",
  icon: null,
  color: null,
  scope: emptyUnifiedScope,
  filters: emptyUnifiedFilters,
});

/**
 * 統合フォルダの作成・編集と、削除の確認。
 * スマホ幅では、画面の下から出るシートになる。
 */
export function UnifiedDialog({
  target,
  accounts,
  mailboxes,
  onClose,
  onSaved,
  onBuiltinsSaved,
  onDeleted,
  onRequestDelete,
}: Props) {
  const id = useId();
  const [form, setForm] = useState<Form>(newForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 閉じるアニメーションの間も内容が消えないよう、最後の対象を覚えておく。
  const [shown, setShown] = useState<UnifiedDialogTarget | null>(target);
  if (target && target !== shown) {
    setShown(target);
    setError(null);
    if (target.kind === "create") setForm(newForm());
    else if (target.kind === "edit") {
      const { name, icon, color, scope, filters } = target.folder;
      setForm({ name, icon, color, scope, filters });
    } else if (target.kind === "builtin") {
      setForm({ ...newForm(), ...target.style, name: target.style.name ?? "" });
    }
  }
  const builtin = shown?.kind === "builtin" ? shown.view : null;
  const BuiltinIcon = builtin ? BUILTIN_ICONS[builtin] : null;
  /** 初めからある項目を、初期の名前・アイコン・色から変えているか。 */
  const customized =
    form.name.trim() !== "" || form.icon !== null || form.color !== null;

  const editing = shown?.kind === "edit" ? shown.folder : null;
  const set = (patch: Partial<Form>) =>
    setForm((current) => ({ ...current, ...patch }));
  const setScope = (patch: Partial<UnifiedScope>) =>
    setForm((current) => ({
      ...current,
      scope: { ...current.scope, ...patch },
    }));
  const setFilters = (patch: Partial<UnifiedFilters>) =>
    setForm((current) => ({
      ...current,
      filters: { ...current.filters, ...patch },
    }));

  const { scope, filters } = form;
  const sources = useMemo(
    () => scopeMailboxes(scope, mailboxes),
    [scope, mailboxes],
  );
  const valid =
    builtin !== null || (form.name.trim() !== "" && !isScopeEmpty(scope));

  const close = (open: boolean) => {
    if (!open && !busy) onClose();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!target || target.kind === "delete" || !valid || busy) return;
    // いまは無いフォルダの ID は、保存し直すときに落とす。
    const known = new Set(mailboxes.map((mailbox) => mailbox.id));
    const input: Form = {
      ...form,
      name: form.name.trim(),
      scope: {
        ...scope,
        mailboxIds:
          mailboxes.length > 0
            ? scope.mailboxIds.filter((item) => known.has(item))
            : scope.mailboxIds,
      },
    };
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        if (target.kind === "builtin") {
          onBuiltinsSaved(
            await saveBuiltinStyle(target.view, {
              name: input.name === "" ? null : input.name,
              icon: input.icon,
              color: input.color,
            }),
          );
        } else if (target.kind === "create") {
          onSaved(await createUnifiedFolder(input));
        } else {
          await updateUnifiedFolder(target.folder.id, input);
          onSaved(null);
        }
        onClose();
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusy(false);
      }
    })();
  };

  const toggleRole = (role: UnifiedRole) =>
    setScope({
      roles: scope.roles.includes(role)
        ? scope.roles.filter((item) => item !== role)
        : [...scope.roles, role],
    });
  const toggleMailbox = (mailboxId: string, checked: boolean) =>
    setScope({
      mailboxIds: checked
        ? [...scope.mailboxIds, mailboxId]
        : scope.mailboxIds.filter((item) => item !== mailboxId),
    });

  return (
    <>
      <Dialog
        open={target !== null && target.kind !== "delete"}
        onOpenChange={close}
      >
        <DialogContent
          data-slot="unified-dialog"
          className={cn(
            "flex max-h-[min(44rem,calc(100dvh-2rem))] flex-col gap-0 p-0 sm:max-w-lg",
            // スマホ幅では、画面の下に貼り付くシートにする。
            "max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:max-h-[92dvh] max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-sm:rounded-t-2xl max-sm:data-closed:zoom-out-100 max-sm:data-closed:slide-out-to-bottom max-sm:data-open:zoom-in-100 max-sm:data-open:slide-in-from-bottom max-sm:duration-200",
          )}
        >
          <form
            onSubmit={handleSubmit}
            className="flex min-h-0 flex-1 flex-col"
          >
            <DialogHeader className="shrink-0 px-6 pt-6 pb-4 max-sm:px-4 max-sm:pt-5">
              <DialogTitle>
                {builtin
                  ? `「${BUILTIN_LABELS[builtin]}」の見た目`
                  : editing
                    ? "統合フォルダを編集"
                    : "新しい統合フォルダ"}
              </DialogTitle>
              <DialogDescription>
                {builtin
                  ? "サイドバーに表示する名前・アイコン・色を変えられます。表示されるメールは変わりません。この設定は、すべての端末で共通です。"
                  : "複数のアカウントやフォルダのメールを、1 つの一覧にまとめます。メール自体は、元のフォルダから移動しません。"}
              </DialogDescription>
            </DialogHeader>

            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-2 max-sm:px-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-name`}>名前</Label>
                <Input
                  id={`${id}-name`}
                  value={form.name}
                  maxLength={100}
                  autoComplete="off"
                  placeholder={
                    builtin ? BUILTIN_LABELS[builtin] : "例: すべての送信済み"
                  }
                  autoFocus={!editing && !builtin}
                  onChange={(event) => set({ name: event.target.value })}
                />
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span id={`${id}-icon`} className="shrink-0 text-xs">
                      アイコン
                    </span>
                    <IconPicker
                      value={form.icon}
                      onChange={(icon) => set({ icon })}
                      labelledBy={`${id}-icon`}
                      emptyIcon={
                        BuiltinIcon ? (
                          <BuiltinIcon className="size-4" />
                        ) : (
                          <LayersIcon className="size-4" />
                        )
                      }
                      emptyLabel="標準"
                      {...(form.color
                        ? {
                            colorClass: ACCOUNT_TEXT_CLASS,
                            colorStyle: accountColorStyle(form.color),
                          }
                        : {})}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span id={`${id}-color`} className="shrink-0 text-xs">
                      色
                    </span>
                    <ColorPicker
                      value={form.color ?? DEFAULT_COLOR}
                      chosen={form.color !== null}
                      onChange={(color) => set({ color })}
                      labelledBy={`${id}-color`}
                      unsetLabel="なし"
                      resetLabel="色を外す"
                    />
                  </div>
                </div>
              </div>

              {!builtin && (
                <>
                  <fieldset className="flex flex-col gap-2">
                    <legend className="mb-2 font-medium text-sm">
                      対象のフォルダ
                    </legend>
                    <div className="flex items-center gap-1.5">
                      {(
                        [
                          [false, "フォルダを選ぶ"],
                          [true, "すべてのフォルダ"],
                        ] as const
                      ).map(([all, label]) => (
                        <Button
                          key={label}
                          type="button"
                          variant={scope.all === all ? "secondary" : "ghost"}
                          size="sm"
                          aria-pressed={scope.all === all}
                          onClick={() => setScope({ all })}
                          className="rounded-full"
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                    {scope.all ? (
                      <p className="text-muted-foreground text-xs">
                        すべてのアカウントの、すべてのフォルダが対象です
                        (ごみ箱と迷惑メールを除く)。下の条件と組み合わせて使います。
                      </p>
                    ) : (
                      <>
                        <div className="flex flex-col gap-1.5">
                          <span className="text-muted-foreground text-xs">
                            全アカウントから
                            (後から追加したアカウントも含みます)
                          </span>
                          <div className="flex flex-wrap gap-1.5">
                            {UNIFIED_ROLES.map(({ role, label }) => {
                              const pressed = scope.roles.includes(role);
                              return (
                                <Button
                                  key={role}
                                  type="button"
                                  variant={pressed ? "default" : "outline"}
                                  size="sm"
                                  aria-pressed={pressed}
                                  onClick={() => toggleRole(role)}
                                  className="gap-1.5 rounded-full"
                                >
                                  <MailboxIcon specialUse={role} />
                                  {label}
                                </Button>
                              );
                            })}
                          </div>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <span className="text-muted-foreground text-xs">
                            フォルダを個別に選ぶ
                          </span>
                          <div className="flex flex-col rounded-lg border">
                            {accounts.length === 0 && (
                              <p className="p-3 text-muted-foreground text-xs">
                                メールアカウントがまだありません。
                              </p>
                            )}
                            {accounts.map((account) => (
                              <AccountFolders
                                key={account.id}
                                account={account}
                                accounts={accounts}
                                mailboxes={mailboxes}
                                scope={scope}
                                onToggle={toggleMailbox}
                              />
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                    <p
                      className={cn(
                        "text-xs",
                        isScopeEmpty(scope)
                          ? "text-destructive"
                          : "text-muted-foreground",
                      )}
                      aria-live="polite"
                    >
                      {isScopeEmpty(scope)
                        ? "対象のフォルダを 1 つ以上選んでください。"
                        : `現在あるフォルダのうち ${sources.length} 個が対象です。`}
                    </p>
                  </fieldset>

                  {/* fieldset は中身の幅より狭くならないので、min-w-0 で枠に収める。 */}
                  <fieldset className="flex min-w-0 flex-col gap-3">
                    <legend className="mb-2 font-medium text-sm">
                      条件 (任意)
                      <span className="mt-1 block font-normal text-muted-foreground text-xs">
                        指定した条件のすべてに当てはまるメールだけを表示します。
                      </span>
                    </legend>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      {(
                        [
                          ["unread", "未読のみ"],
                          ["flagged", "スター付き"],
                          ["hasAttachment", "添付あり"],
                        ] as const
                      ).map(([key, label]) => (
                        <div key={key} className="flex items-center gap-2">
                          <Checkbox
                            id={`${id}-${key}`}
                            checked={filters[key]}
                            onCheckedChange={(checked) =>
                              setFilters({ [key]: checked === true })
                            }
                          />
                          <Label
                            htmlFor={`${id}-${key}`}
                            className="font-normal"
                          >
                            {label}
                          </Label>
                        </div>
                      ))}
                    </div>
                    <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
                      {(
                        [
                          ["from", "差出人", "名前またはアドレス"],
                          ["to", "宛先", "名前またはアドレス"],
                          ["subject", "件名", ""],
                          [
                            "text",
                            "含まれる語句",
                            "件名・差出人・宛先・本文から検索",
                          ],
                        ] as const
                      ).map(([key, label, placeholder]) => (
                        <div key={key} className="contents">
                          <Label
                            htmlFor={`${id}-${key}`}
                            className="font-normal"
                          >
                            {label}
                          </Label>
                          <Input
                            id={`${id}-${key}`}
                            value={filters[key]}
                            maxLength={200}
                            placeholder={placeholder}
                            autoComplete="off"
                            onChange={(event) =>
                              setFilters({ [key]: event.target.value })
                            }
                            className="h-8"
                          />
                        </div>
                      ))}
                      <Label htmlFor={`${id}-period`} className="font-normal">
                        期間
                      </Label>
                      <Select
                        items={[
                          { value: NO_PERIOD, label: "指定しない" },
                          ...WITHIN_DAYS.map(({ days, label }) => ({
                            value: String(days),
                            label,
                          })),
                        ]}
                        value={
                          filters.withinDays === null
                            ? NO_PERIOD
                            : String(filters.withinDays)
                        }
                        onValueChange={(next) =>
                          setFilters({
                            withinDays:
                              next === NO_PERIOD || next === null
                                ? null
                                : Number(next),
                          })
                        }
                      >
                        <SelectTrigger
                          id={`${id}-period`}
                          size="sm"
                          className="w-fit"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent align="start" className="w-auto">
                          <SelectItem value={NO_PERIOD}>指定しない</SelectItem>
                          {WITHIN_DAYS.map(({ days, label }) => (
                            <SelectItem key={days} value={String(days)}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </fieldset>
                </>
              )}
            </div>

            {error && (
              <p role="alert" className="px-6 pt-2 text-destructive text-sm">
                {error}
              </p>
            )}
            <DialogFooter className="shrink-0 px-6 pt-4 pb-6 max-sm:px-4 max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]">
              {builtin && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy || !customized}
                  onClick={() => set({ name: "", icon: null, color: null })}
                  className="sm:mr-auto"
                >
                  初期設定に戻す
                </Button>
              )}
              {editing && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => onRequestDelete(editing)}
                  className="text-destructive hover:text-destructive sm:mr-auto"
                >
                  削除
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={onClose}
              >
                キャンセル
              </Button>
              <Button type="submit" disabled={busy || !valid}>
                {editing || builtin ? "保存" : "作成"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={target?.kind === "delete"} onOpenChange={close}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>統合フォルダを削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              「{shown?.kind === "delete" ? shown.folder.name : ""}
              」を削除します。表示されていたメールは、元のフォルダにそのまま残ります。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (target?.kind !== "delete" || busy) return;
                const { folder } = target;
                setBusy(true);
                setError(null);
                deleteUnifiedFolder(folder.id)
                  .catch((cause) => {
                    // ほかの端末ですでに削除されていたら、削除できたものとして扱う。
                    if (!(cause instanceof ApiError && cause.status === 404)) {
                      throw cause;
                    }
                  })
                  .then(() => {
                    onDeleted(folder);
                    onClose();
                  })
                  .catch(() =>
                    setError(
                      "削除できませんでした。時間をおいて、もう一度お試しください。",
                    ),
                  )
                  .finally(() => setBusy(false));
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

/** 1 つのアカウントのフォルダを、チェックボックス付きのツリーで出す (開閉できる)。 */
function AccountFolders({
  account,
  accounts,
  mailboxes,
  scope,
  onToggle,
}: {
  account: Account;
  accounts: Account[];
  mailboxes: MailboxSummary[];
  scope: UnifiedScope;
  onToggle: (mailboxId: string, checked: boolean) => void;
}) {
  const id = useId();
  const own = useMemo(
    () => mailboxes.filter((mailbox) => mailbox.accountId === account.id),
    [mailboxes, account.id],
  );
  const tree = useMemo(() => buildMailboxTree(own), [own]);
  const picked = own.filter((mailbox) =>
    scope.mailboxIds.includes(mailbox.id),
  ).length;
  // 個別に選んだフォルダがあるアカウントは、開いた状態で出す。
  const [open, setOpen] = useState(picked > 0);
  const name = account.displayName || account.email;
  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-folders`}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 pointer-coarse:py-3 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <AccountMark accounts={accounts} account={account} size="sm" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {picked > 0 && (
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
            {picked} 個
          </span>
        )}
      </button>
      {open && (
        <ul id={`${id}-folders`} className="flex flex-col pb-1.5">
          {own.length === 0 && (
            <li className="px-9 py-1 text-muted-foreground text-xs">
              フォルダはまだ同期されていません。
            </li>
          )}
          <FolderRows
            nodes={tree}
            depth={0}
            scope={scope}
            onToggle={onToggle}
          />
        </ul>
      )}
    </div>
  );
}

function FolderRows({
  nodes,
  depth,
  scope,
  onToggle,
}: {
  nodes: MailboxNode[];
  depth: number;
  scope: UnifiedScope;
  onToggle: (mailboxId: string, checked: boolean) => void;
}) {
  const id = useId();
  return nodes.map(({ mailbox, children }) => {
    // 「全アカウントから」で選んだ役割のフォルダは、すでに対象になっている。
    const byRole =
      mailbox.specialUse !== null &&
      (scope.roles as string[]).includes(mailbox.specialUse);
    const checkboxId = `${id}-${mailbox.id}`;
    return (
      <li key={mailbox.id}>
        <div
          className="flex items-center gap-2 py-1 pointer-coarse:py-2 pr-3 text-sm"
          style={{ paddingLeft: `${2.25 + depth * 1}rem` }}
        >
          <Checkbox
            id={checkboxId}
            checked={byRole || scope.mailboxIds.includes(mailbox.id)}
            disabled={byRole}
            onCheckedChange={(checked) =>
              onToggle(mailbox.id, checked === true)
            }
          />
          <Label
            htmlFor={checkboxId}
            className="min-w-0 flex-1 gap-1.5 font-normal [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
          >
            <MailboxMark mailbox={mailbox} />
            <span className="truncate">{mailboxLabel(mailbox)}</span>
          </Label>
        </div>
        {children.length > 0 && (
          <ul>
            <FolderRows
              nodes={children}
              depth={depth + 1}
              scope={scope}
              onToggle={onToggle}
            />
          </ul>
        )}
      </li>
    );
  });
}
