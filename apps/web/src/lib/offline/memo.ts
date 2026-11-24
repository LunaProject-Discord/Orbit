/**
 * メールを開いたときにすぐ表示するための、メモリー上の控え。
 *
 * 会話と本文は、開くたびにサーバーへ取りに行くと往復の時間だけ表示が遅れる。
 * 一度取得したもの (と、端末の保存先から読み出したもの) をここに持っておき、
 * 開いた瞬間はこれを表示して、サーバーからの最新の内容は後から反映する。
 */

export type Memo<T> = {
  value: T;
  /** 控えた時刻 (Date.now())。 */
  at: number;
  /** サーバーから取得した内容か (false なら端末の保存先から読み出したもの)。 */
  network: boolean;
};

/** 使った順に並べ、上限を超えたら長く使っていないものから捨てる。 */
export class MemoCache<T> {
  private readonly entries = new Map<string, Memo<T>>();

  constructor(private readonly max: number) {}

  get(key: string): Memo<T> | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  set(key: string, value: T, network: boolean, now = Date.now()): void {
    const current = this.entries.get(key);
    // サーバーから取得した新しい内容を、端末の保存先にあった古い内容で上書きしない。
    if (current?.network && !network) return;
    this.entries.delete(key);
    this.entries.set(key, { value, at: now, network });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** 中身を書き換える。null を返したものは捨てる。 */
  update(fn: (value: T, key: string) => T | null): void {
    for (const [key, entry] of [...this.entries]) {
      const next = fn(entry.value, key);
      if (next === null) this.entries.delete(key);
      else if (next !== entry.value)
        this.entries.set(key, { ...entry, value: next });
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * 同じ内容の取得が進行中なら、新しく頼まずにその結果を待つ。
 * signal で取り消しても、取得そのものは続け (ほかに待っている画面があるため)、
 * 取り消した呼び出し元にだけ AbortError を返す。
 */
export class Inflight {
  private readonly running = new Map<string, Promise<unknown>>();

  run<T>(
    key: string,
    start: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let promise = this.running.get(key) as Promise<T> | undefined;
    if (!promise) {
      promise = start().finally(() => {
        if (this.running.get(key) === promise) this.running.delete(key);
      });
      this.running.set(key, promise);
    }
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  clear(): void {
    this.running.clear();
  }
}

function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}
