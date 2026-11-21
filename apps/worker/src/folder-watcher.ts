import type { ImapFlow } from "imapflow";

const MIN_RETRY_MS = 10_000;
const MAX_RETRY_MS = 5 * 60_000;

/**
 * 利用者が開いているフォルダを、同期用とは別の接続で IDLE する。
 * IDLE で通知を受けられるのは接続ごとに 1 つのフォルダだけなので、受信トレイ用の接続とは
 * 別に張る。この接続では読み書きはせず、変化があったことを知らせるだけにする
 * (実際の突き合わせは同期用の接続が行う)。
 * サーバーの同時接続数の上限などで繋がらない間は active が false になり、
 * 呼び出し側は短い間隔の確認に切り替える。
 */
export class FolderWatcher {
  private path: string | null = null;
  private client: ImapFlow | null = null;
  private generation = 0;
  private connected = false;
  private wakeRetry: (() => void) | null = null;

  constructor(
    private readonly createClient: () => Promise<ImapFlow>,
    private readonly onChange: (path: string) => void,
    private readonly log: (message: string) => void,
  ) {}

  /** いま IDLE で通知を受けられているか。 */
  get active() {
    return this.connected;
  }

  /** 監視するフォルダを切り替える。null で監視をやめる。 */
  watch(path: string | null) {
    if (path === this.path) return;
    this.path = path;
    this.generation++;
    this.connected = false;
    this.client?.close();
    this.client = null;
    this.wakeRetry?.();
    if (path !== null) void this.run(path, this.generation);
  }

  close() {
    this.watch(null);
  }

  private async run(path: string, generation: number) {
    let retry = MIN_RETRY_MS;
    let warned = false;
    while (generation === this.generation) {
      const changed = () => {
        if (generation === this.generation) this.onChange(path);
      };
      let client: ImapFlow | null = null;
      try {
        // OAuth2 のアカウントでは、ここでアクセストークンを取得する (失敗することがある)。
        const created = await this.createClient();
        client = created;
        if (generation !== this.generation) return;
        this.client = created;
        const closed = new Promise<void>((resolve) =>
          created.on("close", resolve),
        );
        // 切断時のエラーは close で拾う。リスナーが無いと例外になるので受けておく。
        created.on("error", () => {});
        created.on("exists", changed);
        created.on("expunge", changed);
        created.on("flags", changed);
        await client.connect();
        // 読み取り専用で開く。コマンドの合間は ImapFlow が自動で IDLE に入る。
        await client.mailboxOpen(path, { readOnly: true });
        if (generation !== this.generation) return;
        this.connected = true;
        retry = MIN_RETRY_MS;
        warned = false;
        // 接続までの間に起きた変化を取りこぼさないよう、一度確認させる。
        changed();
        await closed;
      } catch (error) {
        if (generation === this.generation && !warned) {
          warned = true;
          const reason = error instanceof Error ? error.message : String(error);
          this.log(
            `開いているフォルダ用の接続を張れませんでした。短い間隔の確認に切り替えます: ${reason}`,
          );
        }
      } finally {
        if (generation === this.generation) this.connected = false;
        client?.close();
      }
      if (generation !== this.generation) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, retry);
        this.wakeRetry = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wakeRetry = null;
      retry = Math.min(retry * 2, MAX_RETRY_MS);
    }
  }
}
