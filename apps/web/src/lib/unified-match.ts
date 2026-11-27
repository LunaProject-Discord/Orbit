import { applyActions, knownUnseen } from "@/lib/actions";
import type {
  MailboxSummary,
  MessageAction,
  MessageSummary,
  UnifiedCondition,
  UnifiedFolder,
  UnifiedScope,
} from "@/lib/api";
import { type MoveSnapshots, moveDestination } from "@/lib/pending-moves";

/**
 * 統合フォルダの条件 (AND / OR / NOT の木) を端末で確かめ、まだサーバーへ届いていない操作を
 * 統合フォルダの未読数と一覧に重ねる。
 *
 * 端末は一覧の行 (会話) の内容しか知らないので、条件は「当てはまる / 当てはまらない /
 * 分からない」の 3 通りで確かめる。分からないときは何も変えず、サーバーの値を待つ。
 * 文字の条件 (差出人・件名・本文など) と、検索の書き方で書いた条件は、サーバーと同じ
 * 決まりで確かめられないので、いつも「分からない」とする。
 */

/** 3 通りの答え。null は分からない。 */
type Tri = boolean | null;

/** メール 1 通について、端末で分かっていること。null は分からない。 */
export type MessageFacts = {
  seen: Tri;
  flagged: Tri;
  answered: Tri;
  hasAttachments: Tri;
  /** 受信した日時。分からなければ null。 */
  receivedAt: string | null;
  /** これより前に受信したことだけが分かっている (会話の古いメール)。 */
  receivedBefore: string | null;
};

const not3 = (value: Tri): Tri => (value === null ? null : !value);

function and3(values: Tri[]): Tri {
  let unknown = false;
  for (const value of values) {
    if (value === false) return false;
    if (value === null) unknown = true;
  }
  return unknown ? null : true;
}

function or3(values: Tri[]): Tri {
  let unknown = false;
  for (const value of values) {
    if (value === true) return true;
    if (value === null) unknown = true;
  }
  return unknown ? null : false;
}

/** 条件を確かめた答え。"empty" は中身の無い条件 (サーバーでも無視する)。 */
type Result = Tri | "empty";

const DAY_MS = 86_400_000;

function ruleResult(
  node: Exclude<UnifiedCondition, { type: "group" }>,
  facts: MessageFacts,
  now: number,
): Result {
  let value: Tri;
  switch (node.type) {
    case "text":
    case "query":
      if (node.value.trim() === "") return "empty";
      value = null;
      break;
    case "flag":
      value =
        node.flag === "unread"
          ? not3(facts.seen)
          : node.flag === "flagged"
            ? facts.flagged
            : node.flag === "answered"
              ? facts.answered
              : facts.hasAttachments;
      break;
    case "received": {
      const since = now - node.days * DAY_MS;
      if (facts.receivedAt !== null) {
        value = Date.parse(facts.receivedAt) >= since;
      } else if (
        facts.receivedBefore !== null &&
        Date.parse(facts.receivedBefore) < since
      ) {
        value = false;
      } else value = null;
      break;
    }
  }
  // サーバーでは、分からない値 (NULL) を「当てはまらない」とみなしてから否定する。
  return node.negate ? not3(value) : value;
}

function conditionResult(
  node: UnifiedCondition,
  facts: MessageFacts,
  now: number,
): Result {
  if (node.type !== "group") return ruleResult(node, facts, now);
  const parts = node.children
    .map((child) => conditionResult(child, facts, now))
    .filter((part): part is Tri => part !== "empty");
  if (parts.length === 0) return "empty";
  if (node.match === "all") return and3(parts);
  const any = or3(parts);
  return node.match === "none" ? not3(any) : any;
}

/** メールが統合フォルダの条件に当てはまるか (集める場所は見ない)。 */
export function matchesFilters(
  folder: Pick<UnifiedFolder, "filters">,
  facts: MessageFacts,
  now: number = Date.now(),
): Tri {
  const result = conditionResult(folder.filters.root, facts, now);
  return result === "empty" ? true : result;
}

/** フォルダが、統合フォルダの集める場所に入っているか (サーバーの scopeCondition と同じ)。 */
export function inScope(
  scope: UnifiedScope,
  mailbox: Pick<MailboxSummary, "id" | "specialUse">,
): boolean {
  if (scope.all) {
    return mailbox.specialUse !== "trash" && mailbox.specialUse !== "junk";
  }
  if (scope.mailboxIds.includes(mailbox.id)) return true;
  return (
    mailbox.specialUse !== null &&
    (scope.roles as readonly string[]).includes(mailbox.specialUse)
  );
}

