import type { Account } from "@/lib/api";

/** サイドバーなどに出す、同期の状況。 */
export type SyncStatus = {
  /** ok は同期済み、busy は反映の途中、offline は繋がっていない、error はアカウントの問題。 */
  tone: "ok" | "busy" | "offline" | "error";
  /** サイドバーに出す文言。 */
  label: string;
  /** 狭い場所に出す短い文言。 */
  short: string;
};

export type SyncInput = {
  /** ブラウザーがネットワークに繋がっているか (navigator.onLine)。 */
  online: boolean;
  /** サーバーからの変更通知の接続。null は、まだ一度も繋がっていない。 */
  connected: boolean | null;
  /** まだサーバーへ送れていない操作 (既読、移動など) の数。 */
  pendingActions: number;
  /** 送信待ちのメールの数 (失敗したものは除く)。 */
  pendingMails: number;
  /** 読み込み前は null。 */
  accounts: Pick<Account, "status">[] | null;
  /** いまサーバーに接続している端末の数 (この端末を含む)。 */
  devices: number;
};

/** 画面とサーバーの同期の状況を、表示用の文言にまとめる。 */
export function syncStatusOf(input: SyncInput): SyncStatus {
  const pending = input.pendingActions + input.pendingMails;
  if (!input.online) {
    const parts = [
      input.pendingActions > 0
        ? `${input.pendingActions} 件の操作を反映`
        : null,
      input.pendingMails > 0 ? `${input.pendingMails} 件を送信` : null,
    ].filter(Boolean);
    return {
      tone: "offline",
      label:
        parts.length > 0
          ? `オフライン · 接続後に ${parts.join("、")}`
          : "オフライン",
      short: "オフライン",
    };
  }
  if (input.connected === false) {
    return {
      tone: "offline",
      label: "サーバーに接続できません · 再接続しています",
      short: "再接続中",
    };
  }
  if (input.connected === null || input.accounts === null) {
    return { tone: "busy", label: "接続しています…", short: "接続中" };
  }
  const broken = input.accounts.filter(
    (account) =>
      account.status === "auth_required" || account.status === "error",
  ).length;
  if (broken > 0) {
    return {
      tone: "error",
      label: `${broken} 件のアカウントを同期できていません`,
      short: "同期エラー",
    };
  }
  if (pending > 0) {
    return {
      tone: "busy",
      label: `同期中 · ${pending} 件を反映しています`,
      short: "同期中",
    };
  }
  return {
    tone: "ok",
    label:
      input.devices > 1
        ? `同期済み · ${input.devices} 台の端末と一致`
        : "同期済み",
    short: "同期済み",
  };
}

const DEVICE_KEY = "mail.device-id";

/**
 * この端末 (ブラウザー) の ID。サーバーが、接続している端末を数えるのに使う。
 * 保存できない環境では、ページを開くたびに別の端末として数えられる。
 */
export function deviceId(): string {
  try {
    const saved = window.localStorage.getItem(DEVICE_KEY);
    if (saved && /^[0-9a-f-]{36}$/i.test(saved)) return saved;
    const created = crypto.randomUUID();
    window.localStorage.setItem(DEVICE_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}
