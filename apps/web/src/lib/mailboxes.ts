import { useEffect, useState } from "react";
import type { Mailbox, MailboxSummary } from "@/lib/api";
import { listMailboxes } from "@/lib/offline";

/** フォルダ一覧は頻繁には変わらないので、アカウントごとに覚えておく。 */
const mailboxCache = new Map<string, Mailbox[]>();

export function useMailboxes(accountId: string): Mailbox[] {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>(
    () => mailboxCache.get(accountId) ?? [],
  );
  useEffect(() => {
    const controller = new AbortController();
    setMailboxes(mailboxCache.get(accountId) ?? []);
    listMailboxes(accountId, controller.signal)
      .then((list) => {
        mailboxCache.set(accountId, list);
        setMailboxes(list);
      })
      .catch(() => {
        // 取得できなければ、移動先を選べないだけで他の操作は使える。
      });
    return () => controller.abort();
  }, [accountId]);
  return mailboxes;
}

type SpecialUse = NonNullable<MailboxSummary["specialUse"]>;

const specialLabels: Record<SpecialUse, string> = {
  inbox: "受信トレイ",
  flagged: "スター付き",
  drafts: "下書き",
  sent: "送信済み",
  archive: "アーカイブ",
  all: "すべてのメール",
  junk: "迷惑メール",
  trash: "ごみ箱",
};

/** 並び替えていないときの並び順。役割のあるフォルダをこの順に先に並べ、残りは名前順にする。 */
const specialOrder = Object.keys(specialLabels) as SpecialUse[];

/** フォルダの表示名。受信トレイなどの役割があるフォルダは、決まった名前で表示する。 */
export function mailboxLabel(
  mailbox: Pick<MailboxSummary, "name" | "specialUse">,
): string {
  return (
    (mailbox.specialUse && specialLabels[mailbox.specialUse]) || mailbox.name
  );
}

export type MailboxNode = {
  mailbox: MailboxSummary;
  children: MailboxNode[];
  /** このフォルダと、その下のフォルダすべての未読数の合計。 */
  unreadTotal: number;
};

function order(mailbox: MailboxSummary): number {
  const index = mailbox.specialUse
    ? specialOrder.indexOf(mailbox.specialUse)
    : -1;
  return index === -1 ? specialOrder.length : index;
}

/**
 * 並び替えた順 (sortOrder) があればそれに従う。並び替えた後にできたフォルダは
 * 順番を持たないので、後ろに既定の順で並べる。
 */
function compare(a: MailboxNode, b: MailboxNode): number {
  return (
    (a.mailbox.sortOrder ?? Number.POSITIVE_INFINITY) -
      (b.mailbox.sortOrder ?? Number.POSITIVE_INFINITY) ||
    order(a.mailbox) - order(b.mailbox) ||
    mailboxLabel(a.mailbox).localeCompare(mailboxLabel(b.mailbox), "ja")
  );
}

/**
 * アカウント 1 件分のフォルダを、親子関係 (parentId) からツリーに組み立てる。
 * 親が一覧に無いフォルダは最上位に置く。
 */
export function buildMailboxTree(mailboxes: MailboxSummary[]): MailboxNode[] {
  const nodes = new Map<string, MailboxNode>(
    mailboxes.map((mailbox) => [
      mailbox.id,
      { mailbox, children: [], unreadTotal: mailbox.unreadCount },
    ]),
  );
  /** 親をたどると自分に戻る (壊れたデータ) 場合は、最上位として扱う。 */
  const hasCycle = (start: MailboxNode): boolean => {
    const seen = new Set([start.mailbox.id]);
    let parentId = start.mailbox.parentId;
    while (parentId) {
      if (seen.has(parentId)) return true;
      seen.add(parentId);
      parentId = nodes.get(parentId)?.mailbox.parentId ?? null;
    }
    return false;
  };

  const roots: MailboxNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.mailbox.parentId
      ? nodes.get(node.mailbox.parentId)
      : undefined;
    if (parent && !hasCycle(node)) parent.children.push(node);
    else roots.push(node);
  }

  const finish = (list: MailboxNode[]): number => {
    list.sort(compare);
    let unread = 0;
    for (const node of list) {
      node.unreadTotal = node.mailbox.unreadCount + finish(node.children);
      unread += node.unreadTotal;
    }
    return unread;
  };
  finish(roots);
  return roots;
}

