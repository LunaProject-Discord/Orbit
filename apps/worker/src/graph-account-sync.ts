import {
  type BodyFetchPriority,
  decryptCredentials,
  describeFetchFailure,
  encryptCredentials,
  type GraphLifecycleEvent,
  graphClientState,
  graphWebhookUrl,
  type MicrosoftOAuthConfig,
  MicrosoftOAuthError,
  refreshMicrosoftToken,
} from "@orbit/core";
import { type Database, mailAccounts, mailboxes } from "@orbit/db";
import { and, eq } from "drizzle-orm";
import {
  AttachmentRequests,
  graphAttachmentDownloader,
} from "./attachment-fetch.js";
import { BodyRequests, graphBodyFetcher } from "./body-fetch.js";
import { recordChanges } from "./changes.js";
import { graphDraftRemote } from "./draft-graph.js";
import { dbDraftStore, processDrafts } from "./draft-sync.js";
import { GraphClient, GraphError } from "./graph-client.js";
import {
  ensureSubscription,
  MAX_SLOWDOWN,
  type PushState,
  pollInterval,
  RENEW_BEFORE_MS,
} from "./graph-push.js";
import {
  fetchGraphBodies,
  fetchGraphHeaders,
  syncGraphFolder,
  syncGraphFolders,
} from "./graph-sync.js";
import { syncPriority } from "./mailbox-list.js";
import { isMailboxOperation } from "./mailbox-operations.js";
import { headerBackfillPause } from "./message-headers.js";
import { processOutbox } from "./outbox.js";
import { applyGraphOperation } from "./outbox-graph.js";
import { processSends } from "./send.js";
import { sendViaGraph } from "./send-graph.js";

const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/**
 * 利用者が画面を開いているとみなす時間。端末は 30 秒ごとに知らせてくるので、
 * 知らせが 2 回続けて届かなければ、開いていない扱いに戻す。
 */
const PRESENCE_TTL_MS = 75_000;
/** 制限 (429) を受けて延ばした間隔を、この時間だけ制限なしで過ごせたら半分に戻す。 */
const SLOWDOWN_DECAY_MS = 5 * 60_000;
/** 変更通知の購読に失敗したとき、次に試すまでの時間 (その間は定期的な確認だけで同期する)。 */
const PUSH_RETRY_MS = 60 * 60_000;
/**
 * 購読の延長と再認可を続けて行わない間隔。Graph は同じ購読への更新を
 * 10 分以内に繰り返さないよう求めている。
 * https://learn.microsoft.com/graph/change-notifications-lifecycle-events
 */
const PUSH_RENEW_GAP_MS = 15 * 60_000;
/** フォルダ一覧を取り直す間隔。 */
const FOLDER_SYNC_MS = 10 * 60_000;
/**
 * 受信トレイ以外のフォルダの差分を確認する間隔。受信トレイより長くして、
 * フォルダが多いアカウントでも呼び出しの数を抑える。
 */
const OTHER_POLL_MS = 2 * 60_000;
/** アクセストークンは、期限のこれだけ前に取り直す。 */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** 利用者が見ているメールの本文を、同期とは別に先に取得するときの同時数。 */
const ON_DEMAND_BODY_CONCURRENCY = 2;

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
  // Node の fetch は接続に失敗すると "fetch failed" とだけ言う。本当の理由は cause にある。
  if (error.message === "fetch failed") {
    return `Microsoft Graph に接続できませんでした: ${describeFetchFailure(error)}`;
  }
  return error.message;
}

