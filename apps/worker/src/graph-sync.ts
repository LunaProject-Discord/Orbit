import type { NewMailCandidate } from "@orbit/core";
import {
  type Address,
  attachments,
  type Database,
  mailboxes,
  messageMailboxes,
  messages,
} from "@orbit/db";
import { and, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { recordChanges } from "./changes.js";
import {
  type GraphClient,
  GraphError,
  type GraphPage,
} from "./graph-client.js";
import {
  ATTACHMENT_SELECT,
  type GraphAttachment,
  type GraphMessage,
  MESSAGE_SELECT,
  toAttachmentInfos,
  toBody,
  toMessageValues,
  wellKnownFolders,
} from "./graph-parse.js";
import {
  applyMailboxList,
  dropStalePending,
  removePlacements,
  type SyncAccount,
} from "./mailbox-store.js";
import { listInfoFromGraph } from "./message-headers.js";
import { type AttachmentInfo, clean, makeSnippet } from "./message-parse.js";
import { announceNewMail } from "./new-mail.js";
import { loadPendingGuard } from "./outbox.js";

const BODY_BATCH = 20;
/** 本文を同時に取得する数。Outlook の制限 (1 メールボックスあたり同時 4 件) より少なくする。 */
const BODY_CONCURRENCY = 3;
const HEADER_BATCH = 20;

type GraphFolder = {
  id: string;
  displayName?: string | null;
  parentFolderId?: string | null;
  childFolderCount?: number | null;
};

const FOLDER_QUERY =
  "$select=id,displayName,parentFolderId,childFolderCount&$top=100";

/** フォルダを、サブフォルダも含めてすべて取得する。 */
export async function listGraphFolders(
  client: GraphClient,
  signal?: AbortSignal,
): Promise<GraphFolder[]> {
  const folders: GraphFolder[] = [];
  const queue = [`/me/mailFolders?${FOLDER_QUERY}`];
  for (let url = queue.shift(); url; url = queue.shift()) {
    let next: string | undefined = url;
    while (next) {
      const page: GraphPage<GraphFolder> = await client.get(next, signal);
      for (const folder of page.value) {
        folders.push(folder);
        if ((folder.childFolderCount ?? 0) > 0) {
          queue.push(
            `/me/mailFolders/${encodeURIComponent(folder.id)}/childFolders?${FOLDER_QUERY}`,
          );
        }
      }
      next = page["@odata.nextLink"];
    }
  }
  return folders;
}

/**
 * フォルダ一覧 (サブフォルダを含む) を DB に反映する。path には Graph のフォルダ ID を
 * 入れる (フォルダの ID は名前を変えても変わらない)。
 */
export async function syncGraphFolders(
  db: Database,
  client: GraphClient,
  account: SyncAccount,
  signal?: AbortSignal,
) {
  const folders = await listGraphFolders(client, signal);

  // 受信トレイなどの役割は、既定フォルダ名で引いた ID と突き合わせて決める。
  const specialUse = new Map<string, (typeof wellKnownFolders)[number][1]>();
  for (const [name, use] of wellKnownFolders) {
    try {
      const folder = await client.get<GraphFolder>(
        `/me/mailFolders/${name}?$select=id`,
        signal,
      );
      specialUse.set(folder.id, use);
    } catch (error) {
      // アーカイブなど、アカウントによっては存在しないフォルダがある。
      if (!(error instanceof GraphError && error.notFound)) throw error;
    }
  }

  const ids = new Set(folders.map((folder) => folder.id));
  await applyMailboxList(
    db,
    account,
    folders.map((folder) => ({
      path: folder.id,
      name: clean(folder.displayName),
      delimiter: null,
      specialUse: specialUse.get(folder.id) ?? null,
      // 最上位のフォルダの親 (メールボックスの根) は一覧に無いので、親なしになる。
      parentPath:
        folder.parentFolderId && ids.has(folder.parentFolderId)
          ? folder.parentFolderId
          : null,
    })),
  );
}

/** 差分取得 1 ページ分を DB に反映する。 */
async function applyPage(
  db: Database,
  account: SyncAccount,
  mailboxId: string,
  items: GraphMessage[],
  /** 新しく取り込んだメールを、新着として端末へ通知する。 */
  announce: boolean,
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
    const arrived: NewMailCandidate[] = [];
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
      if (!messageId && values.messageIdHeader) {
        // このアプリで移動したメールは、移動先に「移動中」の所在が先にある。Graph では
        // 移動するとメッセージの ID が変わるので、Message-ID で同じメールを探して結び付ける。
        const [pending] = await tx
          .select({ messageId: messageMailboxes.messageId })
          .from(messageMailboxes)
          .innerJoin(messages, eq(messages.id, messageMailboxes.messageId))
          .where(
            and(
              eq(messageMailboxes.mailboxId, mailboxId),
              isNotNull(messageMailboxes.pendingSince),
              eq(messages.accountId, account.id),
              eq(messages.messageIdHeader, values.messageIdHeader),
            ),
          )
          .limit(1);
        if (pending) {
          messageId = pending.messageId;
          await tx
            .update(messages)
            .set({ providerMessageId: item.id })
            .where(eq(messages.id, messageId));
        }
      }
      if (messageId) {
        if (Object.keys(values).length > 0) {
          await tx
            .update(messages)
            .set(values)
            .where(eq(messages.id, messageId));
        }
      } else {
        const receivedAt = values.receivedAt ?? values.sentAt ?? new Date();
        const [row] = await tx
          .insert(messages)
          .values({
            ...values,
            accountId: account.id,
            providerMessageId: item.id,
            threadKey: values.threadKey ?? item.id,
            receivedAt,
          })
          .onConflictDoNothing({
            target: [messages.accountId, messages.providerMessageId],
          })
          .returning({ id: messages.id });
        // 別のワーカー (再起動の入れ替わりなど) が先に取り込んでいた。次の差分で追いつく。
        if (!row) continue;
        messageId = row.id;
        added++;
        if (announce && !values.draft) {
          arrived.push({
            id: row.id,
            from: values.from ?? [],
            subject: values.subject ?? "",
            // Graph は一覧と一緒に本文の冒頭 (bodyPreview) を返す。
            preview: values.snippet ?? "",
            seen: values.seen ?? false,
            receivedAt,
          });
        }
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
        // 移動中として先に置いた所在なら、確定させる。
        .onConflictDoUpdate({
          target: [messageMailboxes.mailboxId, messageMailboxes.messageId],
          set: { pendingSince: null },
          setWhere: isNotNull(messageMailboxes.pendingSince),
        });
      changed.push(messageId);
    }
    await recordChanges(tx, account.userId, "message", "upsert", changed);
    await announceNewMail(tx, account, arrived);
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
  mailbox: {
    id: string;
    path: string;
    syncState: string | null;
    specialUse?: string | null;
  },
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
    const result = await applyPage(
      db,
      account,
      mailbox.id,
      page.value,
      // 受信トレイの差分で届いたメールだけを通知する (初回や取り直しの全件は通知しない)。
      !full && mailbox.specialUse === "inbox",
    );
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
        .where(
          and(
            eq(messageMailboxes.mailboxId, mailbox.id),
            // 移動中として置いた所在は、まだサーバーに無くてよい (片付けは別に行う)。
            isNull(messageMailboxes.pendingSince),
          ),
        );
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
  // 移動中として置いたまま結び付かなかった所在を片付ける。
  await dropStalePending(db, account, mailbox.id);
  return { added, removed };
}

/**
 * メッセージの添付ファイルの一覧 (実体は含めない)。
 * 項目を絞った要求を受け付けてもらえなかった場合は、絞らずに取り直す。
 */
export async function listGraphAttachments(
  client: GraphClient,
  providerMessageId: string,
  signal?: AbortSignal,
): Promise<AttachmentInfo[]> {
  const base = `/me/messages/${encodeURIComponent(providerMessageId)}/attachments`;
  const items: GraphAttachment[] = [];
  const readAll = async (first: string) => {
    items.length = 0;
    let next: string | undefined = first;
    while (next) {
      const page: GraphPage<GraphAttachment> = await client.get(next, signal);
      items.push(...page.value);
      next = page["@odata.nextLink"];
    }
  };
  try {
    await readAll(`${base}?$select=${ATTACHMENT_SELECT}`);
  } catch (error) {
    if (!(error instanceof GraphError && error.status === 400)) throw error;
    await readAll(base);
  }
  return toAttachmentInfos(items);
}

/** 本文を取得するメッセージ。 */
export type GraphBodyTarget = {
  messageId: string;
  /** 差出人 (認証結果と合わせて、なりすましの疑いを調べる)。 */
  from: Address[];
  providerMessageId: string | null;
  snippet: string;
  hasAttachments: boolean;
};

/**
 * メッセージ 1 通の本文 (と添付ファイルの一覧) を取得して保存する。
 * 変更の通知 (recordChanges) は呼び出し側で行う。
 */
export async function fetchGraphBody(
  db: Database,
  client: GraphClient,
  row: GraphBodyTarget,
  signal?: AbortSignal,
) {
  let body: GraphMessage["body"] = null;
  let files: AttachmentInfo[] | null = null;
  let headers: GraphMessage["internetMessageHeaders"] = null;
  if (row.providerMessageId) {
    try {
      const message = await client.get<GraphMessage>(
        `/me/messages/${encodeURIComponent(row.providerMessageId)}?$select=body,internetMessageHeaders`,
        signal,
      );
      body = message.body;
      headers = message.internetMessageHeaders;
      // 本文に埋め込まれた画像 (cid:) だけのメールは hasAttachments が false になる。
      if (row.hasAttachments || /\bcid:/i.test(message.body?.content ?? "")) {
        files = await listGraphAttachments(
          client,
          row.providerMessageId,
          signal,
        );
      }
    } catch (error) {
      // サーバーから消えていた場合は空のまま取得済みにする (次の差分でメッセージごと消える)。
      if (!(error instanceof GraphError && error.notFound)) throw error;
    }
  }
  const { bodyText, bodyHtml } = toBody(body);
  await db.transaction(async (tx) => {
    if (files) {
      await tx
        .delete(attachments)
        .where(eq(attachments.messageId, row.messageId));
      if (files.length > 0) {
        await tx
          .insert(attachments)
          .values(files.map((file) => ({ messageId: row.messageId, ...file })));
      }
    }
    await tx
      .update(messages)
      .set({
        bodyText,
        bodyHtml,
        // 一覧の取得で受け取った冒頭 (bodyPreview) があれば、それを使い続ける。
        snippet: row.snippet || makeSnippet(bodyText, bodyHtml),
        bodyFetchedAt: new Date(),
        // メーリングリストの情報は、本文と同じ取得で受け取る。
        ...listInfoFromGraph(headers, row.from),
        headersFetchedAt: new Date(),
      })
      .where(eq(messages.id, row.messageId));
  });
}

/**
 * 本文をまだ取得していないメッセージを、フォルダに関係なく新しい順に 1 回分だけ取得する。
 * preferMailboxId (利用者が開いているフォルダ) に未取得のものがあれば、そちらを先に取得する。
 * 取得対象が残っていれば true を返す (呼び出し側が続けて呼ぶ)。
 */
export async function fetchGraphBodies(
  db: Database,
  client: GraphClient,
  account: SyncAccount,
  signal?: AbortSignal,
  preferMailboxId?: string | null,
): Promise<boolean> {
  const columns = {
    messageId: messages.id,
    providerMessageId: messages.providerMessageId,
    from: messages.from,
    snippet: messages.snippet,
    hasAttachments: messages.hasAttachments,
  };
  let pending = preferMailboxId
    ? await db
        .select(columns)
        .from(messages)
        .innerJoin(
          messageMailboxes,
          eq(messageMailboxes.messageId, messages.id),
        )
        .where(
          and(
            eq(messageMailboxes.mailboxId, preferMailboxId),
            eq(messages.accountId, account.id),
            isNull(messages.bodyFetchedAt),
          ),
        )
        .orderBy(desc(messages.receivedAt))
        .limit(BODY_BATCH)
    : [];
  // 開いているフォルダの分が終わっても、他のフォルダの分が残っているかもしれない。
  const preferred = pending.length > 0;
  if (!preferred) {
    pending = await db
      .select(columns)
      .from(messages)
      .where(
        and(eq(messages.accountId, account.id), isNull(messages.bodyFetchedAt)),
      )
      .orderBy(desc(messages.receivedAt))
      .limit(BODY_BATCH + 1);
  }
  const batch = pending.slice(0, BODY_BATCH);
  if (batch.length === 0) return false;

  const done: string[] = [];
  for (let i = 0; i < batch.length; i += BODY_CONCURRENCY) {
    await Promise.all(
      batch.slice(i, i + BODY_CONCURRENCY).map(async (row) => {
        await fetchGraphBody(db, client, row, signal);
        done.push(row.messageId);
      }),
    );
  }
  await db.transaction((tx) =>
    recordChanges(tx, account.userId, "message", "upsert", done),
  );
  return preferred || pending.length > BODY_BATCH;
}

/**
 * 代理送信 (sender) とメーリングリストの情報をまだ取り込んでいないメッセージを、
 * 新しい順に 1 回分だけ補う。これらの項目を足す前に本文まで取り込んだメールが対象
 * (本文がまだのメールは、本文の取得のときに一緒に取り込む)。
 * 取得対象が残っていれば true を返す (呼び出し側が続けて呼ぶ)。
 */
export async function fetchGraphHeaders(
  db: Database,
  client: GraphClient,
  account: SyncAccount,
  signal?: AbortSignal,
): Promise<boolean> {
  const pending = await db
    .select({
      messageId: messages.id,
      providerMessageId: messages.providerMessageId,
      from: messages.from,
    })
    .from(messages)
    .where(
      and(
        eq(messages.accountId, account.id),
        isNull(messages.headersFetchedAt),
        isNotNull(messages.bodyFetchedAt),
      ),
    )
    .orderBy(desc(messages.receivedAt))
    .limit(HEADER_BATCH + 1);
  const batch = pending.slice(0, HEADER_BATCH);
  if (batch.length === 0) return false;

  const changed: string[] = [];
  for (let i = 0; i < batch.length; i += BODY_CONCURRENCY) {
    await Promise.all(
      batch.slice(i, i + BODY_CONCURRENCY).map(async (row) => {
        let message: GraphMessage | null = null;
        if (row.providerMessageId) {
          try {
            message = await client.get<GraphMessage>(
              `/me/messages/${encodeURIComponent(row.providerMessageId)}?$select=sender,internetMessageHeaders`,
              signal,
            );
          } catch (error) {
            // サーバーから消えていた場合は、空のまま取り込み済みにする。
            if (!(error instanceof GraphError && error.notFound)) throw error;
          }
        }
        const sender = toMessageValues({
          id: row.providerMessageId ?? "",
          sender: message?.sender ?? null,
        }).sender;
        const list = listInfoFromGraph(
          message?.internetMessageHeaders,
          row.from,
        );
        await db
          .update(messages)
          .set({ sender, ...list, headersFetchedAt: new Date() })
          .where(eq(messages.id, row.messageId));
        // 画面に出る内容が増えたメールだけ、端末へ変更を知らせる。
        const fromAddresses = new Set(
          row.from.map((item) => item.address.toLowerCase()),
        );
        if (
          list.listId !== null ||
          list.listUnsubscribe.length > 0 ||
          list.authResults !== null ||
          list.senderCheck.warnings.length > 0 ||
          sender?.some((item) => !fromAddresses.has(item.address.toLowerCase()))
        ) {
          changed.push(row.messageId);
        }
      }),
    );
  }
  await db.transaction((tx) =>
    recordChanges(tx, account.userId, "message", "upsert", changed),
  );
  return pending.length > HEADER_BATCH;
}
