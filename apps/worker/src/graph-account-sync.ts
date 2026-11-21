import {
  decryptCredentials,
  encryptCredentials,
  type MicrosoftOAuthConfig,
  MicrosoftOAuthError,
  refreshMicrosoftToken,
} from "@mail/core";
import { type Database, mailAccounts, mailboxes } from "@mail/db";
import { and, eq } from "drizzle-orm";
import { recordChanges } from "./changes.js";
import { GraphClient, GraphError } from "./graph-client.js";
import {
  fetchGraphBodies,
  syncGraphFolder,
  syncGraphFolders,
} from "./graph-sync.js";

const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/**
 * 差分を確認する間隔。Graph には IMAP IDLE のような常時接続が無く、
 * 即時の通知 (変更通知の Webhook) には公開された HTTPS の受け口が要るため、
 * まずは短い間隔の確認で新着や既読の変化を拾う。
 */
const POLL_MS = 15_000;
/** フォルダ一覧を取り直す間隔。 */
const FOLDER_SYNC_MS = 10 * 60_000;
/** アクセストークンは、期限のこれだけ前に取り直す。 */
const TOKEN_MARGIN_MS = 5 * 60_000;

type AccountRow = typeof mailAccounts.$inferSelect;
type Status = AccountRow["status"];

/** 画面に出すエラーの説明。DB のエラーは SQL や値を含むので、利用者には見せない。 */
function describeError(error: Error & { query?: unknown }): string {
  if (error instanceof GraphError || error instanceof MicrosoftOAuthError) {
    return error.message;
  }
  if (error.query !== undefined || error.message.startsWith("Failed query")) {
    return "サーバー内部でエラーが発生しました。";
  }
  return error.message;
}

/**
 * Microsoft Graph を使うアカウント (Exchange Online、Outlook.com) 1 件分の同期。
 * 受信トレイを差分取得で同期し、一定間隔で差分を確認し続ける。
 */
export class GraphAccountSync {
  /** 接続設定の比較に使う、現在の行。リフレッシュトークンを更新すると差し替わる。 */
  account: AccountRow;
  private stopped = false;
  private readonly abort = new AbortController();
  private wake: (() => void) | null = null;
  private backoff = MIN_BACKOFF_MS;
  private refreshToken: string | null = null;
  private accessToken: { value: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly db: Database,
    private readonly encryptionKey: Buffer,
    account: AccountRow,
    private readonly oauth: MicrosoftOAuthConfig | null,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.account = account;
  }

  private log(message: string) {
    console.log(`[${this.account.email}] ${message}`);
  }

