import type { MailboxOperation } from "@orbit/core";
import { type Database, mailboxes } from "@orbit/db";
import { and, eq, sql } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import { recordChanges } from "./changes.js";
import { type GraphClient, GraphError } from "./graph-client.js";
import type { SyncAccount } from "./mailbox-store.js";
import type { OutboxResult } from "./outbox.js";

/**
 * フォルダそのものへの操作 (作成、名前の変更、削除) を、メールサーバーへ反映する。
 * DB のフォルダ一覧は、このあとのフォルダ一覧の同期で実際の状態に合わせる。
 */

export function isMailboxOperation(operation: {
  kind: string;
}): operation is MailboxOperation {
  return (
    operation.kind === "mailbox_create" ||
    operation.kind === "mailbox_rename" ||
    operation.kind === "mailbox_delete"
  );
}

/** サーバーに拒否された (NO / BAD) なら、その理由。接続の問題なら null。 */
function rejection(error: unknown): string | null {
  const err = error as { responseStatus?: string; responseText?: string };
  if (err.responseStatus !== "NO" && err.responseStatus !== "BAD") return null;
  return err.responseText || "サーバーが操作を受け付けませんでした。";
}

export async function applyImapMailboxOperation(
  client: ImapFlow,
  operation: MailboxOperation,
): Promise<OutboxResult> {
  try {
    switch (operation.kind) {
      case "mailbox_create":
        // すでに同じフォルダがあれば、ImapFlow は何もせずに成功を返す。
        await client.mailboxCreate(operation.payload.path);
        break;
      case "mailbox_rename":
        await closeIfSelected(client, operation.payload.path);
        await client.mailboxRename(
          operation.payload.path,
          operation.payload.newPath,
        );
        break;
      case "mailbox_delete":
        await closeIfSelected(client, operation.payload.path);
        await client.mailboxDelete(operation.payload.path);
        break;
    }
    return { ok: true };
  } catch (error) {
    const reason = rejection(error);
    if (reason === null) throw error;
    return { ok: false, reason };
  }
}

/** 選択中のフォルダは名前の変更や削除ができないサーバーがあるので、先に閉じる。 */
async function closeIfSelected(client: ImapFlow, path: string) {
  if (client.mailbox !== false && client.mailbox.path === path) {
    await client.mailboxClose();
  }
}

export async function applyGraphMailboxOperation(
  client: GraphClient,
  operation: MailboxOperation,
  signal?: AbortSignal,
): Promise<OutboxResult> {
  const folder = (id: string) => `/me/mailFolders/${encodeURIComponent(id)}`;
  try {
    switch (operation.kind) {
      case "mailbox_create": {
        const { parentPath, name } = operation.payload;
        await client.request(
          "POST",
          parentPath ? `${folder(parentPath)}/childFolders` : "/me/mailFolders",
          { displayName: name },
          signal,
        );
        break;
      }
      case "mailbox_rename":
        await client.request(
          "PATCH",
          folder(operation.payload.path),
          { displayName: operation.payload.name },
          signal,
        );
        break;
      case "mailbox_delete":
        try {
          await client.request(
            "DELETE",
            folder(operation.payload.path),
            undefined,
            signal,
          );
        } catch (error) {
          // 他の端末で先に消されていた場合は、することが無い。
          if (!(error instanceof GraphError && error.notFound)) throw error;
        }
        break;
    }
    return { ok: true };
  } catch (error) {
    // 制限 (429) と障害 (5xx) は、時間を置けば通るのでやり直す。
    if (
      error instanceof GraphError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 429 &&
      error.status !== 401
    ) {
      return { ok: false, reason: error.message };
    }
    throw error;
  }
}

/**
 * IMAP で名前を変えたフォルダと、その中のフォルダのパスを DB でも付け替える。
 * こうしておくと、次のフォルダ一覧の同期で「消えたフォルダと新しいフォルダ」として
 * 扱われず、取り込み済みのメールと並び順がそのまま残る。
 */
export async function renameMailboxPaths(
  db: Database,
  account: SyncAccount,
  payload: {
    mailboxId: string;
    path: string;
    newPath: string;
    name: string;
    delimiter: string | null;
  },
) {
  await db.transaction(async (tx) => {
    const changed = await tx
      .update(mailboxes)
      .set({ path: payload.newPath, name: payload.name })
      .where(
        and(
          eq(mailboxes.accountId, account.id),
          eq(mailboxes.id, payload.mailboxId),
          eq(mailboxes.path, payload.path),
        ),
      )
      .returning({ id: mailboxes.id });
    const ids = changed.map((row) => row.id);
    if (payload.delimiter) {
      const prefix = payload.path + payload.delimiter;
      const children = await tx
        .update(mailboxes)
        .set({
          path: sql`${payload.newPath + payload.delimiter} || substr(${mailboxes.path}, ${prefix.length + 1})`,
        })
        .where(
          and(
            eq(mailboxes.accountId, account.id),
            sql`left(${mailboxes.path}, ${prefix.length}) = ${prefix}`,
          ),
        )
        .returning({ id: mailboxes.id });
      ids.push(...children.map((row) => row.id));
    }
    await recordChanges(tx, account.userId, "mailbox", "upsert", ids);
  });
}
