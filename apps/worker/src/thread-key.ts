import { messages } from "@mail/db";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { Tx } from "./changes.js";

/**
 * 取り込むメッセージのスレッドのキーを、すでに取り込んだメッセージと突き合わせて決める。
 *
 * ヘッダーだけから求めたキー (References の先頭) は、References を付けずに
 * In-Reply-To だけで返信するメールでは会話の起点を指さない。そこで、
 * 返信先 (References / In-Reply-To) のメッセージを取り込み済みなら、そのキーを引き継ぐ。
 * 逆に、このメッセージを起点として待っていた返信があれば、同じキーに付け替える。
 *
 * 戻り値の moved は、キーを付け替えた既存のメッセージの ID (変更履歴に載せる)。
 */
export async function resolveThreadKey(
  tx: Tx,
  accountId: string,
  input: {
    /** ヘッダーだけから求めたキー (threadKeyOf の結果)。 */
    computed: string;
    messageId: string | null;
    /** 返信先の Message-ID (References と In-Reply-To)。 */
    parents: string[];
  },
): Promise<{ threadKey: string; moved: string[] }> {
  let threadKey = input.computed;
  const parents = [...new Set(input.parents.filter(Boolean))];
  if (parents.length > 0) {
    const [ancestor] = await tx
      .select({ threadKey: messages.threadKey })
      .from(messages)
      .where(
        and(
          eq(messages.accountId, accountId),
          inArray(messages.messageIdHeader, parents),
        ),
      )
      .orderBy(asc(messages.receivedAt), asc(messages.id))
      .limit(1);
    if (ancestor) threadKey = ancestor.threadKey;
  }

  let moved: string[] = [];
  if (input.messageId && input.messageId !== threadKey) {
    const rows = await tx
      .update(messages)
      .set({ threadKey })
      .where(
        and(
          eq(messages.accountId, accountId),
          eq(messages.threadKey, input.messageId),
          ne(messages.messageIdHeader, input.messageId),
        ),
      )
      .returning({ id: messages.id });
    moved = rows.map((row) => row.id);
  }
  return { threadKey, moved };
}
