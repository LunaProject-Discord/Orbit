import type { MailboxSummary, MessageAction, MessageSummary } from "@/lib/api";

/**
 * 移動や削除をしたメールを、サーバーへ届く前から移動先の一覧に出す。
 *
 * 削除や移動は「元に戻す」を受け付ける間 (数秒) サーバーへ送らずに待つ。その間に移動先
 * (ごみ箱など) を開くと、サーバーの一覧にはまだ無いので、どこにも無いように見えてしまう。
 * 操作したときの行の姿 (控え) を覚えておき、送信待ちの移動を取得した一覧に重ねて出す。
 */

/** 操作 (idempotencyKey) ごとの、操作したときの行の控え。 */
export type MoveSnapshots = ReadonlyMap<string, readonly MessageSummary[]>;

/** 一覧に出している場所。mailboxId が null なら受信トレイ (accountId も null なら全アカウント分)。 */
export type ListView = { accountId: string | null; mailboxId: string | null };

/**
 * 移動先のフォルダを、メールのアカウントごとに決める (サーバーと同じ決め方)。
 * アーカイブ先が無いアカウント (Gmail) では「すべてのメール」を使う。
 */
export function moveDestination(
  mailboxes: readonly MailboxSummary[],
  accountId: string,
  action: MessageAction,
): MailboxSummary | null {
  if (action.action !== "move") return null;
  const own = mailboxes.filter((mailbox) => mailbox.accountId === accountId);
  if (action.mailboxId) {
    return own.find((mailbox) => mailbox.id === action.mailboxId) ?? null;
  }
  const wanted = action.destination;
  if (!wanted) return null;
  return (
    own.find((mailbox) => mailbox.specialUse === wanted) ??
    (wanted === "archive"
      ? own.find((mailbox) => mailbox.specialUse === "all")
      : undefined) ??
    null
  );
}

/** 一覧に出している場所に、そのフォルダが含まれるか。 */
function shows(view: ListView, mailbox: MailboxSummary): boolean {
  if (view.mailboxId !== null) return mailbox.id === view.mailboxId;
  if (mailbox.specialUse !== "inbox") return false;
  return view.accountId === null || view.accountId === mailbox.accountId;
}

type Moved = {
  /** 控えの行 (会話)。 */
  row: MessageSummary;
  /** 移動先のフォルダ。 */
  mailbox: MailboxSummary;
  seen: boolean;
  flagged: boolean;
};

