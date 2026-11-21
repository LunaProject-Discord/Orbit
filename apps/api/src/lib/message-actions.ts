import {
  accountLockKey,
  CHANNEL_CHANGES,
  CHANNEL_OUTBOX,
  type ChangeNotification,
  type OutboxOperation,
  type OutboxTarget,
} from "@mail/core";
import {
  changes,
  type Database,
  mailAccounts,
  mailboxes,
  messageMailboxes,
  messages,
  outbox,
} from "@mail/db";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { type MailboxRole, planLabelMove } from "./label-store.js";

const common = {
  /** 端末が操作ごとに付ける一意な ID。同じ値で再送されても二重に実行しない。 */
  idempotencyKey: z.uuid(),
  messageIds: z.array(z.uuid()).min(1).max(100),
};

export const messageActionBody = z.discriminatedUnion("action", [
  z.object({
    ...common,
    action: z.literal("set_flags"),
    seen: z.boolean().optional(),
    flagged: z.boolean().optional(),
  }),
  z.object({
    ...common,
    action: z.literal("move"),
    /** 移動先のフォルダ。destination とどちらか一方を指定する。 */
    mailboxId: z.uuid().optional(),
    /** 移動先を役割で指定する (アカウントごとに該当するフォルダへ移す)。 */
    destination: z.enum(["inbox", "archive", "trash", "junk"]).optional(),
  }),
  z.object({
    ...common,
    /** 完全に削除する。ごみ箱へ移すには move で destination: "trash" を使う。 */
    action: z.literal("delete"),
  }),
]);

export type MessageAction = z.infer<typeof messageActionBody>;

export type MessageActionResult =
  | { ok: true; messageIds: string[] }
  | { ok: false; error: "invalid_action" | "mailbox_not_found" };

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

type Placement = OutboxTarget & {
  accountId: string;
  protocol: "imap" | "graph";
  /** フォルダの役割 (受信トレイ、ごみ箱など)。 */
  role: MailboxRole;
};

/** 操作の対象。Graph のメッセージはフォルダに依らず ID で指すので、1 通につき 1 件にまとめる。 */
function toTargets(placements: Placement[]): OutboxTarget[] {
  const seen = new Set<string>();
  const targets: OutboxTarget[] = [];
  for (const { accountId: _, role: __, protocol, ...target } of placements) {
    if (protocol === "graph") {
      if (seen.has(target.messageId)) continue;
      seen.add(target.messageId);
    }
    targets.push(target);
  }
  return targets;
}

/**
 * メッセージへの操作 (既読、スター、移動、削除) を受け付ける。
 * DB を先に書き換えて変更履歴に載せ (どの端末にもすぐ反映される)、
 * プロバイダへの反映は送信待ちキューに積んで同期ワーカーに任せる。
 */
