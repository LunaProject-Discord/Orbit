"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** 完全な削除の確認で待っている操作。 */
export type PermanentDeleteRequest = {
  /** 完全に削除するメールの数。 */
  count: number;
  /** 削除を確定したときに行う処理。 */
  run: () => void;
};

type Props = {
  request: PermanentDeleteRequest | null;
  onClose: () => void;
};

/**
 * ごみ箱のメールを完全に削除する前の確認。デスクトップ幅ではダイアログ、
 * スマホ幅では下から出るシートにする (下へ払う・戻るボタンで閉じられる)。
 */
export function PermanentDeleteDialog({ request, onClose }: Props) {
  // 閉じるアニメーションの間も文言が変わらないよう、最後の内容を覚えておく。
  const [shown, setShown] = useState<PermanentDeleteRequest | null>(request);
  if (request && request !== shown) setShown(request);
  const count = shown?.count ?? 0;

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-slot="permanent-delete-dialog"
        sheet
        showCloseButton={false}
        className="flex flex-col gap-0 p-0 max-sm:[--sheet-pad:0rem] sm:max-w-md"
      >
        <DialogHeader className="px-6 pt-6 pb-4 max-sm:px-4 max-sm:pt-0">
          <DialogTitle>
            {count > 1
              ? `${count.toLocaleString()} 通のメールを完全に削除しますか？`
              : "メールを完全に削除しますか？"}
          </DialogTitle>
          <DialogDescription>
            ごみ箱から削除したメールは、メールサーバーからも完全に消えます。
            <span className="max-sm:hidden">
              {" "}
              Shift キーを押しながら削除すると、この確認を出さずに削除します。
            </span>
          </DialogDescription>
        </DialogHeader>
        {/* 誤って Enter を押しても消えないよう、最初のフォーカスは先に置いたキャンセルに来る。 */}
        <DialogFooter className="px-6 pt-2 pb-6 max-sm:px-4 max-sm:pb-2">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            className="max-sm:h-11"
          >
            キャンセル
          </Button>
          <Button
            type="button"
            variant="destructive"
            // 閉じている途中に押されても、二重に行わない。
            disabled={request === null}
            onClick={() => {
              request?.run();
              onClose();
            }}
            className="max-sm:h-11"
          >
            完全に削除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
