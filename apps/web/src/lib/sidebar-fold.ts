const FOLDED_KEY = "mail.sidebar-folded.v1";

/** 左のサイドバーを折りたたんでいるか。端末ごとに覚えておく。 */
export function loadSidebarFolded(): boolean {
  try {
    return window.localStorage.getItem(FOLDED_KEY) === "on";
  } catch {
    return false;
  }
}

export function storeSidebarFolded(folded: boolean): void {
  try {
    if (folded) window.localStorage.setItem(FOLDED_KEY, "on");
    else window.localStorage.removeItem(FOLDED_KEY);
  } catch {
    // 保存できない環境では、次に開いたときに広げた状態へ戻るだけ。
  }
}

/** カーソルを乗せてから一時的に広げるまでと、離れてから戻すまでの時間 (ミリ秒)。 */
export const PEEK_OPEN_DELAY = 80;
export const PEEK_CLOSE_DELAY = 300;

/** 折りたたみを切り替えるキーの表示。 */
export const SIDEBAR_FOLD_KEY_LABEL = "F9";
