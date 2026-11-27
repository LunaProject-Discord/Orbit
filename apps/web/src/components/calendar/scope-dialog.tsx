"use client";

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

export type ChangeScope = "this" | "all";

/** 繰り返しの予定を変える・消すとき、この回だけか、すべての回かを選ぶ。 */
export function ScopeDialog({
  action,
  onChoose,
  onCancel,
  note = null,
}: {
  /** 説明に添える文 (参加者に連絡が届くことなど)。 */
  note?: string | null;
  /** null なら閉じている。 */
  action: "save" | "delete" | null;
  onChoose: (scope: ChangeScope) => void;
  onCancel: () => void;
}) {
  const verb = action === "delete" ? "削除" : "変更";
  return (
    <AlertDialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>繰り返しの予定を{verb}します</AlertDialogTitle>
          <AlertDialogDescription>
            {verb}するのは、この予定だけですか? それとも、すべての予定ですか?
            {note && ` ${note}`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>キャンセル</AlertDialogCancel>
          <AlertDialogAction variant="outline" onClick={() => onChoose("all")}>
            すべての予定
          </AlertDialogAction>
          <AlertDialogAction
            variant={action === "delete" ? "destructive" : "default"}
            onClick={() => onChoose("this")}
          >
            この予定のみ
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
