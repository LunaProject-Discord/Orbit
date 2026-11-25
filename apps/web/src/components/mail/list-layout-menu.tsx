"use client";

import {
  EllipsisIcon,
  LayoutListIcon,
  PanelBottomIcon,
  PanelRightIcon,
  Table2Icon,
} from "lucide-react";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type Preferences, updatePreferences } from "@/lib/preferences";

/**
 * 一覧の見出しの「…」のメニュー。一覧の表示 (カード / テーブル) と、
 * 開いたメールを表示する場所 (右 / 下) を選ぶ。
 */
export function ListLayoutMenu({
  listLayout,
  readingPane,
  showReadingPane,
  className,
}: {
  listLayout: Preferences["listLayout"];
  readingPane: Preferences["readingPane"];
  /** メールを表示する場所を選べるか (一覧とメールを並べる広い画面だけ)。 */
  showReadingPane: boolean;
  className?: string;
}) {
  return (
    <DropdownMenu>
      <Hint label="表示の設定">
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="表示の設定"
              className={className}
            />
          }
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuRadioGroup
          value={listLayout}
          onValueChange={(value) =>
            updatePreferences({
              listLayout: value as Preferences["listLayout"],
            })
          }
        >
          <DropdownMenuLabel>一覧の表示</DropdownMenuLabel>
          <DropdownMenuRadioItem value="cards" closeOnClick>
            <LayoutListIcon />
            カード
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="table" closeOnClick>
            <Table2Icon />
            テーブル
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {showReadingPane && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={readingPane}
              onValueChange={(value) =>
                updatePreferences({
                  readingPane: value as Preferences["readingPane"],
                })
              }
            >
              <DropdownMenuLabel>メールを表示する場所</DropdownMenuLabel>
              <DropdownMenuRadioItem value="right" closeOnClick>
                <PanelRightIcon />
                一覧の右
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="bottom" closeOnClick>
                <PanelBottomIcon />
                一覧の下
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
