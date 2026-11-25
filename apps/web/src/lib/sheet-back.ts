/**
 * 開いているシート (画面の下から出るメニュー・ピッカー・ダイアログ) を、戻る操作で閉じる仕組み。
 * 画面の部品は components/ui/menu-sheet.tsx の useSheetSwipe が、シートを開いている間だけ登録する。
 *
 * - Android アプリ: 戻るボタンは lib/native/app.ts の listenBackButton が受け取り、
 *   開いているシートがあれば、画面を戻さずに一番上のシートだけを閉じる (closeTopSheet)。
 * - ブラウザー: CloseWatcher (Android の Chrome などの戻るボタン・戻るジェスチャー) で閉じる。
 *   履歴には何も積まないので、シートを閉じても画面の URL や履歴は変わらない。
 *   CloseWatcher の無いブラウザーでは、戻る操作はいつもどおり画面を戻す。
 *
 * 登録が残ったままだと、戻るボタンがシートを閉じようとするだけで画面が戻らなくなる。
 * そこで、もう開いていないシート (isOpen が false) や、閉じるよう頼んでも閉じなかったシートは
 * 飛ばして、画面を戻す。
 */

type Watcher = {
  onclose: (() => void) | null;
  destroy: () => void;
};
type WatcherConstructor = new () => Watcher;

type Entry = {
  close: () => void;
  isOpen?: () => boolean;
  /** 戻る操作で閉じるよう頼んだ時刻。閉じれば登録ごと消える。 */
  requestedAt?: number;
};

/** 開いているシートの閉じ方。後に開いたものほど後ろ。 */
const stack: Entry[] = [];

/**
 * 閉じるよう頼んでから、この時間 (ミリ秒) が過ぎても登録が残っていれば、閉じられないものとして扱う。
 * シートが閉じる動き (0.2 秒ほど) より長くとる。
 */
export const STUCK_SHEET_MS = 1000;

/**
 * シートを開いたときに呼ぶ。戻り値の関数を、シートを閉じたときに呼ぶ。
 * useWatcher が true なら、ブラウザーの戻る操作 (CloseWatcher) でも閉じられるようにする。
 * isOpen を渡すと、戻る操作のときにまだ開いているかを確かめる (開いていなければ飛ばす)。
 */
export function registerSheetBack(
  close: () => void,
  useWatcher = true,
  isOpen?: () => boolean,
): () => void {
  const entry: Entry = { close, isOpen };
  stack.push(entry);
  let watcher: Watcher | null = null;
  const Constructor = useWatcher
    ? (globalThis as { CloseWatcher?: WatcherConstructor }).CloseWatcher
    : undefined;
  if (Constructor) {
    try {
      watcher = new Constructor();
      watcher.onclose = () => {
        watcher = null;
        entry.close();
      };
    } catch {
      // 作れなければ、ブラウザーの戻る操作はいつもどおり画面を戻す。
      watcher = null;
    }
  }
  return () => {
    const index = stack.indexOf(entry);
    if (index >= 0) stack.splice(index, 1);
    const current = watcher;
    watcher = null;
    current?.destroy();
  };
}

/** 一番上のシートを閉じる。閉じたら true (戻る操作はそこで終わり)、開いていなければ false。 */
export function closeTopSheet(now = Date.now()): boolean {
  for (let top = stack.at(-1); top; top = stack.at(-1)) {
    const stale =
      (top.isOpen && !top.isOpen()) ||
      (top.requestedAt !== undefined &&
        now - top.requestedAt >= STUCK_SHEET_MS);
    if (stale) {
      // 閉じ忘れた登録で、戻る操作を止めない。
      stack.pop();
      continue;
    }
    top.requestedAt ??= now;
    top.close();
    return true;
  }
  return false;
}

/** 開いているシートの数 (テスト用)。 */
export function openSheetCount(): number {
  return stack.length;
}
