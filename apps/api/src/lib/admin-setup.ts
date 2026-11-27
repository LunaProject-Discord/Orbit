import { createHash, randomInt, timingSafeEqual } from "node:crypto";

/** 合言葉に使う文字 (読み違えやすい 0/O、1/I/L を除いた 32 文字)。 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
/** 合言葉の長さ (5 文字 × 4 組。約 99 ビットで、総当たりでは当たらない)。 */
const GROUPS = 4;
const GROUP_LENGTH = 5;
/** 1 分あたりに受け付ける、合言葉の間違い。超えたら少し待たせる。 */
const MAX_FAILURES_PER_MINUTE = 10;

function generate(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let group = "";
    for (let i = 0; i < GROUP_LENGTH; i++) {
      group += ALPHABET[randomInt(ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join("-");
}

/** 入力の揺れ (小文字、区切りの有無、前後の空白) をそろえる。 */
export function normalizeSetupCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function digest(value: string): Buffer {
  return createHash("sha256").update(normalizeSetupCode(value)).digest();
}

export type SetupCodeLog = (code: string) => void;

/** サーバーのログに合言葉を出す。目立つように枠で囲む。 */
export const logSetupCode: SetupCodeLog = (code) => {
  const lines = [
    "管理者がまだいません。Web の /admin/setup を開き、次の合言葉を入力して最初の管理者を作ってください。",
    `合言葉: ${code}`,
    "(サーバー上のコマンド `node apps/api/dist/cli/admin.js create <名前> <表示名>` でも作れます)",
  ];
  const bar = "=".repeat(72);
  console.log([bar, ...lines, bar].join("\n"));
};

/**
 * 初回セットアップ (管理者が 1 人もいないときに、画面から最初の管理者を作る) の合言葉。
 * 合言葉はサーバーのログにだけ出し、知っている人 (サーバーを操作できる人) だけが管理者を作れる。
 * 値はこのプロセスのメモリにだけ置き、管理者を作ったら捨てる。
 */
export class SetupCode {
  #value: string | null = null;
  #failures: number[] = [];
  #busy: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly log: SetupCodeLog = logSetupCode,
    private readonly now: () => number = Date.now,
  ) {}

  /** 合言葉が無ければ作ってログに出す (管理者がいないと分かったときに呼ぶ)。 */
  ensure(): void {
    if (this.#value) return;
    this.#value = generate();
    this.log(this.#value);
  }

  /** 使い終わった合言葉を捨てる (管理者ができたとき)。 */
  clear(): void {
    this.#value = null;
  }

  get active(): boolean {
    return this.#value !== null;
  }

  /** 間違いが続いて、しばらく受け付けない状態か。 */
  limited(): boolean {
    const since = this.now() - 60_000;
    this.#failures = this.#failures.filter((at) => at > since);
    return this.#failures.length >= MAX_FAILURES_PER_MINUTE;
  }

  /** 入力された合言葉が正しいか。間違いは数えておく。 */
  check(input: string): boolean {
    const value = this.#value;
    const ok =
      value !== null &&
      normalizeSetupCode(input).length > 0 &&
      timingSafeEqual(digest(input), digest(value));
    if (!ok) this.#failures.push(this.now());
    return ok;
  }

  /** 最初の管理者の作成を 1 つずつ行う (同時に 2 人できないように)。 */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#busy.then(task, task);
    this.#busy = run.catch(() => {});
    return run;
  }
}
