/**
 * Gmail のように、フォルダが実際には「ラベル」になっているサービスでの移動の扱い。
 *
 * Gmail では 1 通のメールが、付いているラベルの数だけ IMAP のフォルダに現れ、
 * 「すべてのメール」には (ごみ箱と迷惑メール以外の) 全部のメールが入っている。
 * ふつうの IMAP サーバーと同じように全部の所在から移動すると、関係のないラベルまで
 * 外れてしまうので、移動元にする所在を選ぶ。
 */

export type MailboxRole =
  | "inbox"
  | "flagged"
  | "drafts"
  | "sent"
  | "archive"
  | "all"
  | "junk"
  | "trash"
  | null;

export type LabelMovePlan<T> = {
  /** サーバーで移動元にする所在。 */
  sources: T[];
  /**
   * 手元の DB からも移動元を外すか。「すべてのメール」から移動する場合は
   * ラベルが付くだけでメールは残るので、外さない。
   */
  removeLocally: boolean;
};

/**
 * ラベル方式のアカウントで、1 通のメールをどの所在から移動するかを決める。
 * - ごみ箱・迷惑メールへ: どこから移してもすべてのラベルから消えるので、全部を対象にする。
 * - アーカイブ (「すべてのメール」へ): 受信トレイから外すだけ。ほかのラベルは残す。
 * - 受信トレイやラベルへ: 受信トレイにあればそこから、ごみ箱・迷惑メールにあればそこから、
 *   それ以外は付いているラベルから移す。どれにも無ければ「すべてのメール」から移す
 *   (ラベルが付くだけになる)。
 */
export function planLabelMove<T extends { role: MailboxRole }>(
  placements: T[],
  destination: MailboxRole,
): LabelMovePlan<T> {
  if (destination === "trash" || destination === "junk") {
    return { sources: placements, removeLocally: true };
  }
  const inbox = placements.filter((item) => item.role === "inbox");
  if (destination === "all") {
    return { sources: inbox, removeLocally: true };
  }
  if (inbox.length > 0) return { sources: inbox, removeLocally: true };
  const discarded = placements.filter(
    (item) => item.role === "trash" || item.role === "junk",
  );
  if (discarded.length > 0) return { sources: discarded, removeLocally: true };
  const labels = placements.filter((item) => item.role === null);
  if (labels.length > 0) return { sources: labels, removeLocally: true };
  return {
    sources: placements.filter((item) => item.role === "all").slice(0, 1),
    removeLocally: false,
  };
}
