import { Hono } from "hono";
import { compareVersions, desktopRelease } from "../lib/app-releases.js";
import type { BuildInfo, UpdatePolicy } from "../lib/update-policy.js";

/**
 * API の互換性の版。古いアプリからも使えるよう後方互換を保ち、互換が切れる変更をしたときだけ増やす。
 * アプリはこれを見て、接続先のサーバーが古すぎないかを確かめる。
 */
export const API_VERSION = 1;

/**
 * このサーバーがまだ受け付ける、いちばん古い API の版。古いアプリへの対応をやめたときに上げる。
 * アプリは「自分が話せる API の版の範囲」とこの範囲が重なるかで、このサーバーを使えるか判定する。
 */
export const MIN_API_VERSION = 1;

/**
 * サーバーの版と更新の方針。ログイン前 (接続先サーバーの確認) にも使うので、認証は求めない。
 * 返すのは版と方針だけで、利用者や設定の秘密の値は含めない。
 */
export function serverInfoRoutes({
  build,
  policy,
  releasesDir,
  publicUrl,
}: {
  build: BuildInfo;
  policy: UpdatePolicy;
  /** アプリ本体の配布用のファイルの置き場。null なら本体は配らない。 */
  releasesDir: string | null;
  /** 外から見たこのサーバーの URL。配布するファイルの URL に使う。 */
  publicUrl: string;
}) {
  const app = new Hono();
  app.get("/server-info", (c) => {
    c.header("Cache-Control", "no-cache");
    return c.json({
      name: "orbit",
      version: build.version,
      commit: build.commit,
      api: { version: API_VERSION, minVersion: MIN_API_VERSION },
      updates: {
        channel: policy.channel,
        pinnedVersion: policy.pinnedVersion,
        serverAutoUpdate: policy.serverAutoUpdate,
        appUpdate: policy.appUpdate,
      },
    });
  });
  /**
   * デスクトップ版の本体の更新 (Tauri の updater が呼ぶ)。
   * 新しい版があれば Tauri の静的な一覧の形で返し、無ければ 204。版の比較は Tauri 側でも行う。
   */
  app.get("/app-update/desktop", async (c) => {
    c.header("Cache-Control", "no-cache");
    if (policy.appUpdate === "off" || !releasesDir) return c.body(null, 204);
    const release = await desktopRelease(releasesDir, publicUrl);
    if (!release) return c.body(null, 204);
    const current = c.req.query("current");
    if (current && (compareVersions(release.version, current) ?? 0) <= 0) {
      return c.body(null, 204);
    }
    return c.json(release);
  });

  return app;
}