export async function enqueueMessageAction(
  db: Database,
  userId: string,
  action: MessageAction,
): Promise<MessageActionResult> {
  if (
    action.action === "set_flags" &&
    action.seen === undefined &&
    action.flagged === undefined
  ) {
    return { ok: false, error: "invalid_action" };
  }
  if (
    action.action === "move" &&
    (action.mailboxId === undefined) === (action.destination === undefined)
  ) {
    return { ok: false, error: "invalid_action" };
  }

  return db.transaction(async (tx): Promise<MessageActionResult> => {
    // 対象のアカウントを確かめる (他人のメッセージは見つからない扱いにする)。
    const owned = await tx
      .selectDistinct({ accountId: messages.accountId })
      .from(messages)
      .innerJoin(mailAccounts, eq(mailAccounts.id, messages.accountId))
      .where(
        and(
          inArray(messages.id, action.messageIds),
          eq(mailAccounts.userId, userId),
        ),
      );
    const accountIds = owned.map((row) => row.accountId).sort();
    // 同期ワーカーの書き込みと順番に実行する。デッドロックしないよう ID 順に取る。
    for (const accountId of accountIds) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${accountLockKey(accountId)}, 0))`,
      );
    }
    if (accountIds.length === 0) return { ok: true, messageIds: [] };

    const placements: Placement[] = (
      await tx
        .select({
          messageId: messages.id,
          accountId: messages.accountId,
          protocol: mailAccounts.protocol,
          providerMessageId: messages.providerMessageId,
          mailboxId: mailboxes.id,
          mailboxPath: mailboxes.path,
          uid: messageMailboxes.uid,
          uidValidity: mailboxes.uidValidity,
          role: mailboxes.specialUse,
        })
        .from(messages)
        .innerJoin(mailAccounts, eq(mailAccounts.id, messages.accountId))
        .innerJoin(
          messageMailboxes,
          eq(messageMailboxes.messageId, messages.id),
        )
        .innerJoin(mailboxes, eq(mailboxes.id, messageMailboxes.mailboxId))
        .where(
          and(
            inArray(messages.id, action.messageIds),
            inArray(messages.accountId, accountIds),
          ),
        )
    )
      // 反映に必要な ID が無いものは扱えない (IMAP は UID、Graph はメッセージ ID)。
      .filter((row) =>
        row.protocol === "graph"
          ? row.providerMessageId !== null
          : row.uid !== null,
      )
      .map((row) => ({
        ...row,
        uid: row.uid?.toString() ?? null,
        uidValidity: row.uidValidity?.toString() ?? null,
      }));

    // 移動先をアカウントごとに決める。1 つでも決まらなければ全体を受け付けない。
    const destinations = new Map<
      string,
      { mailboxId: string; path: string; role: MailboxRole }
    >();
    if (action.action === "move") {
      const wanted = action.destination as NonNullable<
        typeof action.destination
      >;
      const found = await tx
        .select({
          accountId: mailboxes.accountId,
          mailboxId: mailboxes.id,
          path: mailboxes.path,
          role: mailboxes.specialUse,
        })
        .from(mailboxes)
        .where(
          and(
            inArray(mailboxes.accountId, accountIds),
            action.mailboxId
              ? eq(mailboxes.id, action.mailboxId)
              : inArray(
                  mailboxes.specialUse,
                  // Gmail にはアーカイブ用のフォルダが無く、受信トレイから外したメールは
                  // 「すべてのメール」に残る。アーカイブ先が無ければそれを使う。
                  wanted === "archive" ? ["archive", "all"] : [wanted],
                ),
          ),
        );
      for (const row of found) {
        const current = destinations.get(row.accountId);
        if (!current || (current.role === "all" && row.role === "archive")) {
          destinations.set(row.accountId, {
            mailboxId: row.mailboxId,
            path: row.path,
            role: row.role,
          });
        }
      }
      // ここまでは何も書き込んでいないので、そのまま抜けてよい。
      if (accountIds.some((id) => !destinations.has(id))) {
        return { ok: false, error: "mailbox_not_found" };
      }
    }

    const labelAccounts = new Set(
      (
        await tx
          .select({ id: mailAccounts.id })
          .from(mailAccounts)
          .where(
            and(
              inArray(mailAccounts.id, accountIds),
              eq(mailAccounts.provider, "gmail"),
              eq(mailAccounts.protocol, "imap"),
            ),
          )
      ).map((row) => row.id),
    );

    const accepted = new Set<string>();
    for (const accountId of accountIds) {
      const destination = destinations.get(accountId);
      let sources = placements.filter((row) => row.accountId === accountId);
      /** 手元の DB から移動元を外さないメッセージ (ラベルが付くだけのもの)。 */
      const keptLocally = new Set<string>();
      if (destination && labelAccounts.has(accountId)) {
        // Gmail ではフォルダがラベルなので、移動元にする所在をメールごとに選ぶ。
        const byMessage = new Map<string, Placement[]>();
        for (const row of sources) {
          const rows = byMessage.get(row.messageId);
          if (rows) rows.push(row);
          else byMessage.set(row.messageId, [row]);
        }
        sources = [];
        for (const [messageId, rows] of byMessage) {
          // すでにそのラベルが付いているものは動かさない。
          // (「すべてのメール」にはどのメールも入っているので、アーカイブは別扱い。)
          if (
            destination.role !== "all" &&
            rows.some((row) => row.mailboxId === destination.mailboxId)
          ) {
            continue;
          }
          const plan = planLabelMove(rows, destination.role);
          sources.push(...plan.sources);
          if (!plan.removeLocally) keptLocally.add(messageId);
        }
      }
      const targets = toTargets(
        // すでに移動先にあるものは動かさない。
        sources.filter((row) => row.mailboxId !== destination?.mailboxId),
      );
      if (targets.length === 0) continue;

      let operation: OutboxOperation;
      if (action.action === "set_flags") {
        operation = {
          kind: "set_flags",
          payload: {
            targets,
            ...(action.seen === undefined ? {} : { seen: action.seen }),
            ...(action.flagged === undefined
              ? {}
              : { flagged: action.flagged }),
          },
        };
      } else if (action.action === "move" && destination) {
        operation = {
          kind: "move",
          payload: {
            targets,
            destination: {
              mailboxId: destination.mailboxId,
              path: destination.path,
            },
          },
        };
      } else {
        operation = { kind: "delete", payload: { targets } };
      }

      const [queued] = await tx
        .insert(outbox)
        .values({
          accountId,
          kind: operation.kind,
          payload: operation.payload,
          idempotencyKey: action.idempotencyKey,
        })
        .onConflictDoNothing({
          target: [outbox.accountId, outbox.idempotencyKey],
        })
        .returning({ id: outbox.id });
      const ids = [...new Set(targets.map((target) => target.messageId))];
      for (const id of ids) accepted.add(id);
      // 再送された操作。前回の受け付けで反映済みなので、何もしない。
      if (!queued) continue;

      if (operation.kind === "set_flags") {
        const { seen, flagged } = operation.payload;
        await tx
          .update(messages)
          .set({
            ...(seen === undefined ? {} : { seen }),
            ...(flagged === undefined ? {} : { flagged }),
          })
          .where(inArray(messages.id, ids));
        await recordChanges(tx, userId, "upsert", ids);
      } else {
        await removePlacements(
          tx,
          userId,
          targets.filter((target) => !keptLocally.has(target.messageId)),
        );
      }
      // コミット時に同期ワーカーへ届き、すぐにプロバイダへ反映される。
      await tx.execute(sql`select pg_notify(${CHANNEL_OUTBOX}, ${accountId})`);
    }
    return { ok: true, messageIds: [...accepted] };
  });
}

/**
 * 移動・削除するメッセージを元のフォルダから外す。
 * 同期しているフォルダのどこにも無くなったメッセージは、本体ごと消す
 * (移動先のフォルダを同期していれば、そちらの同期で改めて取り込まれる)。
 */
export async function removePlacements(
  tx: Tx,
  userId: string,
  targets: OutboxTarget[],
) {
  const ids = [...new Set(targets.map((target) => target.messageId))];
  await tx.delete(messageMailboxes).where(
    and(
      inArray(messageMailboxes.messageId, ids),
      inArray(
        messageMailboxes.mailboxId,
        targets.map((target) => target.mailboxId),
      ),
    ),
  );
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
  const gone = new Set(deleted.map((row) => row.id));
  await recordChanges(tx, userId, "delete", [...gone]);
  await recordChanges(
    tx,
    userId,
    "upsert",
    ids.filter((id) => !gone.has(id)),
  );
}

/** 変更履歴に載せ、接続中の端末へ知らせる (同期ワーカーの recordChanges と同じ)。 */
export async function recordChanges(
  tx: Tx,
  userId: string,
  op: "upsert" | "delete",
  messageIds: string[],
) {
  if (messageIds.length === 0) return;
  const rows = await tx
    .insert(changes)
    .values(
      messageIds.map((entityId) => ({
        userId,
        entity: "message" as const,
        entityId,
        op,
      })),
    )
    .returning({ seq: changes.seq });
  const seq = rows.reduce((max, row) => (row.seq > max ? row.seq : max), 0n);
  const payload: ChangeNotification = { userId, seq: seq.toString() };
  await tx.execute(
    sql`select pg_notify(${CHANNEL_CHANGES}, ${JSON.stringify(payload)})`,
  );
}
