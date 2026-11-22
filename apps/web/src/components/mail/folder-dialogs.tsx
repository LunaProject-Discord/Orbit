"use client";

import { type FormEvent, useState } from "react";
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
  type Account,
  ApiError,
  createMailbox,
  deleteMailbox,
  type MailboxSummary,
  renameMailbox,
} from "@/lib/api";
import { mailboxLabel } from "@/lib/mailboxes";

/** 開いているフォルダ操作のダイアログ。 */
export type FolderDialogTarget =
  | { kind: "create"; account: Account; parent: MailboxSummary | null }
  | { kind: "rename"; mailbox: MailboxSummary }
  | { kind: "delete"; mailbox: MailboxSummary };

type Props = {
  target: FolderDialogTarget | null;
  onClose: () => void;
  /** メールサーバーへの反映を受け付けた。画面には、同期が済んでから出る。 */
  onAccepted: (target: FolderDialogTarget) => void;
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "invalid_name":
        return "この名前は使えません。区切り文字 (/ や .)、% 、* は使えません。";
      case "mailbox_exists":
        return "同じ名前のフォルダがすでにあります。";
      case "has_children":
        return "中にフォルダがあるフォルダは削除できません。先に中のフォルダを削除してください。";
      case "special_mailbox":
        return "受信トレイなどの役割があるフォルダは、変更や削除ができません。";
      case "not_found":
        return "フォルダが見つかりませんでした。";
    }
  }
  return "受け付けられませんでした。時間をおいて、もう一度お試しください。";
}

/** フォルダの新規作成、名前の変更、削除のダイアログ。 */
export function FolderDialogs({ target, onClose, onAccepted }: Props) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 閉じるアニメーションの間も文言が消えないよう、最後の対象を覚えておく。
  const [shown, setShown] = useState<FolderDialogTarget | null>(target);
  if (target && target !== shown) {
    setShown(target);
    setName(target.kind === "rename" ? target.mailbox.name : "");
    setError(null);
  }

  const run = async (request: () => Promise<void>) => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      await request();
      onAccepted(target);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = name.trim();
    if (!target || value === "") return;
    if (target.kind === "create") {
      void run(() =>
        createMailbox(target.account.id, target.parent?.id ?? null, value),
      );
    } else if (target.kind === "rename") {
      if (value === target.mailbox.name) onClose();
      else void run(() => renameMailbox(target.mailbox.id, value));
    }
  };

  const close = (open: boolean) => {
    if (!open && !busy) onClose();
  };
  const form = shown?.kind === "delete" ? null : shown;

  return (
    <>
      <Dialog
        open={target !== null && target.kind !== "delete"}
        onOpenChange={close}
      >
        <DialogContent className="sm:max-w-sm">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>
                {form?.kind === "rename"
                  ? "フォルダの名前を変更"
                  : "新しいフォルダ"}
              </DialogTitle>
              <DialogDescription>
                {form?.kind === "rename"
                  ? `「${form.mailbox.name}」の名前を変えます。メールサーバー上のフォルダも同じ名前になります。`
                  : form?.kind === "create"
                    ? form.parent
                      ? `「${mailboxLabel(form.parent)}」の中に、メールサーバー上のフォルダを作ります。`
                      : `${form.account.displayName || form.account.email} に、メールサーバー上のフォルダを作ります。`
                    : null}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="folder-name">フォルダ名</Label>
              <Input
                id="folder-name"
                value={name}
                maxLength={100}
                autoComplete="off"
                autoFocus
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={onClose}
              >
                キャンセル
              </Button>
              <Button type="submit" disabled={busy || name.trim() === ""}>
                {form?.kind === "rename" ? "変更" : "作成"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={target?.kind === "delete"} onOpenChange={close}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>フォルダを削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              「{shown?.kind === "delete" ? shown.mailbox.name : ""}
              」を、中のメール
              {shown?.kind === "delete" && shown.mailbox.totalCount > 0
                ? ` ${shown.mailbox.totalCount} 件`
                : ""}
              ごとメールサーバーから削除します。削除したフォルダとメールは元に戻せません。
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
                if (target?.kind !== "delete") return;
                void run(() => deleteMailbox(target.mailbox.id));
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