/**
 * Microsoft Graph を使うアカウント (Exchange Online、Outlook.com) 1 件分の同期。
 * 全フォルダを差分取得で同期し、状況に応じた間隔で差分を確認し続ける。
 * - 受信トレイと、利用者が開いているフォルダ: 画面を開いている間は 5 秒、そうでなければ 15 秒
 * - 他のフォルダ: 2 分 (移動などの操作や変更通知の直後はすぐ)
 * - API に公開された HTTPS の URL があれば変更通知 (Webhook) を購読し、届いたらすぐ確認する。
 *   通知が実際に届いている間は、定期的な確認を取りこぼしに備えた長い間隔に落とす
 * - 制限 (429) を受けたら間隔を倍に延ばし、しばらく制限なしで過ごせたら戻す
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
  /** 待たずに次の周回を始める (操作が積まれた、開いたフォルダが変わった、変更通知が届いた)。 */
  private wakeRequested = false;
  private presentUntil = 0;
  /** 利用者が開いているフォルダ (mailboxes.id)。受信トレイなら null。 */
  private focusMailboxId: string | null = null;
  private slowdown = 1;
  private slowdownAt = 0;
  private push: PushState;
  /** 変更通知が届いた。全フォルダの差分を確認する。 */
  private pushPending = false;
  /** 変更通知が実際に届いたことがある。届くまでは定期的な確認の間隔を落とさない。 */
  private pushTrusted = false;
  private pushRenewRequested = false;
  private pushRecreate = false;
  private pushRetryAt = 0;
  private pushRenewedAt = 0;
  private sending: Promise<void> = Promise.resolve();
  private readonly attachmentRequests: AttachmentRequests;
  private readonly bodyRequests: BodyRequests;

  constructor(
    private readonly db: Database,
    private readonly encryptionKey: Buffer,
    account: AccountRow,
    private readonly oauth: MicrosoftOAuthConfig | null,
    /** 変更通知 (Webhook) の受け口の URL。公開された HTTPS の URL が無ければ null。 */
    private readonly webhookBaseUrl: string | null = null,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.account = account;
    this.push = {
      subscriptionId: account.pushSubscriptionId,
      expiresAt: account.pushExpiresAt,
    };
    // 利用者が開いたものをすぐ取得するための窓口。同期の周期とは別に使う。
    const onDemand = new GraphClient({
      getToken: (force) => this.getToken(force),
      fetchFn: this.fetchFn,
    });
    this.attachmentRequests = new AttachmentRequests(
      db,
      account.id,
      graphAttachmentDownloader(onDemand, this.abort.signal),
      (message) => this.log(message),
    );
    this.bodyRequests = new BodyRequests(
      db,
      account,
      graphBodyFetcher(db, onDemand, this.abort.signal),
      (message) => this.log(message),
      ON_DEMAND_BODY_CONCURRENCY,
    );
  }

  /** 利用者が見ているメールの本文を、取り込みの順番を待たずに取得してほしい。 */
  notifyBody(messageIds: string[], priority: BodyFetchPriority) {
    if (!this.stopped) this.bodyRequests.request(messageIds, priority);
  }

  /** 添付ファイルの実体を取得してほしい (利用者が開いた)。同期の周期とは別に、すぐ取得する。 */
  notifyAttachment(attachmentId: string) {
    if (!this.stopped) this.attachmentRequests.request(attachmentId);
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

  /** 送信待ちキューに操作が積まれた。次の確認を待たずに、すぐに反映する。 */
  notifyOutbox() {
    this.requestWake();
    this.flushSends();
  }

  /** 利用者が画面を開いている。mailboxId は開いているフォルダ (受信トレイなら null)。 */
  notifyFocus(mailboxId: string | null, refresh = false) {
    const wasPresent = Date.now() < this.presentUntil;
    this.presentUntil = Date.now() + PRESENCE_TTL_MS;
    // refresh は、利用者がフォルダの更新を指示したこと。同じフォルダでも確認し直す。
    if (wasPresent && mailboxId === this.focusMailboxId && !refresh) return;
    // 開いた直後のフォルダは、次の確認を待たずに同期する。
    this.focusMailboxId = mailboxId;
    this.requestWake();
  }

  /** Microsoft Graph から変更通知が届いた。lifecycle は購読の状態の知らせ。 */
  notifyPush(lifecycle: GraphLifecycleEvent | null) {
    if (lifecycle === "reauthorizationRequired") {
      this.pushRenewRequested = true;
    } else if (lifecycle === "subscriptionRemoved") {
      this.pushRecreate = true;
    } else {
      // メールの変更、または通知の取りこぼし (missed)。どちらも差分を確認すれば追いつく。
      this.pushPending = true;
      if (lifecycle === null) this.pushTrusted = true;
    }
    this.requestWake();
  }

  private requestWake() {
    this.wakeRequested = true;
    this.wake?.();
  }

  /** 送信待ちのメールを送る。同期の周期とは別に、同時には 1 回だけ走らせる。 */
  private flushSends() {
    this.sending = this.sending
      .then(async () => {
        if (this.stopped) return;
        const client = new GraphClient({
          getToken: (force) => this.getToken(force),
          fetchFn: this.fetchFn,
        });
        const result = await processSends(
          this.db,
          this.account,
          (message) => sendViaGraph(client, message, this.abort.signal),
          (message) => this.log(message),
        );
        if (result.sent > 0) this.log(`メールを ${result.sent} 通送信しました`);
      })
      .catch((error) =>
        this.log(
          `送信待ちのメールを処理できませんでした: ${error instanceof Error ? error.message : ""}`,
        ),
      );
  }

  /**
   * 変更通知 (Webhook) の購読を作り、期限が近づいたら延ばす。
   * 失敗しても同期は止めず、定期的な確認だけで続ける (しばらくしてから試し直す)。
   */
  private async maintainPush(client: GraphClient, signal: AbortSignal) {
    if (!this.webhookBaseUrl) return;
    const now = Date.now();
    if (now < this.pushRetryAt) return;
    if (this.pushRecreate) {
      this.push = { subscriptionId: null, expiresAt: null };
    }
    const expiresAt = this.push.expiresAt?.getTime() ?? 0;
    const alive = this.push.subscriptionId !== null && expiresAt > now;
    const due =
      !alive || expiresAt - now < RENEW_BEFORE_MS || this.pushRenewRequested;
    if (!due) return;
    if (alive && now - this.pushRenewedAt < PUSH_RENEW_GAP_MS) return;
    try {
      const created = !alive;
      this.push = await ensureSubscription(client, {
        state: this.push,
        notificationUrl: graphWebhookUrl(this.webhookBaseUrl, this.account.id),
        clientState: graphClientState(this.encryptionKey, this.account.id),
        signal,
      });
      this.pushRenewedAt = now;
      this.pushRenewRequested = false;
      this.pushRecreate = false;
      await this.savePush();
      if (created) this.log("変更通知 (Webhook) の購読を開始しました");
    } catch (error) {
      if (!(error instanceof GraphError)) throw error;
      // 受け口に外から届かない、権限が無いなど。定期的な確認だけで同期を続ける。
      this.log(
        `変更通知 (Webhook) を購読できませんでした。定期的な確認で同期を続けます: ${error.message}`,
      );
      this.pushRetryAt = now + PUSH_RETRY_MS;
      this.pushTrusted = false;
      if (!alive) {
        this.push = { subscriptionId: null, expiresAt: null };
        await this.savePush();
      }
    }
  }

  private async savePush() {
    await this.db
      .update(mailAccounts)
      .set({
        pushSubscriptionId: this.push.subscriptionId,
        pushExpiresAt: this.push.expiresAt,
      })
      .where(eq(mailAccounts.id, this.account.id));
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
      onThrottle: () => {
        this.slowdown = Math.min(this.slowdown * 2, MAX_SLOWDOWN);
        this.slowdownAt = Date.now();
      },
    });
    let healthy = false;
    let foldersSyncedAt = 0;
    let othersQueuedAt = 0;
    /** これから差分を確認する、受信トレイ以外のフォルダ (mailboxes.id)。 */
    let queue: string[] = [];

    while (!this.stopped) {
      this.wakeRequested = false;
      const pushed = this.pushPending;
      this.pushPending = false;
      if (
        this.slowdown > 1 &&
        Date.now() - this.slowdownAt >= SLOWDOWN_DECAY_MS
      ) {
        this.slowdown /= 2;
        this.slowdownAt = Date.now();
      }

      if (Date.now() - foldersSyncedAt >= FOLDER_SYNC_MS) {
        await syncGraphFolders(this.db, client, this.account, signal);
        foldersSyncedAt = Date.now();
      }
      const folders = await this.db
        .select({
          id: mailboxes.id,
          path: mailboxes.path,
          name: mailboxes.name,
          specialUse: mailboxes.specialUse,
          syncState: mailboxes.syncState,
        })
        .from(mailboxes)
        .where(eq(mailboxes.accountId, this.account.id));
      const inbox = folders.find((folder) => folder.specialUse === "inbox");
      if (!inbox) {
        throw new Error("受信トレイが見つかりませんでした。");
      }
      /** フォルダ 1 つを同期する。消されていたら、フォルダ一覧を取り直させる。 */
      const syncFolder = async (folder: (typeof folders)[number]) => {
        try {
          const result = await syncGraphFolder(
            this.db,
            client,
            this.account,
            folder,
            signal,
          );
          if (result.added > 0 || result.removed > 0) {
            const name = folder.id === inbox.id ? "受信トレイ" : folder.name;
            this.log(
              `${name} を同期しました (追加 ${result.added} 件、削除 ${result.removed} 件)`,
            );
          }
          return result.added > 0 || result.removed > 0;
        } catch (error) {
          if (
            folder.id === inbox.id ||
            !(error instanceof GraphError && error.notFound)
          ) {
            throw error;
          }
          foldersSyncedAt = 0;
          return false;
        }
      };

      // 既読や移動などの操作を先に反映してから、差分を確認する。
      const outbox = await processOutbox(
        this.db,
        this.account.id,
        async (operation) => {
          const result = await applyGraphOperation(client, operation, signal);
          // フォルダを変えたあとは、次の確認でフォルダ一覧から取り直す。
          if (isMailboxOperation(operation)) foldersSyncedAt = 0;
          return result;
        },
        (message) => this.log(message),
      );
      // まだ Microsoft 側へ置いていない下書きを、下書きフォルダへ置く。
      const draftSync = await processDrafts(
        dbDraftStore(this.db, this.account),
        this.account,
        graphDraftRemote(client, signal),
        (message) => this.log(message),
      );
      if (draftSync.saved > 0) {
        this.log(`下書きを ${draftSync.saved} 件、Microsoft へ保存しました`);
      }
      // 置いた控えを、下書きフォルダの同期で取り込む。
      const operated =
        outbox.done > 0 || outbox.failed > 0 || draftSync.saved > 0;

      const present = Date.now() < this.presentUntil;
      const pushActive =
        this.webhookBaseUrl !== null &&
        this.pushTrusted &&
        this.push.subscriptionId !== null &&
        (this.push.expiresAt?.getTime() ?? 0) > Date.now();
      const nextPollAt =
        Date.now() +
        pollInterval({
          present,
          pushTrusted: pushActive,
          slowdown: this.slowdown,
        });

      const inboxChanged = await syncFolder(inbox);
      if (inboxChanged && pushActive && !pushed && !operated) {
        // 通知が届いているはずなのに、定期的な確認で先に変化を見つけた。
        // 通知が届かなくなっているおそれがあるので、次に届くまで短い間隔に戻す。
        this.pushTrusted = false;
      }
      if (!healthy) {
        healthy = true;
        this.backoff = MIN_BACKOFF_MS;
        this.log("Microsoft Graph に接続しました");
        await this.setStatus("active");
      }
      await this.maintainPush(client, signal);

      // 利用者が開いているフォルダは、受信トレイと同じ間隔で確認する。
      const focused = present
        ? folders.find(
            (folder) =>
              folder.id === this.focusMailboxId && folder.id !== inbox.id,
          )
        : undefined;
      if (focused) {
        await syncFolder(focused);
        queue = queue.filter((id) => id !== focused.id);
      }

      // 他のフォルダ。移動などを反映した直後や変更通知の直後は、間隔を待たずに確認する。
      if (
        operated ||
        pushed ||
        Date.now() - othersQueuedAt >= OTHER_POLL_MS * this.slowdown
      ) {
        othersQueuedAt = Date.now();
        queue = folders
          .filter((folder) => folder.id !== inbox.id && folder !== focused)
          .sort(
            (a, b) => syncPriority(a.specialUse) - syncPriority(b.specialUse),
          )
          .map((folder) => folder.id);
      }
      // 受信トレイの次の確認時刻までに終わらなかった分は、次の周回で続ける
      // (周回ごとに少なくとも 1 つは進める)。
      for (let first = true; queue.length > 0 && !this.stopped; first = false) {
        if (!first && (Date.now() >= nextPollAt || this.wakeRequested)) break;
        const id = queue.shift();
        const folder = folders.find((item) => item.id === id);
        if (folder) await syncFolder(folder);
      }

      // 本文の取得は時間がかかるので、次の差分確認の時刻が来たら中断して同期を優先する。
      while (
        !this.stopped &&
        !this.wakeRequested &&
        Date.now() < nextPollAt &&
        (await fetchGraphBodies(
          this.db,
          client,
          this.account,
          signal,
          focused?.id ?? inbox.id,
        ))
      ) {
        // 続きを取得する
      }
      // 代理送信やメーリングリストの情報を足す前に取り込んだメールへ、その情報を補う。
      while (
        !this.stopped &&
        !this.wakeRequested &&
        Date.now() < nextPollAt &&
        (await fetchGraphHeaders(this.db, client, this.account, signal))
      ) {
        // 続きを取得する (DB が重くならないよう、間を空ける)
        await headerBackfillPause();
      }
      if (this.stopped) break;
      // 確認し残したフォルダがあれば、待たずに次の周回で続ける。
      // 書く手が止まるのを待っている下書きがあれば、その時刻に戻ってくる。
      const wakeAt = Math.min(nextPollAt, draftSync.nextDueAt ?? nextPollAt);
      const wait = queue.length > 0 ? 0 : wakeAt - Date.now();
      if (wait > 0 && !this.wakeRequested) await this.sleep(wait);
    }
  }
}
