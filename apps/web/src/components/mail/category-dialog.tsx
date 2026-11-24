"use client";

import { type FormEvent, useState } from "react";
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
import type { SidebarCategory } from "@/lib/api";
import { MAX_CATEGORY_NAME } from "@/lib/sidebar-categories";

/** 開いているカテゴリのダイアログ。create の key は、作ったカテゴリへ入れる項目。 */
export type CategoryDialogTarget =
  | { kind: "create"; key?: string; label?: string }
  | { kind: "rename"; category: SidebarCategory };

/** サイドバーのカテゴリを作る / 名前を変えるダイアログ。 */
export function CategoryDialog({
  target,
  onClose,
  onSubmit,
}: {
  target: CategoryDialogTarget | null;
  onClose: () => void;
  onSubmit: (target: CategoryDialogTarget, name: string) => void;
}) {
  const [name, setName] = useState("");
  // 閉じるアニメーションの間も文言が消えないよう、最後の対象を覚えておく。
  const [shown, setShown] = useState<CategoryDialogTarget | null>(target);
  if (target && target !== shown) {
    setShown(target);
    setName(target.kind === "rename" ? target.category.name : "");
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = name.trim();
    if (!target || value === "") return;
    onSubmit(target, value);
    onClose();
  };

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {shown?.kind === "rename"
                ? "カテゴリの名前を変更"
                : "新しいカテゴリ"}
            </DialogTitle>
            <DialogDescription>
              {shown?.kind === "rename"
                ? `「${shown.category.name}」の名前を変えます。`
                : shown?.label
                  ? `サイドバーにカテゴリを作り、「${shown.label}」を入れます。`
                  : "サイドバーのアカウントや統合フォルダを、カテゴリにまとめられます。"}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="category-name">カテゴリ名</Label>
            <Input
              id="category-name"
              value={name}
              maxLength={MAX_CATEGORY_NAME}
              autoComplete="off"
              placeholder="例: 仕事"
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              キャンセル
            </Button>
            <Button type="submit" disabled={name.trim() === ""}>
              {shown?.kind === "rename" ? "変更" : "作成"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
