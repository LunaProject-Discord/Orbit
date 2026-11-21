import { type Database, mailboxes, messageMailboxes, messages } from "@mail/db";
import { and, desc, eq, inArray, isNull, ne, notInArray } from "drizzle-orm";
import { recordChanges, type Tx } from "./changes.js";
import {
  type GraphClient,
  GraphError,
  type GraphPage,
} from "./graph-client.js";
import {
  type GraphMessage,
  MESSAGE_SELECT,
  toBody,
  toMessageValues,
  wellKnownFolders,
} from "./graph-parse.js";
import type { SyncAccount } from "./mailbox-sync.js";
import { clean, makeSnippet } from "./message-parse.js";
import { loadPendingGuard } from "./outbox.js";

const BODY_BATCH = 20;
/** 本文を同時に取得する数。Outlook の制限 (1 メールボックスあたり同時 4 件) より少なくする。 */
const BODY_CONCURRENCY = 3;

type GraphFolder = { id: string; displayName?: string | null };

/**
 * フォルダ一覧を DB に反映する。path には Graph のフォルダ ID を入れる
 * (フォルダの ID は名前を変えても変わらない)。
 * 現時点では最上位のフォルダだけを対象にする。
 */
export async function syncGraphFolders(
  db: Database,
  client: GraphClient,
  account: SyncAccount,
) {
  const folders: GraphFolder[] = [];
  let url: string | undefined = "/me/mailFolders?$select=id,displayName";
  while (url) {
    const page: GraphPage<GraphFolder> = await client.get(url);
    folders.push(...page.value);
    url = page["@odata.nextLink"];
  }

  // 受信トレイなどの役割は、既定フォルダ名で引いた ID と突き合わせて決める。
  const specialUse = new Map<string, (typeof wellKnownFolders)[number][1]>();
  for (const [name, use] of wellKnownFolders) {
    try {
      const folder = await client.get<GraphFolder>(
        `/me/mailFolders/${name}?$select=id`,
      );
      specialUse.set(folder.id, use);
    } catch (error) {
      // アーカイブなど、アカウントによっては存在しないフォルダがある。
      if (!(error instanceof GraphError && error.notFound)) throw error;
    }
  }

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: mailboxes.id, path: mailboxes.path })
      .from(mailboxes)
      .where(eq(mailboxes.accountId, account.id));
    const known = new Map(existing.map((row) => [row.path, row.id]));
    const upserted: string[] = [];

    for (const folder of folders) {
      const values = {
        name: clean(folder.displayName),
        specialUse: specialUse.get(folder.id) ?? null,
      };
      const [row] = await tx
        .insert(mailboxes)
        .values({ accountId: account.id, path: folder.id, ...values })
        .onConflictDoUpdate({
          target: [mailboxes.accountId, mailboxes.path],
          set: values,
        })
        .returning({ id: mailboxes.id });
      if (row && !known.has(folder.id)) upserted.push(row.id);
      known.delete(folder.id);
    }

    const removed = [...known.values()];
    if (removed.length > 0) {
      await removePlacements(tx, account, removed, null);
      await tx.delete(mailboxes).where(inArray(mailboxes.id, removed));
    }
    await recordChanges(tx, account.userId, "mailbox", "upsert", upserted);
    await recordChanges(tx, account.userId, "mailbox", "delete", removed);
  });
}

/**
 * フォルダからメッセージの所在を外し、どのフォルダにも無くなったメッセージを消す。
 * messageIds が null ならフォルダ内の全メッセージが対象。
 */
async function removePlacements(
  tx: Tx,
  account: SyncAccount,
  mailboxIds: string[],
  messageIds: string[] | null,
) {
  if (messageIds?.length === 0) return 0;
  const removed = await tx
    .delete(messageMailboxes)
    .where(
      and(
        inArray(messageMailboxes.mailboxId, mailboxIds),
        messageIds
          ? inArray(messageMailboxes.messageId, messageIds)
          : undefined,
      ),
    )
    .returning({ messageId: messageMailboxes.messageId });
  const ids = [...new Set(removed.map((row) => row.messageId))];
  if (ids.length === 0) return 0;
  const deleted = await tx
    .delete(messages)
    .where(
      and(
        inArray(messages.id, ids),
        notInArray(
          messages.id,
          tx
            .select({ id: messageMailboxes.messageId })
            .from(messageMailboxes)
            .where(inArray(messageMailboxes.messageId, ids)),
        ),
      ),
    )
    .returning({ id: messages.id });
  await recordChanges(
    tx,
    account.userId,
    "message",
    "delete",
    deleted.map((row) => row.id),
  );
  return ids.length;
}

