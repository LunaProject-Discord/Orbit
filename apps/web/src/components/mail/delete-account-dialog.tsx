"use client";

import { useState } from "react";
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
import { type Account, deleteAccount } from "@/lib/api";

type Props = {
  /** 削除の確認中のアカウント。null なら閉じている。 */
  account: Account | null;
  onClose: () => void;
  onDeleted: (id: string) => void;
};

export function DeleteAccountDialog({ account, onClose, onDeleted }: Props) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 閉じるアニメーションの間も文言が消えないよう、最後のアカウントを覚えておく。
  const [shown, setShown] = useState<Account | null>(account);
  if (account && account !== shown) setShown(account);

  async function handleDelete() {
    if (!account) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteAccount(account.id);
      onDeleted(account.id);
      onClose();
    } catch {
      setError("削除できませんでした。もう一度お試しください。");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <AlertDialog
      open={account !== null}
      onOpenChange={(open) => {
        if (!open && !deleting) {
          setError(null);
          onClose();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>アカウントを削除しますか？</AlertDialogTitle>
          <AlertDialogDescription>
            {shown?.email}{" "}
            をこのアプリから削除します。同期済みのメールはこのアプリから消えますが、メールサーバー上のメールは削除されません。
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>キャンセル</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleting}
            onClick={handleDelete}
          >
            {deleting ? "削除中…" : "削除"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
