"use client";

import {
  ArrowDownIcon,
  ArrowUpIcon,
  ListPlusIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import type { Account, SidebarCategory, UnifiedState } from "@/lib/api";
import { moveBy } from "@/lib/mailboxes";
import { groupSidebar } from "@/lib/sidebar-categories";
import { builtinLabel } from "@/lib/unified";

/**
 * 設定画面の「カテゴリ」。サイドバーのアカウントや統合フォルダをまとめるカテゴリの
 * 作成・名前の変更・並べ替え・削除。中に入れる項目は、サイドバーのドラッグか右クリックメニューで選ぶ。
 */
export function CategorySettings({
  unified,
  accounts,
  onCreate,
  onRename,
  onDelete,
  onReorder,
}: {
  unified: UnifiedState;
  accounts: Account[];
  onCreate: () => void;
  onRename: (category: SidebarCategory) => void;
  onDelete: (category: SidebarCategory) => void;
  onReorder: (ids: string[]) => void;
}) {
  const groups = groupSidebar(unified, accounts).categories;
  const ids = groups.map((group) => group.category.id);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="font-semibold text-base">カテゴリ</h3>
        <p className="text-muted-foreground text-sm">
          アカウントや統合フォルダを「仕事」「個人」などのカテゴリにまとめ、サイドバーで見出しごとに折りたためます。項目は、サイドバーでカテゴリの見出しへドラッグするか、右クリックメニューの「カテゴリ」から入れられます。
        </p>
      </div>
      {groups.length > 0 && (
        <ul className="flex flex-col divide-y rounded-lg border">
          {groups.map(({ category, views, accounts: members }, index) => {
            const names = [
              ...views.map((entry) =>
                entry.folder
                  ? entry.folder.name
                  : builtinLabel(unified, entry.builtin),
              ),
              ...members.map((account) => account.displayName || account.email),
            ];
            return (
              <li
                key={category.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1 basis-40">
                  <p className="truncate font-medium text-sm">
                    {category.name}
                  </p>
                  <p className="truncate text-muted-foreground text-xs">
                    {names.length > 0 ? names.join("、") : "項目なし"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Hint label="名前を変更">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${category.name} の名前を変更`}
                      onClick={() => onRename(category)}
                    >
                      <PencilIcon />
                    </Button>
                  </Hint>
                  <Hint label="削除">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${category.name} を削除`}
                      onClick={() => onDelete(category)}
                    >
                      <Trash2Icon />
                    </Button>
                  </Hint>
                  <Hint label="上へ移動">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${category.name} を上へ移動`}
                      disabled={index === 0}
                      onClick={() => {
                        const next = moveBy(ids, category.id, -1);
                        if (next) onReorder(next);
                      }}
                    >
                      <ArrowUpIcon />
                    </Button>
                  </Hint>
                  <Hint label="下へ移動">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${category.name} を下へ移動`}
                      disabled={index === groups.length - 1}
                      onClick={() => {
                        const next = moveBy(ids, category.id, 1);
                        if (next) onReorder(next);
                      }}
                    >
                      <ArrowDownIcon />
                    </Button>
                  </Hint>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={() => onCreate()}
        className="self-start"
      >
        <ListPlusIcon />
        カテゴリを作成
      </Button>
    </section>
  );
}
