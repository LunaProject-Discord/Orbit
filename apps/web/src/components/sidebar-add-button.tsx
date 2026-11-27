"use client";

import { Button } from "@/components/ui/button";

/**
 * サイドバーの一覧の最後に並べる、追加のボタン (メールの「アカウントを追加」、カレンダーの
 * 「カレンダーを追加」など)。アイコンは上の項目のアイコンの列 (左から 16px) に揃える。
 */
export function SidebarAddButton({
  icon,
  onClick,
  disabled,
  title,
  children,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** 押せないときの説明など。 */
  title?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      title={title}
      // ボタンには 1px の枠があるので、その分を引いてアイコンを上の項目の列に揃える。
      // タッチ操作ではボタンの左右の余白が広がるので、同じ値に戻す。
      className="justify-start gap-2 px-[7px] pointer-coarse:px-[7px] text-muted-foreground"
    >
      {icon}
      {children}
    </Button>
  );
}
