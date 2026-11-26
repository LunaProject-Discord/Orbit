/**
 * サーバーとアプリの更新の方針 (docs/updates.md)。サーバーの管理者が deploy/.env に書く。
 * サーバー自身の更新は deploy/update.sh が行う。アプリ (画面も本体も) は接続先のサーバーから
 * 更新を受け取るので、サーバーの版を固定すればアプリも同じ版に揃う。
 */

/** 追いかける版の種類。stable は正式版、beta は試験版も含む、edge は main の最新。 */
export type UpdateChannel = "stable" | "beta" | "edge";

/** アプリ本体の更新のしかた。auto は確認せずに取得して入れる、notify は知らせるだけ、off は何もしない。 */
export type AppUpdateMode = "auto" | "notify" | "off";

export type UpdatePolicy = {
  channel: UpdateChannel;
  /** 固定する版 (先頭の v は付けない)。null なら channel の最新を追う。 */
  pinnedVersion: string | null;
  /** サーバー自身を定期的に更新するか (deploy/update.sh)。 */
  serverAutoUpdate: boolean;
  appUpdate: AppUpdateMode;
};

export type BuildInfo = {
  /** 動いているサーバーの版 (例 "1.2.0"、"1.2.0-beta.1"、main なら "1.2.0-dev+abc1234")。 */
  version: string;
  /** ビルドしたコミット。分からなければ null。 */
  commit: string | null;
};

/** 版の書式 (semver の major.minor.patch と、任意の -プレリリース)。 */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function warn(message: string) {
  console.warn(`[更新の設定] ${message}`);
}

export function loadUpdatePolicy(env: NodeJS.ProcessEnv): UpdatePolicy {
  const rawChannel = env.ORBIT_UPDATE_CHANNEL?.trim().toLowerCase() || "stable";
  let channel: UpdateChannel = "stable";
  if (
    rawChannel === "stable" ||
    rawChannel === "beta" ||
    rawChannel === "edge"
  ) {
    channel = rawChannel;
  } else {
    warn(
      `ORBIT_UPDATE_CHANNEL=${rawChannel} は使えません。stable として扱います。`,
    );
  }

  const rawPinned = env.ORBIT_UPDATE_VERSION?.trim().replace(/^v/, "") ?? "";
  let pinnedVersion: string | null = null;
  if (rawPinned) {
    if (VERSION_PATTERN.test(rawPinned)) {
      pinnedVersion = rawPinned;
    } else {
      warn(
        `ORBIT_UPDATE_VERSION=${rawPinned} は版の書式ではありません。無視します。`,
      );
    }
  }

  const rawApp = env.ORBIT_APP_UPDATE?.trim().toLowerCase() || "auto";
  let appUpdate: AppUpdateMode = "auto";
  if (rawApp === "auto" || rawApp === "notify" || rawApp === "off") {
    appUpdate = rawApp;
  } else {
    warn(`ORBIT_APP_UPDATE=${rawApp} は使えません。auto として扱います。`);
  }

  const rawServer = env.ORBIT_SERVER_AUTO_UPDATE?.trim().toLowerCase();
  return {
    channel,
    pinnedVersion,
    serverAutoUpdate: rawServer === "true",
    appUpdate,
  };
}

/** ビルド時に埋め込まれた版 (Dockerfile の ORBIT_VERSION / ORBIT_COMMIT)。 */
export function loadBuildInfo(env: NodeJS.ProcessEnv): BuildInfo {
  const version = env.ORBIT_VERSION?.trim().replace(/^v/, "") || "0.0.0-dev";
  const commit = env.ORBIT_COMMIT?.trim() || null;
  return { version, commit };
}
