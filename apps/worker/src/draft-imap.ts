import type { OutgoingMessage } from "@mail/core";
import type { ImapFlow } from "imapflow";
import {
  DraftRejected,
  type DraftRemote,
  type DraftRemoteRef,
} from "./draft-sync.js";
import { buildMime } from "./mime.js";

/** サーバーに拒否された (NO / BAD) なら true。接続の問題なら false。 */
function isRejected(error: unknown): boolean {
  const status = (error as { responseStatus?: string }).responseStatus;
  return status === "NO" || status === "BAD";
}

async function withMailbox<T>(
  client: ImapFlow,
  path: string,
  run: (uidValidity: bigint) => Promise<T>,
): Promise<T> {
  let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>>;
  try {
    lock = await client.getMailboxLock(path);
  } catch (error) {
    if (!isRejected(error)) throw error;
    throw new DraftRejected(`下書きフォルダを開けませんでした: ${path}`);
  }
  try {
    const mailbox = client.mailbox;
    if (!mailbox) throw new Error(`フォルダ ${path} を選択できませんでした。`);
    return await run(mailbox.uidValidity);
  } finally {
    lock.release();
  }
}

/**
 * IMAP の下書きフォルダへの控えの置き方。IMAP ではメールを書き換えられないので、
 * 新しい内容を追加 (APPEND) してから、前の控えを消す。
 * draftsPath は下書きフォルダのパスを返す (無ければ null)。フォルダのロックを取るので、
 * 呼び出し側は他のフォルダのロックを持っていないこと。
 */
export function imapDraftRemote(
  client: ImapFlow,
  draftsPath: () => Promise<string | null>,
): DraftRemote {
  return {
    async save(message: OutgoingMessage): Promise<DraftRemoteRef | null> {
      const path = await draftsPath();
      if (!path) return null;
      const raw = await buildMime(message, { keepBcc: true });
      let appended: Awaited<ReturnType<ImapFlow["append"]>>;
      try {
        appended = await client.append(
          path,
          raw,
          ["\\Draft", "\\Seen"],
          new Date(message.date),
        );
      } catch (error) {
        if (!isRejected(error)) throw error;
        throw new DraftRejected(
          (error as { responseText?: string }).responseText ??
            "サーバーが保存を受け付けませんでした。",
        );
      }
      if (!appended) {
        throw new DraftRejected("サーバーが保存を受け付けませんでした。");
      }
      if (appended.uid && appended.uidValidity) {
        return {
          messageId: message.messageId,
          mailboxPath: path,
          uid: BigInt(appended.uid),
          uidValidity: BigInt(appended.uidValidity),
          providerId: null,
        };
      }
      // 置いた場所を返さないサーバー (UIDPLUS 非対応) では、Message-ID で探す。
      // 前の控えも同じ Message-ID なので、いちばん新しいものを選ぶ。
      return withMailbox(client, path, async (uidValidity) => {
        const found = await client.search(
          { header: { "message-id": message.messageId } },
          { uid: true },
        );
        const uid = found && found.length > 0 ? Math.max(...found) : null;
        if (uid === null) {
          throw new DraftRejected("保存した下書きが見つかりませんでした。");
        }
        return {
          messageId: message.messageId,
          mailboxPath: path,
          uid: BigInt(uid),
          uidValidity,
          providerId: null,
        };
      });
    },

    async remove(ref: DraftRemoteRef): Promise<void> {
      const { mailboxPath, uid } = ref;
      if (!mailboxPath || uid === null) return;
      await withMailbox(client, mailboxPath, async (uidValidity) => {
        // フォルダが作り直されていたら、同じ UID が別のメールを指しているおそれがある。
        if (ref.uidValidity !== uidValidity) return;
        try {
          // 存在しない UID は、サーバーが単に無視する。
          await client.messageDelete(uid.toString(), { uid: true });
        } catch (error) {
          if (!isRejected(error)) throw error;
          throw new DraftRejected("サーバーが削除を受け付けませんでした。");
        }
      });
    },
  };
}
