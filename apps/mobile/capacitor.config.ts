import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "jp.lunaproject.orbit.mail",
  appName: "Orbit Mail",
  // apps/web の静的出力 (next build の out/) をそのままアプリに入れる。
  webDir: "../web/out",
  android: {
    // 画面は https://localhost から配信される (API の CORS はこのオリジンを許可している)。
    // 平文の http は使わない。
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      // 画面の描画が始まったら Web 側から隠す (白い画面が一瞬見えるのを防ぐ)。
      launchAutoHide: false,
    },
    SystemBars: {
      // 画面はステータスバーとナビゲーションバーの内側に収める (Web 版と同じ配置のまま使える)。
      // バーの色とアイコンの明暗は、アプリのテーマに合わせて Web 側から切り替える。
      insetsHandling: "css",
    },
  },
};

export default config;
