import { readFile } from "node:fs/promises";
import {
  attachmentPath,
  attachmentsDir,
  type MailAddress,
  type OutgoingMessage,
} from "@mail/core";
import {
  DraftRejected,
  type DraftRemote,
  type DraftRemoteRef,
} from "./draft-sync.js";
import {
  type GraphClient,
  GraphError,
  type GraphPage,
} from "./graph-client.js";

type GraphAttachment = { id: string; name?: string | null; size?: number };

const recipients = (list: MailAddress[]) =>
  list.map((entry) => ({
    emailAddress: {
      address: entry.address,
      ...(entry.name ? { name: entry.name } : {}),
    },
  }));

function bodyOf(message: OutgoingMessage) {
  return {
    subject: message.subject,
    body: message.html
      ? { contentType: "html", content: message.html }
      : { contentType: "text", content: message.text },
    toRecipients: recipients(message.to),
    ccRecipients: recipients(message.cc),
    bccRecipients: recipients(message.bcc),
  };
}

/** 権限が無いなど、やり直しても通らない失敗か。制限 (429) と障害 (5xx) はやり直す。 */
function isRejected(error: unknown): error is GraphError {
  return (
    error instanceof GraphError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 401 &&
    error.status !== 429
  );
}

/**
 * Microsoft Graph の下書きフォルダへの控えの置き方。
 * 新しい下書きは POST /me/messages で作り (下書きフォルダに入る)、以後は同じメッセージを
 * PATCH で書き換える。添付ファイルは、名前と大きさを比べて足りないものを足し、余分なものを消す。
 * https://learn.microsoft.com/graph/api/user-post-messages
 * https://learn.microsoft.com/graph/api/message-update
 */
export function graphDraftRemote(
  client: GraphClient,
  signal?: AbortSignal,
): DraftRemote {
  const pathOf = (id: string) => `/me/messages/${encodeURIComponent(id)}`;

  async function syncAttachments(id: string, message: OutgoingMessage) {
    const wanted = message.attachments ?? [];
    const existing: GraphAttachment[] = [];
    let next: string | undefined =
      `${pathOf(id)}/attachments?$select=id,name,size`;
    while (next) {
      const page: GraphPage<GraphAttachment> = await client.get(next, signal);
      existing.push(...page.value);
      next = page["@odata.nextLink"];
    }
    const keyOf = (name: string, size: number) => `${size}\n${name}`;
    const remaining = new Map<string, number>();
    for (const file of wanted) {
      const key = keyOf(file.filename, file.size);
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    for (const file of existing) {
      const key = keyOf(file.name ?? "", file.size ?? -1);
      const count = remaining.get(key) ?? 0;
      if (count > 0) {
        remaining.set(key, count - 1);
        continue;
      }
      await client.request(
        "DELETE",
        `${pathOf(id)}/attachments/${encodeURIComponent(file.id)}`,
        undefined,
        signal,
      );
    }
    const dir = attachmentsDir();
    for (const file of wanted) {
      const key = keyOf(file.filename, file.size);
      const count = remaining.get(key) ?? 0;
      if (count === 0) continue;
      remaining.set(key, count - 1);
      const content = await readFile(attachmentPath(dir, file.storageKey));
      await client.request(
        "POST",
        `${pathOf(id)}/attachments`,
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: file.filename,
          contentType: file.contentType,
          contentBytes: content.toString("base64"),
        },
        signal,
      );
    }
  }

  return {
    async save(message, previous): Promise<DraftRemoteRef | null> {
      try {
        let id = previous?.providerId ?? null;
        let messageId = previous?.messageId ?? null;
        if (id) {
          try {
            await client.request("PATCH", pathOf(id), bodyOf(message), signal);
          } catch (error) {
            // ほかのメールソフトで消されていた、または送信されていた。作り直す。
            if (!(error instanceof GraphError && error.notFound)) throw error;
            id = null;
          }
        }
        if (!id) {
          const created = await client.request<{
            id: string;
            internetMessageId?: string | null;
          }>("POST", "/me/messages", bodyOf(message), signal);
          id = created.id;
          messageId = created.internetMessageId ?? null;
        }
        await syncAttachments(id, message);
        return {
          messageId,
          mailboxPath: null,
          uid: null,
          uidValidity: null,
          providerId: id,
        };
      } catch (error) {
        if (!isRejected(error)) throw error;
        throw new DraftRejected(error.message);
      }
    },

    async remove(ref): Promise<void> {
      if (!ref.providerId) return;
      try {
        await client.request(
          "DELETE",
          pathOf(ref.providerId),
          undefined,
          signal,
        );
      } catch (error) {
        if (error instanceof GraphError && error.notFound) return;
        if (!isRejected(error)) throw error;
        throw new DraftRejected(error.message);
      }
    },
  };
}
