import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Tauri / Capacitor に同梱するため、サーバーを必要としない静的ファイルとして出力する。
  output: "export",
  images: { unoptimized: true },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