/** 差分取得 1 ページ分を DB に反映する。 */
async function applyPage(
  db: Database,
  account: SyncAccount,
  mailboxId: string,
  items: GraphMessage[],
) {
  const removedIds = items
    .filter((item) => item["@removed"])
    .map((item) => item.id);
  // 同じメッセージが 1 ページに複数回出た場合は、後のものを採用する。
  const upserts = [
    ...new Map(
      items.filter((item) => !item["@removed"]).map((item) => [item.id, item]),
    ).values(),
  ];
  if (removedIds.length === 0 && upserts.length === 0) {
    return { added: 0, removed: 0 };
  }

  return db.transaction(async (tx) => {
    // この端末側で受け付けた操作のうち、まだ Graph へ反映していないものの対象。
    const guard = await loadPendingGuard(tx, account.id);
    const known = await tx
      .select({
        id: messages.id,
        providerMessageId: messages.providerMessageId,
      })
      .from(messages)
      .where(
        and(
          eq(messages.accountId, account.id),
          inArray(
            messages.providerMessageId,
            items.map((item) => item.id),
          ),
        ),
      );
    const idOf = new Map(known.map((row) => [row.providerMessageId, row.id]));

    // 削除、または別のフォルダへの移動。移動先を同期していれば、そちらの差分で所在が付く。
    const removed = await removePlacements(
      tx,
      account,
      [mailboxId],
      removedIds.flatMap((id) => idOf.get(id) ?? []),
    );

    const changed: string[] = [];
    let added = 0;
    for (const item of upserts) {
      // 移動・削除中のメッセージは取り込み直さない (反映後の差分で所在が決まる)。
      if (guard.removedProviderIds.has(item.id)) continue;
      const values = toMessageValues(item);
      if (guard.flagProviderIds.has(item.id)) {
        // 既読やスターを変更中。反映し終えるまで、古い状態で上書きしない。
        delete values.seen;
        delete values.flagged;
      }
      let messageId = idOf.get(item.id);
      if (messageId) {
        if (Object.keys(values).length > 0) {
          await tx
            .update(messages)
            .set(values)
            .where(eq(messages.id, messageId));
        }
      } else {
        const [row] = await tx
          .insert(messages)
          .values({
            ...values,
            accountId: account.id,
            providerMessageId: item.id,
            threadKey: values.threadKey ?? item.id,
            receivedAt: values.receivedAt ?? values.sentAt ?? new Date(),
          })
          .onConflictDoNothing({
            target: [messages.accountId, messages.providerMessageId],
          })
          .returning({ id: messages.id });
        // 別のワーカー (再起動の入れ替わりなど) が先に取り込んでいた。次の差分で追いつく。
        if (!row) continue;
        messageId = row.id;
        added++;
      }
      // Graph のメッセージは常に 1 つのフォルダにだけ存在する。
      await tx
        .delete(messageMailboxes)
        .where(
          and(
            eq(messageMailboxes.messageId, messageId),
            ne(messageMailboxes.mailboxId, mailboxId),
          ),
        );
      await tx
        .insert(messageMailboxes)
        .values({ mailboxId, messageId })
        .onConflictDoNothing();
      changed.push(messageId);
    }
    await recordChanges(tx, account.userId, "message", "upsert", changed);
    return { added, removed };
  });
}

/**
 * フォルダ 1 つを差分取得 (delta query) で DB と突き合わせる。
 * 初回は全件を新しい順にたどり、最後に受け取る deltaLink を保存する。
 * 2 回目以降は deltaLink から、前回以降の追加・変更・削除だけを受け取る。
 * https://learn.microsoft.com/graph/delta-query-messages
 */
