import type { ReactNode } from "react";
import { type OrbitBrand, OrbitLogo } from "@/components/brand/orbit-logo";
import { ThemeToggle } from "@/components/theme-toggle";

/** ログイン前の画面 (ログイン、パスワードの再設定) の共通の枠。 */
export function AuthShell({
  lead,
  children,
  brand = "mail",
}: {
  /** 上に出すロゴ。管理画面は製品名の付かない Orbit。 */
  brand?: OrbitBrand;
  /** ロゴの下に出す、画面の説明。 */
  lead: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="relative flex flex-1 flex-col items-center justify-center p-6">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <h1>
          <OrbitLogo className="h-11" product={brand} />
        </h1>
        <p className="mt-4 text-muted-foreground text-sm">{lead}</p>
        {children}
      </div>
    </main>
  );
}

/** パスワードの最小の長さ (サーバーの minPasswordLength と揃える)。 */
export const MIN_PASSWORD_LENGTH = 12;