/**
 * 並んでいる ID のうち 1 つを、別の ID のある位置へ動かした並びを返す。
 * 位置が変わらない (どちらかが無い、同じ ID) なら null。
 */
export function moveTo(
  ids: string[],
  movedId: string,
  targetId: string,
): string[] | null {
  const from = ids.indexOf(movedId);
  const to = ids.indexOf(targetId);
  if (from === -1 || to === -1 || from === to) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, movedId);
  return next;
}

/** 並んでいる ID のうち 1 つを、1 つ上 (-1) か下 (1) へ動かした並びを返す。端なら null。 */
export function moveBy(
  ids: string[],
  movedId: string,
  delta: -1 | 1,
): string[] | null {
  const target = ids[ids.indexOf(movedId) + delta];
  return ids.includes(movedId) && target !== undefined
    ? moveTo(ids, movedId, target)
    : null;
}

/** ids の順に表示順 (sortOrder) を振り直す。ids に無いものはそのまま。 */
export function withSortOrder<
  T extends { id: string; sortOrder: number | null },
>(items: T[], ids: string[]): T[] {
  const orders = new Map(ids.map((id, index) => [id, index]));
  return items.map((item) => {
    const sortOrder = orders.get(item.id);
    return sortOrder === undefined ? item : { ...item, sortOrder };
  });
}

/** アカウントを表示順に並べる。並び替えていないものは、追加した順に後ろへ。 */
export function sortAccounts<
  T extends { sortOrder: number | null; createdAt: string },
>(accounts: T[]): T[] {
  return [...accounts].sort(
    (a, b) =>
      (a.sortOrder ?? Number.POSITIVE_INFINITY) -
        (b.sortOrder ?? Number.POSITIVE_INFINITY) ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

/** 宛先を一覧に出すフォルダ (自分が差出人のメールが入る)。 */
export function showsRecipients(
  mailbox: Pick<MailboxSummary, "specialUse"> | null | undefined,
): boolean {
  return mailbox?.specialUse === "sent" || mailbox?.specialUse === "drafts";
}

/**
 * あるフォルダにあるメールに対して、アーカイブ・削除・移動で使うフォルダを求める。
 * ツールバーと右クリックメニューで同じ選択肢を出すために共有する。
 */
export function actionTargets(
  mailboxes: Mailbox[],
  currentMailboxId: string | null,
) {
  const current = mailboxes.find((mailbox) => mailbox.id === currentMailboxId);
  // Gmail にはアーカイブ用のフォルダが無く、受信トレイから外したメールは
  // 「すべてのメール」に残る。アーカイブ先が無ければ、それをアーカイブ先にする。
  const archive =
    mailboxes.find((mailbox) => mailbox.specialUse === "archive") ??
    // 受信トレイから外す操作なので、ほかのラベルを開いているときは出さない。
    (!current || current.specialUse === "inbox"
      ? mailboxes.find((mailbox) => mailbox.specialUse === "all")
      : undefined);
  const trash = mailboxes.find((mailbox) => mailbox.specialUse === "trash");
  return {
    /** アーカイブ先。無いか、すでにそこにあるなら null。 */
    archive: archive && archive.id !== currentMailboxId ? archive : null,
    /** ごみ箱。無ければ null。 */
    trash: trash ?? null,
    /** ごみ箱の中にある (削除は完全な削除になる)。 */
    inTrash: current?.specialUse === "trash",
    /** 移動先に選べるフォルダ。下書きなど、受信したメールを入れる場所でないものは除く。 */
    destinations: mailboxes.filter(
      (mailbox) =>
        mailbox.id !== currentMailboxId &&
        mailbox.specialUse !== "drafts" &&
        mailbox.specialUse !== "sent" &&
        mailbox.specialUse !== "all" &&
        mailbox.specialUse !== "flagged",
    ),
  };
}
