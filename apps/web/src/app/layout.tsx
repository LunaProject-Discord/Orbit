import type { Metadata, Viewport } from "next";
import "gen-interface-jp/400.css";
import "gen-interface-jp/500.css";
import "gen-interface-jp/600.css";
import "gen-interface-jp/700.css";
import "gen-interface-jp/display-600.css";
import "gen-interface-jp/display-700.css";
import "./globals.css";
import { AppUpdateBoot } from "@/components/app-update-boot";
import { AuthGate, AuthProvider } from "@/components/auth-provider";
import { DesktopBoot } from "@/components/desktop/desktop-boot";
import { DesktopTextContextMenu } from "@/components/desktop/text-context-menu";
import { DesktopTitleBar } from "@/components/desktop/title-bar";
import { NativeBoot } from "@/components/native-boot";
import { OfflineBoot } from "@/components/offline-boot";
import { PreferencesEffect } from "@/components/preferences-effect";
import { ScrollbarHover } from "@/components/scrollbar-hover";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

export const metadata: Metadata = {
  title: "Orbit",
  applicationName: "Orbit",
  description: "複数の端末でリアルタイムに同期するメールアプリ",
  // アイコンは app/ の favicon.ico、icon.svg、apple-icon.png を Next.js が自動で入れる。
  manifest: "/manifest.webmanifest",
  appleWebApp: { title: "Orbit", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
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
          <NativeBoot />
          <DesktopBoot />
          <DesktopTitleBar />
          <DesktopTextContextMenu />
          <AuthProvider>
            <TooltipProvider>
              <AuthGate>{children}</AuthGate>
            </TooltipProvider>
            <Toaster />
          </AuthProvider>
        </ThemeProvider>
        <AppUpdateBoot />
      </body>
    </html>
  );
}