/** 一覧の並び順 (新しい順)。a が b より後ろなら正。 */
function compare(a: MessageSummary, b: MessageSummary): number {
  if (a.receivedAt !== b.receivedAt) {
    return a.receivedAt < b.receivedAt ? 1 : -1;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * 送信待ちの移動 (actions のうち、控えのあるもの) を、取得した一覧 (rows) に重ねる。
 * 移動先が一覧に出している場所 (view) なら、控えの行をその場所の行として入れる。
 * すでに一覧にある (サーバーに反映済み) メールは入れない。同じ会話の行があれば、そこへまとめる。
 * rows には、先に applyActions で送信待ちの操作を重ねておく。
 */
export function insertPendingMoves(
  rows: MessageSummary[],
  actions: readonly MessageAction[],
  snapshots: MoveSnapshots,
  mailboxes: readonly MailboxSummary[],
  view: ListView,
): MessageSummary[] {
  if (snapshots.size === 0) return rows;
  // メールごとに、最後の移動先を求める (あとの操作ほど優先する)。
  const moved = new Map<string, Moved>();
  for (const action of actions) {
    if (action.action === "set_flags") {
      for (const id of action.messageIds) {
        const entry = moved.get(id);
        if (!entry) continue;
        moved.set(id, {
          ...entry,
          seen: action.seen ?? entry.seen,
          flagged: action.flagged ?? entry.flagged,
        });
      }
      continue;
    }
    if (action.action === "delete") {
      for (const id of action.messageIds) moved.delete(id);
      continue;
    }
    const saved = snapshots.get(action.idempotencyKey);
    for (const id of action.messageIds) {
      const previous = moved.get(id);
      const row =
        previous?.row ??
        saved?.find((candidate) => candidate.threadMessageIds.includes(id));
      if (!row) {
        moved.delete(id);
        continue;
      }
      const mailbox = moveDestination(mailboxes, row.accountId, action);
      if (!mailbox) {
        moved.delete(id);
        continue;
      }
      moved.set(id, {
        row,
        mailbox,
        seen: previous?.seen ?? row.seen,
        flagged: previous?.flagged ?? row.flagged,
      });
    }
  }
  if (moved.size === 0) return rows;

  const present = new Set<string>();
  for (const row of rows) {
    for (const id of row.threadMessageIds) present.add(id);
  }
  // 入れる行を、控えの行と移動先ごとにまとめる。
  const groups = new Map<string, { entry: Moved; ids: string[] }>();
  for (const [id, entry] of moved) {
    if (present.has(id) || !shows(view, entry.mailbox)) continue;
    const key = `${entry.row.id}|${entry.mailbox.id}`;
    const group = groups.get(key);
    if (group) {
      group.ids.push(id);
      group.entry = {
        ...group.entry,
        seen: group.entry.seen && entry.seen,
        flagged: group.entry.flagged || entry.flagged,
      };
    } else groups.set(key, { entry, ids: [id] });
  }
  if (groups.size === 0) return rows;

  let result = rows;
  const added: MessageSummary[] = [];
  for (const { entry, ids } of groups.values()) {
    const { row, mailbox } = entry;
    // 同じ会話の行がすでにあれば、そこへまとめる。
    const at = result.findIndex(
      (other) =>
        other.accountId === row.accountId &&
        other.threadKey === row.threadKey &&
        other.mailboxId === mailbox.id,
    );
    if (at !== -1) {
      const other = result[at] as MessageSummary;
      result = result.slice();
      result[at] = {
        ...other,
        threadMessageIds: [...other.threadMessageIds, ...ids],
        seen: other.seen && entry.seen,
        flagged: other.flagged || entry.flagged,
      };
      continue;
    }
    added.push({
      ...row,
      id: ids.includes(row.id) ? row.id : (ids[0] as string),
      mailboxId: mailbox.id,
      threadMessageIds: ids,
      seen: entry.seen,
      flagged: entry.flagged,
      // 行の操作 (下書きを開くなど) は移動先では意味が変わるので外す。
      draftId: null,
    });
  }
  if (added.length === 0) return result;
  const ids = new Set(result.map((row) => row.id));
  return [...result, ...added.filter((row) => !ids.has(row.id))].sort(compare);
}

/** 送信待ちに残っていない操作の控えを捨てる。 */
export function pruneSnapshots(
  snapshots: Map<string, readonly MessageSummary[]>,
  actions: readonly MessageAction[],
): void {
  if (snapshots.size === 0) return;
  const pending = new Set(actions.map((action) => action.idempotencyKey));
  for (const key of snapshots.keys()) {
    if (!pending.has(key)) snapshots.delete(key);
  }
}

/**
 * 送信待ちの操作 (既読・未読、移動、削除) を、フォルダの未読数に重ねる。
 * snapshots は操作したときの行 (会話) の姿。会話の行は「どれかが未読」しか分からないので、
 * 何通が未読かが分からない会話は 1 通分として数える (サーバーの値が届けば正しい数に戻る)。
 */
export function adjustUnreadCounts<T extends MailboxSummary>(
  mailboxes: T[],
  actions: readonly MessageAction[],
  snapshots: MoveSnapshots,
): T[] {
  if (snapshots.size === 0 || mailboxes.length === 0) return mailboxes;
  const delta = new Map<string, number>();
  const add = (mailboxId: string, value: number) => {
    if (value !== 0) delta.set(mailboxId, (delta.get(mailboxId) ?? 0) + value);
  };
  for (const action of actions) {
    const rows = snapshots.get(action.idempotencyKey);
    if (!rows) continue;
    const ids = new Set(action.messageIds);
    for (const row of rows) {
      const hits = row.threadMessageIds.filter((id) => ids.has(id)).length;
      if (hits === 0) continue;
      const all = hits === row.threadMessageIds.length;
      /** 対象のうち未読の数 (分からなければ少なめに数える)。 */
      const unread = row.seen
        ? 0
        : row.threadMessageIds.length === 1 || all
          ? 1
          : 0;
      if (action.action === "set_flags") {
        if (action.seen === true) add(row.mailboxId, -unread);
        // すべて既読の会話を未読にしたら、対象の数だけ増える。
        if (action.seen === false && row.seen) add(row.mailboxId, hits);
        continue;
      }
      if (action.action === "move") {
        const target = moveDestination(mailboxes, row.accountId, action);
        if (target?.id === row.mailboxId) continue;
        if (target) add(target.id, unread);
      }
      add(row.mailboxId, -unread);
    }
  }
  if (delta.size === 0) return mailboxes;
  return mailboxes.map((mailbox) => {
    const change = delta.get(mailbox.id);
    if (!change) return mailbox;
    return {
      ...mailbox,
      unreadCount: Math.max(0, mailbox.unreadCount + change),
    };
  });
}
