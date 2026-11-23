"use client";

import { type FormEvent, useId, useState } from "react";
import { ColorPicker } from "@/components/mail/color-picker";
import { IconPicker } from "@/components/mail/icon-picker";
import { MailboxIcon } from "@/components/mail/mailbox-icon";
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
import { ACCOUNT_TEXT_CLASS, accountColorStyle } from "@/lib/account-colors";
import {
  ApiError,
  type Mailbox,
  type MailboxOverrides,
  type MailboxRoleOverride,
  type MailboxSummary,
  saveMailboxOverrides,
} from "@/lib/api";
import {
  defaultMailboxLabel,
  hasFixedRole,
  mailboxLabel,
  specialLabels,
} from "@/lib/mailboxes";

type Props = {
  /** 変えるフォルダ。null なら閉じている。 */
  mailbox: MailboxSummary | null;
  /** 全アカウントのフォルダ (同じ役割を持つフォルダを知らせるために使う)。 */
  mailboxes: MailboxSummary[];
  onClose: () => void;
  onSaved: (mailbox: MailboxSummary, overrides: MailboxOverrides) => void;
};

/** 色を選んでいないときに、色を選ぶ画面の出だしにする色。 */
const DEFAULT_COLOR = "#737373";
/** 役割の選択肢のうち「自動 (メールサーバーの設定に従う)」を表す値。 */
const AUTO = "auto";

/** 選べる役割。並びはサイドバーでの並び順に合わせる。 */
const ROLE_CHOICES: MailboxRoleOverride[] = [
  "drafts",
  "sent",
  "archive",
  "junk",
  "trash",
  "none",
];

const ROLE_HELP: Record<Exclude<MailboxRoleOverride, "none">, string> = {
  drafts: "書きかけのメールの控えを、このフォルダに保存します。",
  sent: "送信したメールの控えを、このフォルダに保存します。",
  archive: "「アーカイブ」したメールを、このフォルダへ移します。",
  junk: "「迷惑メールにする」を選んだメールを、このフォルダへ移します。このフォルダのメールは、検索結果や「すべての受信トレイ」には表示されません。",
  trash:
    "削除したメールを、このフォルダへ移します。このフォルダの中で削除すると、完全に削除されます。",
};

function roleLabel(role: MailboxRoleOverride | Mailbox["specialUse"]): string {
  return role === null || role === "none" ? "役割なし" : specialLabels[role];
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "not_found") {
      return "フォルダが見つかりませんでした。メールサーバー側で削除された可能性があります。";
    }
    if (error.code === "fixed_role") {
      return "このフォルダの役割は変えられません。";
    }
  }
  return "保存できませんでした。時間をおいて、もう一度お試しください。";
}

const emptyForm: MailboxOverrides = {
  role: null,
  displayName: null,
  icon: null,
  color: null,
};

/**
 * フォルダの役割・表示名・アイコン・色を、アプリ内でだけ変えるダイアログ。
 * 迷惑メールのフォルダが独自の名前で、役割が分からないメールサーバーなどで使う。
 * スマホ幅では、画面の下から出るシートになる。
 */
