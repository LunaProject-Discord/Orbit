/**
 * 下書きの保存を受け付けるかどうかの判断。
 * 端末は、自分が元にした revision (まだサーバーに無ければ null) を付けて保存する。
 */
export type DraftSaveDecision =
  /** 新しく作る。 */
  | { action: "create" }
  /** 上書きする。revision は 1 つ進める。 */
  | { action: "update"; revision: number }
  /** 他の端末が先に書き換えていた。今の内容を返して、端末に選ばせる。 */
  | { action: "conflict" }
  /** 他の端末で送信または破棄された。同じ ID では作り直せない。 */
  | { action: "gone" }
  /** 他人の下書きと ID が重なった。存在を教えないよう、見つからない扱いにする。 */
  | { action: "not_found" };

export function decideDraftSave(input: {
  userId: string;
  /** 端末が元にした revision。まだサーバーに保存していなければ null。 */
  baseRevision: number | null;
  /** 同じ ID の下書き。無ければ null。 */
  existing: { userId: string; revision: number } | null;
  /** この ID を idempotencyKey にした送信を、すでに受け付けているか。 */
  alreadySent: boolean;
}): DraftSaveDecision {
  const { existing, baseRevision } = input;
  if (existing && existing.userId !== input.userId) {
    return { action: "not_found" };
  }
  if (!existing) {
    // 送信済みの ID で作り直すと、次に送信しても「再送」とみなされて送られない。
    if (baseRevision !== null || input.alreadySent) return { action: "gone" };
    return { action: "create" };
  }
  // baseRevision が null なのに存在するのは、前回の保存の応答が届かなかった場合など。
  if (baseRevision !== existing.revision) return { action: "conflict" };
  return { action: "update", revision: existing.revision + 1 };
}
