"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** テーマをライト / ダーク / システム (OS に追従) から選ぶメニュー。 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="icon" aria-label="テーマを切り替え" />
        }
      >
        <SunIcon className="dark:hidden" />
        <MoonIcon className="hidden dark:block" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light" closeOnClick>
            <SunIcon />
            ライト
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark" closeOnClick>
            <MoonIcon />
            ダーク
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system" closeOnClick>
            <MonitorIcon />
            システム
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