export async function syncGraphFolder(
  db: Database,
  client: GraphClient,
  account: SyncAccount,
  mailbox: { id: string; path: string; syncState: string | null },
  signal?: AbortSignal,
): Promise<{ added: number; removed: number }> {
  const full = mailbox.syncState === null;
  let url: string | undefined =
    mailbox.syncState ??
    `/me/mailFolders/${encodeURIComponent(mailbox.path)}/messages/delta` +
      `?$select=${MESSAGE_SELECT}&$orderby=${encodeURIComponent("receivedDateTime desc")}`;
  const seen = new Set<string>();
  let added = 0;
  let removed = 0;
  let deltaLink: string | undefined;

  while (url) {
    let page: GraphPage<GraphMessage>;
    try {
      page = await client.get<GraphPage<GraphMessage>>(url, signal);
    } catch (error) {
      if (!full && error instanceof GraphError && error.syncStateInvalid) {
        // 続きが無効になった (長期間の停止など)。保存した状態を捨てて全件を取り直す。
        await db
          .update(mailboxes)
          .set({ syncState: null })
          .where(eq(mailboxes.id, mailbox.id));
        return syncGraphFolder(
          db,
          client,
          account,
          { ...mailbox, syncState: null },
          signal,
        );
      }
      throw error;
    }
    for (const item of page.value) {
      if (!item["@removed"]) seen.add(item.id);
    }
    const result = await applyPage(db, account, mailbox.id, page.value);
    added += result.added;
    removed += result.removed;
    deltaLink = page["@odata.deltaLink"];
    url = page["@odata.nextLink"];
  }
  if (!deltaLink) {
    throw new Error("差分取得の続き (deltaLink) を受け取れませんでした。");
  }

  if (full) {
    // 全件を取り直したときは、サーバーに無かったものを消す
    // (取り直しの間に消されたメッセージは差分に現れないため)。
    removed += await db.transaction(async (tx) => {
      const local = await tx
        .select({
          id: messages.id,
          providerMessageId: messages.providerMessageId,
        })
        .from(messageMailboxes)
        .innerJoin(messages, eq(messages.id, messageMailboxes.messageId))
        .where(eq(messageMailboxes.mailboxId, mailbox.id));
      const stale = local
        .filter(
          (row) => !row.providerMessageId || !seen.has(row.providerMessageId),
        )
        .map((row) => row.id);
      return removePlacements(tx, account, [mailbox.id], stale);
    });
  }

  await db
    .update(mailboxes)
    .set({ syncState: deltaLink, lastSyncedAt: new Date() })
    .where(eq(mailboxes.id, mailbox.id));
  return { added, removed };
}

/**
 * 本文をまだ取得していないメッセージを、新しい順に 1 回分だけ取得する。
 * 取得対象が残っていれば true を返す (呼び出し側が続けて呼ぶ)。
 */
export async function fetchGraphBodies(
  db: Database,
  client: GraphClient,
  account: SyncAccount,
  mailboxId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const pending = await db
    .select({
      messageId: messages.id,
      providerMessageId: messages.providerMessageId,
      snippet: messages.snippet,
    })
    .from(messageMailboxes)
    .innerJoin(messages, eq(messages.id, messageMailboxes.messageId))
    .where(
      and(
        eq(messageMailboxes.mailboxId, mailboxId),
        isNull(messages.bodyFetchedAt),
      ),
    )
    .orderBy(desc(messages.receivedAt))
    .limit(BODY_BATCH + 1);
  const batch = pending.slice(0, BODY_BATCH);
  if (batch.length === 0) return false;

  const done: string[] = [];
  for (let i = 0; i < batch.length; i += BODY_CONCURRENCY) {
    await Promise.all(
      batch.slice(i, i + BODY_CONCURRENCY).map(async (row) => {
        let body: GraphMessage["body"] = null;
        if (row.providerMessageId) {
          try {
            const message = await client.get<GraphMessage>(
              `/me/messages/${encodeURIComponent(row.providerMessageId)}?$select=body`,
              signal,
            );
            body = message.body;
          } catch (error) {
            // サーバーから消えていた場合は空のまま取得済みにする (次の差分でメッセージごと消える)。
            if (!(error instanceof GraphError && error.notFound)) throw error;
          }
        }
        const { bodyText, bodyHtml } = toBody(body);
        await db
          .update(messages)
          .set({
            bodyText,
            bodyHtml,
            // 一覧の取得で受け取った冒頭 (bodyPreview) があれば、それを使い続ける。
            snippet: row.snippet || makeSnippet(bodyText, bodyHtml),
            bodyFetchedAt: new Date(),
          })
          .where(eq(messages.id, row.messageId));
        done.push(row.messageId);
      }),
    );
  }
  await db.transaction((tx) =>
    recordChanges(tx, account.userId, "message", "upsert", done),
  );
  return pending.length > BODY_BATCH;
}
