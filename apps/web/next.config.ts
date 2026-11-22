import { hostname, networkInterfaces } from "node:os";
import type { NextConfig } from "next";

/**
 * 開発サーバー (next dev) を、同じ LAN の別の端末 (スマホなど) から開けるようにする。
 * Next.js は、localhost 以外から来た開発用の通信 (HMR など) を断るので、
 * 許可していないと画面が「読み込み中」のまま動かない。
 * この PC の名前と IP アドレスを許可する。足りなければ DEV_ALLOWED_ORIGINS (カンマ区切り) で足す。
 */
function devOrigins(): string[] {
  const hosts = new Set<string>([hostname(), `${hostname()}.local`]);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        hosts.add(address.address);
      }
    }
  }
  for (const host of (process.env.DEV_ALLOWED_ORIGINS ?? "").split(",")) {
    if (host.trim()) hosts.add(host.trim());
  }
  return [...hosts];
}

const nextConfig: NextConfig = {
  // Tauri / Capacitor に同梱するため、サーバーを必要としない静的ファイルとして出力する。
  output: "export",
  allowedDevOrigins: devOrigins(),
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