/** 行 (会話) の内容から分かる、メッセージ id のこと。 */
export function factsOf(row: MessageSummary, id: string): MessageFacts {
  const single = row.threadMessageIds.length === 1;
  const unseen = knownUnseen(row);
  // 行のスターと添付は「どれかに付いている」、既読は「すべて既読」を表す。
  const either = (value: boolean): Tri =>
    !value ? false : single ? true : null;
  const head = id === row.id;
  return {
    seen: unseen ? !unseen.includes(id) : row.seen ? true : null,
    flagged: either(row.flagged),
    hasAttachments: either(row.hasAttachments),
    answered: head ? row.answered : null,
    receivedAt: head ? row.receivedAt : null,
    // 代表の行は会話のうち最も新しいメールなので、ほかはそれより前に届いている。
    receivedBefore: head ? null : row.receivedAt,
  };
}

/** 操作の後のこと。 */
function factsAfter(facts: MessageFacts, action: MessageAction): MessageFacts {
  if (action.action !== "set_flags") return facts;
  return {
    ...facts,
    seen: action.seen ?? facts.seen,
    flagged: action.flagged ?? facts.flagged,
  };
}

/** 統合フォルダの未読数に数えられているか。 */
function counted(
  folder: UnifiedFolder,
  facts: MessageFacts,
  mailbox: MailboxSummary | undefined,
  now: number,
): Tri {
  return and3([
    not3(facts.seen),
    mailbox ? inScope(folder.scope, mailbox) : null,
    matchesFilters(folder, facts, now),
  ]);
}

/**
 * 一括で既読にしているフォルダ (「すべて既読にする」の応答を待つ間)。
 * unread はそのときのフォルダの未読数。
 */
export type PendingMarkRead = { mailboxId: string; unread: number };

/**
 * 送信待ちの操作を、統合フォルダの未読数に重ねる。
 * origins は操作ごとの、控えの行を取った統合フォルダ (統合フォルダの一覧で操作したとき)。
 * その統合フォルダの一覧にあった行は、条件に当てはまることが分かっている。
 */
export function adjustUnifiedCounts(
  folders: UnifiedFolder[],
  actions: readonly MessageAction[],
  snapshots: MoveSnapshots,
  origins: ReadonlyMap<string, string>,
  mailboxes: readonly MailboxSummary[],
  markRead: readonly PendingMarkRead[] = [],
  now: number = Date.now(),
): UnifiedFolder[] {
  if (folders.length === 0) return folders;
  if (snapshots.size === 0 && markRead.length === 0) return folders;
  const byId = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox]));
  const delta = new Map<string, number>();
  const zero = new Set<string>();
  for (const folder of folders) {
    let change = 0;
    for (const action of actions) {
      const rows = snapshots.get(action.idempotencyKey);
      if (!rows) continue;
      const known = origins.get(action.idempotencyKey) === folder.id;
      const ids = new Set(action.messageIds);
      for (const row of rows) {
        const mailbox = byId.get(row.mailboxId);
        for (const id of row.threadMessageIds) {
          if (!ids.has(id)) continue;
          const facts = factsOf(row, id);
          const before = known
            ? not3(facts.seen)
            : counted(folder, facts, mailbox, now);
          let after: Tri;
          if (action.action === "delete") after = false;
          else if (action.action === "move") {
            const target = moveDestination(mailboxes, row.accountId, action);
            if (target?.id === row.mailboxId) continue;
            // この統合フォルダの一覧にあった行は、条件に当てはまっている (移動で条件は変わらない)。
            after = target
              ? and3([
                  not3(facts.seen),
                  inScope(folder.scope, target),
                  known ? true : matchesFilters(folder, facts, now),
                ])
              : null;
          } else {
            const next = factsAfter(facts, action);
            after = and3([
              not3(next.seen),
              known ? true : mailbox ? inScope(folder.scope, mailbox) : null,
              matchesFilters(folder, next, now),
            ]);
          }
          if (before === null || after === null) continue;
          change += Number(after) - Number(before);
        }
      }
    }
    // 「すべて既読にする」: 集める場所のフォルダの未読は、すべて既読になる。
    if (markRead.length > 0) {
      const sources = mailboxes.filter((mailbox) =>
        inScope(folder.scope, mailbox),
      );
      const marked = new Set(markRead.map((entry) => entry.mailboxId));
      if (
        sources.length > 0 &&
        sources.every((mailbox) => marked.has(mailbox.id))
      ) {
        zero.add(folder.id);
      } else {
        // 未読でさえあれば当てはまる条件なら、そのフォルダの未読数だけ減る。
        const unreadOnly = matchesFilters(
          folder,
          {
            seen: false,
            flagged: null,
            answered: null,
            hasAttachments: null,
            receivedAt: null,
            receivedBefore: null,
          },
          now,
        );
        if (unreadOnly === true) {
          for (const entry of markRead) {
            const mailbox = byId.get(entry.mailboxId);
            if (mailbox && inScope(folder.scope, mailbox)) {
              change -= entry.unread;
            }
          }
        }
      }
    }
    if (change !== 0) delta.set(folder.id, change);
  }
  if (delta.size === 0 && zero.size === 0) return folders;
  return folders.map((folder) => {
    if (zero.has(folder.id)) {
      return folder.unreadCount === 0 ? folder : { ...folder, unreadCount: 0 };
    }
    const change = delta.get(folder.id);
    if (!change) return folder;
    return {
      ...folder,
      unreadCount: Math.max(0, folder.unreadCount + change),
    };
  });
}