export function MailboxOverridesDialog({
  mailbox,
  mailboxes,
  onClose,
  onSaved,
}: Props) {
  const id = useId();
  const [form, setForm] = useState<MailboxOverrides>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 閉じるアニメーションの間も内容が消えないよう、最後の対象を覚えておく。
  const [shown, setShown] = useState<MailboxSummary | null>(mailbox);
  if (mailbox && mailbox !== shown) {
    setShown(mailbox);
    setError(null);
    setForm({
      role: mailbox.roleOverride ?? null,
      displayName: mailbox.displayName ?? null,
      icon: mailbox.icon ?? null,
      color: mailbox.color ?? null,
    });
  }
  const set = (patch: Partial<MailboxOverrides>) =>
    setForm((current) => ({ ...current, ...patch }));

  const detected = shown?.detectedSpecialUse ?? null;
  const fixed = shown ? hasFixedRole(shown) : false;
  /** 保存した後に、このフォルダが持つ役割。 */
  const role: Mailbox["specialUse"] = fixed
    ? (shown?.specialUse ?? null)
    : form.role === null
      ? detected
      : form.role === "none"
        ? null
        : form.role;
  /** いま同じ役割を持っている、同じアカウントのほかのフォルダ (保存すると役割がこちらへ移る)。 */
  const holder =
    shown && form.role !== null && form.role !== "none"
      ? (mailboxes.find(
          (other) =>
            other.accountId === shown.accountId &&
            other.id !== shown.id &&
            other.specialUse === form.role,
        ) ?? null)
      : null;
  const customized =
    form.role !== null ||
    (form.displayName ?? "") !== "" ||
    form.icon !== null ||
    form.color !== null;
  const placeholder = shown
    ? defaultMailboxLabel({ name: shown.name, specialUse: role })
    : "";

  const close = (open: boolean) => {
    if (!open && !busy) onClose();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!mailbox || busy) return;
    const name = (form.displayName ?? "").trim();
    const overrides: MailboxOverrides = {
      ...form,
      role: fixed ? null : form.role,
      displayName: name === "" ? null : name,
    };
    setBusy(true);
    setError(null);
    saveMailboxOverrides(mailbox.id, overrides)
      .then(() => {
        onSaved(mailbox, overrides);
        onClose();
      })
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setBusy(false));
  };

  const autoLabel = `自動 (メールサーバーの設定: ${roleLabel(detected)})`;
  const roleItems = [
    { value: AUTO, label: autoLabel },
    ...ROLE_CHOICES.map((choice) => ({
      value: choice,
      label: roleLabel(choice),
    })),
  ];

  return (
    <Dialog open={mailbox !== null} onOpenChange={close}>
      <DialogContent
        data-slot="mailbox-overrides-dialog"
        // スマホ幅では、画面の下に貼り付くシートにする。
        sheet
        className="flex max-h-[min(44rem,calc(100dvh-2rem))] flex-col gap-0 p-0 max-sm:[--sheet-max-height:92dvh] max-sm:[--sheet-pad:0rem] sm:max-w-md"
      >
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="shrink-0 px-6 pt-6 pb-4 max-sm:gap-0 max-sm:px-4 max-sm:pt-0">
            <DialogTitle>
              「{shown ? mailboxLabel(shown) : ""}」の役割と見た目
            </DialogTitle>
            <DialogDescription>
              このアプリの中での役割・名前・アイコン・色を変えられます。メールサーバー上のフォルダ
              {shown ? ` (${shown.name}) ` : ""}
              は変わりません。この設定は、すべての端末で共通です。
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-2 max-sm:px-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-role`}>役割</Label>
              {fixed ? (
                <p className="text-muted-foreground text-sm">
                  {roleLabel(shown?.specialUse ?? null)}{" "}
                  (このフォルダの役割は変えられません)
                </p>
              ) : (
                <>
                  <Select
                    items={roleItems}
                    value={form.role ?? AUTO}
                    onValueChange={(next) =>
                      set({
                        role:
                          next === AUTO || next === null
                            ? null
                            : (next as MailboxRoleOverride),
                      })
                    }
                  >
                    <SelectTrigger id={`${id}-role`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="start">
                      <SelectItem value={AUTO}>{autoLabel}</SelectItem>
                      {ROLE_CHOICES.map((choice) => (
                        <SelectItem key={choice} value={choice}>
                          <span className="flex items-center gap-2">
                            <MailboxIcon
                              specialUse={choice === "none" ? null : choice}
                            />
                            {roleLabel(choice)}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p
                    className="text-muted-foreground text-xs"
                    aria-live="polite"
                  >
                    {role === null
                      ? "通常のフォルダとして扱います。"
                      : role === "inbox" || role === "all" || role === "flagged"
                        ? `${roleLabel(role)}として扱います。`
                        : ROLE_HELP[role]}
                    {holder &&
                      ` 現在は「${mailboxLabel(holder)}」がこの役割です。保存すると、このフォルダに切り替わります。`}
                  </p>
                </>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-name`}>名前</Label>
              <Input
                id={`${id}-name`}
                value={form.displayName ?? ""}
                maxLength={100}
                autoComplete="off"
                placeholder={placeholder}
                onChange={(event) => set({ displayName: event.target.value })}
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
                      <MailboxIcon specialUse={role} className="size-4" />
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
          </div>

          {error && (
            <p role="alert" className="px-6 pt-2 text-destructive text-sm">
              {error}
            </p>
          )}
          <DialogFooter className="shrink-0 px-6 pt-4 pb-6 max-sm:px-4 max-sm:pb-2">
            <Button
              type="button"
              variant="ghost"
              disabled={busy || !customized}
              onClick={() => setForm(emptyForm)}
              className="sm:mr-auto"
            >
              初期設定に戻す
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              キャンセル
            </Button>
            <Button type="submit" disabled={busy}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
