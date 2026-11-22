import type { Metadata } from "next";
import "gen-interface-jp/400.css";
import "gen-interface-jp/500.css";
import "gen-interface-jp/600.css";
import "gen-interface-jp/700.css";
import "gen-interface-jp/display-600.css";
import "gen-interface-jp/display-700.css";
import "./globals.css";
import { AuthGate, AuthProvider } from "@/components/auth-provider";
import { OfflineBoot } from "@/components/offline-boot";
import { PreferencesEffect } from "@/components/preferences-effect";
import { ScrollbarHover } from "@/components/scrollbar-hover";
import { ThemeProvider } from "@/components/theme-provider";

export const metadata: Metadata = {
  title: "Orbit",
  applicationName: "Orbit",
  description: "複数の端末でリアルタイムに同期するメールアプリ",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // next-themes が描画前に html の class を書き換えるため、差分の警告を抑える。
    <html
      lang="ja"
      className="h-full font-sans antialiased"
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col">
        <OfflineBoot />
        <PreferencesEffect />
        <ScrollbarHover />
        <ThemeProvider>
          <AuthProvider>
            <AuthGate>{children}</AuthGate>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