/** 一覧の並び順 (新しい順)。 */
function newestFirst(a: MessageSummary, b: MessageSummary): number {
  if (a.receivedAt !== b.receivedAt) {
    return a.receivedAt < b.receivedAt ? 1 : -1;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * 送信待ちの操作を、統合フォルダの一覧に重ねる。rows には先に applyActions で操作を重ねておく。
 * - 操作で条件から外れたことが分かる行は外す (kept にある行は、利用者が操作した行なので残す)。
 * - 操作で条件に当てはまるようになったことが分かる行は、控えから入れる
 *   (ほかのウィンドウで未読にしたメールを、未読だけの統合フォルダに出すなど)。
 */
export function overlayUnifiedRows(
  rows: MessageSummary[],
  actions: readonly MessageAction[],
  snapshots: MoveSnapshots,
  folder: UnifiedFolder,
  mailboxes: readonly MailboxSummary[],
  kept: ReadonlySet<string> = new Set(),
  order: (a: MessageSummary, b: MessageSummary) => number = newestFirst,
  now: number = Date.now(),
): MessageSummary[] {
  if (actions.length === 0) return rows;
  const byId = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox]));
  const touched = new Set(actions.flatMap((action) => action.messageIds));
  /** 行が、いまの内容で統合フォルダに入るか。 */
  const belongs = (row: MessageSummary): Tri => {
    const mailbox = byId.get(row.mailboxId);
    const place = mailbox ? inScope(folder.scope, mailbox) : null;
    return or3(
      row.threadMessageIds.map((id) =>
        and3([place, matchesFilters(folder, factsOf(row, id), now)]),
      ),
    );
  };

  // 条件から外れた行を外す。操作の対象になった行だけを確かめる。
  let result = rows.filter(
    (row) =>
      kept.has(row.id) ||
      !row.threadMessageIds.some((id) => touched.has(id)) ||
      belongs(row) !== false,
  );

  // 当てはまるようになった行を入れる。控えの行に操作を重ねて、移動先も反映する。
  const present = new Set(result.flatMap((row) => row.threadMessageIds));
  const added: MessageSummary[] = [];
  actions.forEach((action, at) => {
    const saved = snapshots.get(action.idempotencyKey);
    if (!saved || action.action === "delete") return;
    const later = actions.slice(at + 1);
    for (const row of saved) {
      const ids = row.threadMessageIds.filter((id) =>
        action.messageIds.includes(id),
      );
      if (
        ids.length === 0 ||
        row.threadMessageIds.some((id) => present.has(id))
      ) {
        continue;
      }
      // あとで別の場所へ移したり削除したりしたメールは、ここでは入れない。
      if (
        later.some(
          (item) =>
            item.action !== "set_flags" &&
            item.messageIds.some((id) => row.threadMessageIds.includes(id)),
        )
      ) {
        continue;
      }
      let candidate: MessageSummary = row;
      if (action.action === "move") {
        const target = moveDestination(mailboxes, row.accountId, action);
        if (!target || target.id === row.mailboxId) continue;
        // 移動したメッセージだけが移動先へ行く。
        candidate = {
          ...row,
          id: ids.includes(row.id) ? row.id : (ids[0] as string),
          mailboxId: target.id,
          threadMessageIds: ids,
          draftId: null,
        };
        const unseen = knownUnseen(row);
        if (unseen) {
          candidate.unseenIds = unseen.filter((id) => ids.includes(id));
          candidate.seen = candidate.unseenIds.length === 0;
        }
      }
      // この操作とそれ以降の既読・スターの変更を重ねる。
      const [next] = applyActions(
        [candidate],
        [action, ...later].filter((item) => item.action === "set_flags"),
      );
      if (!next || belongs(next) !== true) continue;
      added.push(next);
      for (const id of next.threadMessageIds) present.add(id);
    }
  });
  if (added.length === 0) return result;
  result = [...result, ...added].sort(order);
  return result;
}
