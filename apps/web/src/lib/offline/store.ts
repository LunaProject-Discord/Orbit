/**
 * 端末内の保存先。オフライン用の仕組み (メールの控え、送信待ち) は、この形だけに頼る。
 *
 * ブラウザー、Tauri、Capacitor の WebView では IndexedDB (IndexedDbStore) を使う。
 * 端末の SQLite などへ置き換えるときは、この LocalStore を実装したものを
 * openOffline に渡せばよい (表ごとに「文字列のキー → JSON にできる値」を持てれば足りる)。
 */

export const TABLES = [
  /** アカウント、フォルダ、下書きの一覧など、1 件ずつの値。 */
  "meta",
  /** 一覧の行。キーは「フォルダの ID | メッセージの ID」。 */
  "rows",
  /** メールの本文つきの内容。キーはメッセージの ID。 */
  "details",
  /** 検索用の本文 (小文字にした文字列)。キーはメッセージの ID。 */
  "texts",
  /** 会話に含まれるメッセージの一覧。キーは「メッセージの ID | フォルダの ID」。 */
  "threads",
  /** 取得済みの添付ファイル。キーは「メッセージの ID | 添付ファイルの ID」。 */
  "attachments",
  /** 接続後に送るメール。キーは送信ごとの ID。 */
  "outbox",
] as const;

export type Table = (typeof TABLES)[number];

export type WriteOp =
  | { type: "put"; table: Table; key: string; value: unknown }
  | { type: "delete"; table: Table; key: string };

export interface LocalStore {
  /** 再読み込みしても内容が残るか。残らない保存先には、送信待ちのメールを預けない。 */
  readonly persistent: boolean;
  get<T>(table: Table, key: string): Promise<T | undefined>;
  /** 表の値をすべて返す。prefix を渡すと、キーがその文字列で始まるものだけを返す。 */
  list<T>(table: Table, prefix?: string): Promise<T[]>;
  /** 表のキーをすべて返す。 */
  keys(table: Table): Promise<string[]>;
  /** まとめて書き込む (途中で失敗したら、どれも書き込まれない)。 */
  write(ops: WriteOp[]): Promise<void>;
  /** すべて消す (ログアウト時)。 */
  clear(): Promise<void>;
  close(): void;
}

/** メモリー上の保存先。IndexedDB が使えない環境とテストで使う。 */
export class MemoryStore implements LocalStore {
  readonly persistent = false;
  private readonly tables = new Map<Table, Map<string, unknown>>();

  private table(name: Table): Map<string, unknown> {
    let table = this.tables.get(name);
    if (!table) {
      table = new Map();
      this.tables.set(name, table);
    }
    return table;
  }

  async get<T>(table: Table, key: string): Promise<T | undefined> {
    return this.table(table).get(key) as T | undefined;
  }

  async list<T>(table: Table, prefix?: string): Promise<T[]> {
    const result: T[] = [];
    for (const [key, value] of this.table(table)) {
      if (prefix === undefined || key.startsWith(prefix)) {
        result.push(value as T);
      }
    }
    return result;
  }

  async keys(table: Table): Promise<string[]> {
    return [...this.table(table).keys()];
  }

  async write(ops: WriteOp[]): Promise<void> {
    for (const op of ops) {
      if (op.type === "put") this.table(op.table).set(op.key, op.value);
      else this.table(op.table).delete(op.key);
    }
  }

  async clear(): Promise<void> {
    this.tables.clear();
  }

  close(): void {}
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** IndexedDB に置く保存先。 */
export class IndexedDbStore implements LocalStore {
  readonly persistent = true;

  private constructor(private readonly db: IDBDatabase) {}

  static open(name: string): Promise<IndexedDbStore> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        for (const table of TABLES) {
          if (!req.result.objectStoreNames.contains(table)) {
            req.result.createObjectStore(table);
          }
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // ほかのタブが消そうとしたら (ログアウト)、こちらは閉じて譲る。
        db.onversionchange = () => db.close();
        resolve(new IndexedDbStore(db));
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("blocked"));
    });
  }

  /** 保存先ごと消す。開いていなくても呼べる。 */
  static delete(name: string): Promise<void> {
    return new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  }

  get<T>(table: Table, key: string): Promise<T | undefined> {
    const store = this.db.transaction(table, "readonly").objectStore(table);
    return request(store.get(key)) as Promise<T | undefined>;
  }

  list<T>(table: Table, prefix?: string): Promise<T[]> {
    const store = this.db.transaction(table, "readonly").objectStore(table);
    const range =
      prefix === undefined
        ? undefined
        : IDBKeyRange.bound(prefix, `${prefix}￿`);
    return request(store.getAll(range)) as Promise<T[]>;
  }

  keys(table: Table): Promise<string[]> {
    const store = this.db.transaction(table, "readonly").objectStore(table);
    return request(store.getAllKeys()) as Promise<string[]>;
  }

  write(ops: WriteOp[]): Promise<void> {
    if (ops.length === 0) return Promise.resolve();
    const tables = [...new Set(ops.map((op) => op.table))];
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(tables, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      for (const op of ops) {
        const store = tx.objectStore(op.table);
        if (op.type === "put") store.put(op.value, op.key);
        else store.delete(op.key);
      }
    });
  }

  clear(): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([...TABLES], "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      for (const table of TABLES) tx.objectStore(table).clear();
    });
  }

  close(): void {
    this.db.close();
  }
}