  /** 停止されるか、再ログインが必要になるまで動き続ける。 */
  async run() {
    while (!this.stopped) {
      try {
        await this.session();
      } catch (error) {
        if (this.stopped) break;
        const err = error as Error;
        const reason = describeError(err);
        if (err instanceof MicrosoftOAuthError && err.needsReauth) {
          // リフレッシュトークンの失効や同意の取り消し。本人がログインし直すまで止める。
          this.log(`認証に失敗しました。再ログインが必要です: ${reason}`);
          await this.setStatus("auth_required", reason);
          return;
        }
        this.log(`同期中にエラーが発生しました: ${err.message}`);
        await this.setStatus("error", reason);
      }
      if (this.stopped) break;
      const delay = this.backoff * (0.75 + Math.random() * 0.5);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      await this.sleep(delay);
    }
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
    this.wake?.();
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  private async setStatus(status: Status, lastError: string | null = null) {
    try {
      await this.db.transaction(async (tx) => {
        const [row] = await tx
          .update(mailAccounts)
          .set({ status, lastError })
          .where(eq(mailAccounts.id, this.account.id))
          .returning({ id: mailAccounts.id });
        if (row) {
          await recordChanges(tx, this.account.userId, "account", "upsert", [
            row.id,
          ]);
        }
      });
    } catch (error) {
      this.log(
        `状態を保存できませんでした: ${error instanceof Error ? error.message : ""}`,
      );
    }
  }

  /** 有効なアクセストークンを返す。期限が近いか force なら取り直す。 */
  private getToken(force: boolean): Promise<string> {
    const cached = this.accessToken;
    if (!force && cached && cached.expiresAt - TOKEN_MARGIN_MS > Date.now()) {
      return Promise.resolve(cached.value);
    }
    // 同時に複数の呼び出しが来ても、取り直しは 1 回にまとめる。
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    if (!this.oauth) {
      throw new Error(
        "MICROSOFT_CLIENT_ID と MICROSOFT_CLIENT_SECRET が同期ワーカーに設定されていません。",
      );
    }
    if (this.refreshToken === null) {
      const credentials = decryptCredentials(
        this.account.credentialsEncrypted,
        this.encryptionKey,
        this.account.userId,
      );
      if (credentials.type !== "oauth2") {
        throw new Error("このアカウントには OAuth2 の認証情報がありません。");
      }
      this.refreshToken = credentials.refreshToken;
    }
    const tokens = await refreshMicrosoftToken(
      this.oauth,
      this.refreshToken,
      this.fetchFn,
    );
    this.accessToken = {
      value: tokens.accessToken,
      expiresAt: tokens.expiresAt,
    };
    if (tokens.refreshToken && tokens.refreshToken !== this.refreshToken) {
      // 更新のたびに新しいリフレッシュトークンが返る。保存しておかないと、
      // 再起動後に古いものを使うことになり、いずれ期限が切れる。
      const credentialsEncrypted = encryptCredentials(
        { type: "oauth2", refreshToken: tokens.refreshToken },
        this.encryptionKey,
        this.account.userId,
      );
      // 本人が再ログインして認証情報が入れ替わっていた場合は上書きしない。
      await this.db
        .update(mailAccounts)
        .set({ credentialsEncrypted })
        .where(
          and(
            eq(mailAccounts.id, this.account.id),
            eq(
              mailAccounts.credentialsEncrypted,
              this.account.credentialsEncrypted,
            ),
          ),
        );
      this.refreshToken = tokens.refreshToken;
      this.account = { ...this.account, credentialsEncrypted };
    }
    return tokens.accessToken;
  }

  /** 同期 1 回分。エラーが起きると投げ、run() が間隔を空けてやり直す。 */
  private async session() {
    const signal = this.abort.signal;
    const client = new GraphClient({
      getToken: (force) => this.getToken(force),
      fetchFn: this.fetchFn,
    });
    let healthy = false;
    let foldersSyncedAt = 0;

    while (!this.stopped) {
      if (Date.now() - foldersSyncedAt >= FOLDER_SYNC_MS) {
        await syncGraphFolders(this.db, client, this.account);
        foldersSyncedAt = Date.now();
      }
      const [inbox] = await this.db
        .select({
          id: mailboxes.id,
          path: mailboxes.path,
          syncState: mailboxes.syncState,
        })
        .from(mailboxes)
        .where(
          and(
            eq(mailboxes.accountId, this.account.id),
            eq(mailboxes.specialUse, "inbox"),
          ),
        );
      if (!inbox) {
        throw new Error("受信トレイが見つかりませんでした。");
      }

      const result = await syncGraphFolder(
        this.db,
        client,
        this.account,
        inbox,
        signal,
      );
      if (result.added > 0 || result.removed > 0) {
        this.log(
          `受信トレイを同期しました (追加 ${result.added} 件、削除 ${result.removed} 件)`,
        );
      }
      if (!healthy) {
        healthy = true;
        this.backoff = MIN_BACKOFF_MS;
        this.log("Microsoft Graph に接続しました");
        await this.setStatus("active");
      }

      // 本文の取得は時間がかかるので、次の差分確認の時刻が来たら中断して同期を優先する。
      const nextPollAt = Date.now() + POLL_MS;
      while (
        !this.stopped &&
        Date.now() < nextPollAt &&
        (await fetchGraphBodies(
          this.db,
          client,
          this.account,
          inbox.id,
          signal,
        ))
      ) {
        // 続きを取得する
      }
      if (this.stopped) break;
      const wait = nextPollAt - Date.now();
      if (wait > 0) await this.sleep(wait);
    }
  }
}
