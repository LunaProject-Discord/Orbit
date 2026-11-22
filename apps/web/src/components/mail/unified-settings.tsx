"use client";

import {
  ArrowDownIcon,
  ArrowUpIcon,
  LayersPlusIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { useId } from "react";
import { Hint } from "@/components/hint";
import { BUILTIN_ICONS, UnifiedMark } from "@/components/mail/unified-mark";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type {
  MailboxSummary,
  SidebarLayout,
  UnifiedFolder,
  UnifiedState,
} from "@/lib/api";
import { moveBy } from "@/lib/mailboxes";
import {
  BUILTIN_LABELS,
  describeUnified,
  setEntryHidden,
  sidebarEntries,
} from "@/lib/unified";

const BUILTIN_DESCRIPTIONS = {
  inbox: "全アカウントの受信トレイ",
  starred: "スターを付けたメール (全フォルダ)",
  drafts: "書きかけのメール",
  outgoing: "まだ送り終えていないメール",
} as const;

/** この要素まで、設定画面をスクロールする (サイドバーのメニューから開いたとき)。 */
export const UNIFIED_SETTINGS_ID = "settings-sidebar-items";

/**
 * 設定画面の「サイドバーの項目と統合フォルダ」。サイドバー上部の項目の並び替えと
 * 表示 / 非表示、統合フォルダの作成・編集・削除をまとめて行う。
 */
export function UnifiedSettings({
  unified,
  mailboxes,
  onLayoutChange,
  onCreate,
  onEdit,
  onDelete,
}: {
  unified: UnifiedState;
  mailboxes: MailboxSummary[];
  onLayoutChange: (layout: SidebarLayout) => void;
  onCreate: () => void;
  onEdit: (folder: UnifiedFolder) => void;
  onDelete: (folder: UnifiedFolder) => void;
}) {
  const id = useId();
  const { all } = sidebarEntries(unified);
  const keys = all.map((entry) => entry.key);
  const hidden = new Set(unified.layout.hidden);
  const move = (key: string, delta: -1 | 1) => {
    const order = moveBy(keys, key, delta);
    if (order) onLayoutChange({ order, hidden: unified.layout.hidden });
  };
  return (
    <section
      id={UNIFIED_SETTINGS_ID}
      className="flex scroll-mt-4 flex-col gap-3"
    >
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold text-base">
          サイドバーの項目と統合フォルダ
        </h2>
        <p className="text-muted-foreground text-sm">
          サイドバーの上部に並ぶ項目の順番と、表示するかどうかを選べます。統合フォルダは、複数のアカウントやフォルダのメールを
          1 つの一覧にまとめたものです。どの端末でも同じ内容になります。
        </p>
      </div>
      <ul className="flex flex-col divide-y rounded-lg border">
        {all.map((entry, index) => {
          const { folder } = entry;
          const label = folder ? folder.name : BUILTIN_LABELS[entry.builtin];
          const Icon = folder ? null : BUILTIN_ICONS[entry.builtin];
          const labelId = `${id}-${entry.key}`;
          return (
            <li
              key={entry.key}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5"
            >
              <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
                {folder ? <UnifiedMark folder={folder} /> : Icon && <Icon />}
              </span>
              <div className="min-w-0 flex-1 basis-40">
                <p id={labelId} className="truncate font-medium text-sm">
                  {label}
                </p>
                <p className="truncate text-muted-foreground text-xs">
                  {folder
                    ? describeUnified(folder, mailboxes)
                    : BUILTIN_DESCRIPTIONS[entry.builtin]}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                {folder && (
                  <>
                    <Hint label="編集">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`${label} を編集`}
                        onClick={() => onEdit(folder)}
                      >
                        <PencilIcon />
                      </Button>
                    </Hint>
                    <Hint label="削除">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`${label} を削除`}
                        onClick={() => onDelete(folder)}
                      >
                        <Trash2Icon />
                      </Button>
                    </Hint>
                  </>
                )}
                <Hint label="上へ移動">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${label} を上へ移動`}
                    disabled={index === 0}
                    onClick={() => move(entry.key, -1)}
                  >
                    <ArrowUpIcon />
                  </Button>
                </Hint>
                <Hint label="下へ移動">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${label} を下へ移動`}
                    disabled={index === all.length - 1}
                    onClick={() => move(entry.key, 1)}
                  >
                    <ArrowDownIcon />
                  </Button>
                </Hint>
                <Hint label="サイドバーに表示">
                  <Switch
                    aria-labelledby={labelId}
                    aria-description="サイドバーに表示"
                    checked={!hidden.has(entry.key)}
                    onCheckedChange={(checked) =>
                      onLayoutChange(
                        setEntryHidden(unified, entry.key, !checked),
                      )
                    }
                    className="ml-2"
                  />
                </Hint>
              </div>
            </li>
          );
        })}
      </ul>
      <Button
        variant="outline"
        size="sm"
        onClick={onCreate}
        className="self-start"
      >
        <LayersPlusIcon />
        統合フォルダを作成
      </Button>
    </section>
  );
}
