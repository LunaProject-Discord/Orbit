import { mailboxes, messages } from "@orbit/db";
import { type SQL, sql } from "drizzle-orm";

/**
 * 会話 (スレッド) の扱い。
 *
 * 同じアカウントで threadKey が同じメッセージを 1 つの会話として扱う。
 * 一覧では、表示中のフォルダにあるメッセージを会話ごとに 1 行にまとめ、
 * その中で最も新しいメッセージを代表として出す。
 * 会話に数えるのは、表示中のフォルダにあるものと、ごみ箱・迷惑メール・下書き以外の
 * フォルダにあるもの (自分の返信が入る送信済みなど)。
 *
 * どの SQL も、外側の問い合わせの messages と mailboxes を参照する。
 */

/** 表示中のフォルダに、同じ会話のもっと新しいメッセージが無い (= 会話の代表である)。 */
export const isThreadHead: SQL = sql`not exists (
  select 1 from messages n
  join message_mailboxes nm on nm.message_id = n.id
  where nm.mailbox_id = ${mailboxes.id}
    and n.account_id = ${messages.accountId}
    and n.thread_key = ${messages.threadKey}
    and (n.received_at, n.id) > (${messages.receivedAt}, ${messages.id})
)`;

/** 会話のうち、表示中のフォルダにあるメッセージをまとめた情報。 */
export type ThreadInMailbox = {
  /** 表示中のフォルダにあるメッセージ (まとめて操作する対象)。 */
  ids: string[];
  /** すべて既読か。 */
  seen: boolean;
  /** どれかにスターが付いているか。 */
  flagged: boolean;
  hasAttachments: boolean;
};

export const threadInMailbox = sql<ThreadInMailbox>`(
  select json_build_object(
    'ids', json_agg(t.id order by t.received_at, t.id),
    'seen', bool_and(t.seen),
    'flagged', bool_or(t.flagged),
    'hasAttachments', bool_or(t.has_attachments)
  )
  from messages t
  join message_mailboxes tm on tm.message_id = t.id
  where tm.mailbox_id = ${mailboxes.id}
    and t.account_id = ${messages.accountId}
    and t.thread_key = ${messages.threadKey}
)`;

/**
 * メッセージ t が、フォルダ mailboxId から見た会話に含まれるか。
 * mailboxId が null なら、ごみ箱・迷惑メール・下書き以外にあるものだけを数える。
 */
export function inConversation(mailboxId: SQL | string | null): SQL {
  return sql`exists (
    select 1 from message_mailboxes tm
    join mailboxes tb on tb.id = tm.mailbox_id
    where tm.message_id = t.id
      and (
        ${mailboxId === null ? sql`false` : sql`tb.id = ${mailboxId}`}
        or tb.special_use is null
        or tb.special_use not in ('trash', 'junk', 'drafts')
      )
  )`;
}

/** 会話に含まれるメッセージの数。 */
export const threadCount = sql<number>`(
  select count(*)::int from messages t
  where t.account_id = ${messages.accountId}
    and t.thread_key = ${messages.threadKey}
    and ${inConversation(sql`${mailboxes.id}`)}
)`;
