/**
 * 開いているシート (画面の下から出るメニュー・ピッカー・ダイアログ) を、戻る操作で閉じる仕組み。
 * 画面の部品は components/ui/menu-sheet.tsx の useSheetSwipe が、シートを開いている間だけ登録する。
 *
 * - Android アプリ: 戻るボタンは lib/native/app.ts の listenBackButton が受け取り、
 *   開いているシートがあれば、画面を戻さずに一番上のシートだけを閉じる (closeTopSheet)。
 * - ブラウザー: CloseWatcher (Android の Chrome などの戻るボタン・戻るジェスチャー) で閉じる。
 *   履歴には何も積まないので、シートを閉じても画面の URL や履歴は変わらない。
 *   CloseWatcher の無いブラウザーでは、戻る操作はいつもどおり画面を戻す。
 */

type Watcher = {
  onclose: (() => void) | null;
  destroy: () => void;
};
type WatcherConstructor = new () => Watcher;

/** 開いているシートの閉じ方。後に開いたものほど後ろ。 */
const stack: { close: () => void }[] = [];

/**
 * シートを開いたときに呼ぶ。戻り値の関数を、シートを閉じたときに呼ぶ。
 * useWatcher が true なら、ブラウザーの戻る操作 (CloseWatcher) でも閉じられるようにする。
 */
export function registerSheetBack(
  close: () => void,
  useWatcher = true,
): () => void {
  const entry = { close };
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
export function closeTopSheet(): boolean {
  const top = stack.at(-1);
  if (!top) return false;
  top.close();
  return true;
}

/** 開いているシートの数 (テスト用)。 */
export function openSheetCount(): number {
  return stack.length;
}
