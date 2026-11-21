/** サイドバーの下に出す、同期の状態の文言。 */
export function syncStatusLabel(state: {
  online: boolean;
  /** 端末で預かっている、接続後に送るメールの数。 */
  queuedSends: number;
  /** まだサーバーへ送れていない操作 (既読、移動など) の数。 */
  pendingActions: number;
}): string {
  const { online, queuedSends, pendingActions } = state;
  if (!online) {
    if (queuedSends > 0) return `オフライン · 接続後に ${queuedSends} 件を送信`;
    if (pendingActions > 0) {
      return `オフライン · 未反映の操作 ${pendingActions} 件`;
    }
    return "オフライン · 保存済みのメールを表示中";
  }
  if (queuedSends > 0) return `${queuedSends} 件を送信しています…`;
  if (pendingActions > 0) return "変更を反映しています…";
  return "同期済み";
}
