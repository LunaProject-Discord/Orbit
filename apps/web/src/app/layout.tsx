import type { Metadata } from "next";
import "gen-interface-jp/400.css";
import "gen-interface-jp/500.css";
import "gen-interface-jp/600.css";
import "gen-interface-jp/700.css";
import "gen-interface-jp/display-600.css";
import "gen-interface-jp/display-700.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mail",
  description: "複数の端末でリアルタイムに同期するメールアプリ",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className="h-full font-sans antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
