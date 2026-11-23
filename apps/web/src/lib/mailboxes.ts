import { useEffect, useState } from "react";
import type { Mailbox, MailboxSummary } from "@/lib/api";
import { listMailboxes } from "@/lib/offline";

/** フォルダ一覧は頻繁には変わらないので、アカウントごとに覚えておく。 */
const mailboxCache = new Map<string, Mailbox[]>();

const refreshListeners = new Set<() => void>();

/**
 * フォルダが変わった (追加、並び替えなど) ことを知らせ、表示中のメニューやツールバーに
 * フォルダ一覧を取得し直させる。
 */
export function refreshMailboxes() {
  for (const listener of refreshListeners) listener();
}

export function useMailboxes(accountId: string): Mailbox[] {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>(
    () => mailboxCache.get(accountId) ?? [],
  );
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((current) => current + 1);
    refreshListeners.add(listener);
    return () => {
      refreshListeners.delete(listener);
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version が変わったら取得し直す。
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
  }, [accountId, version]);
  return mailboxes;
}

type SpecialUse = NonNullable<MailboxSummary["specialUse"]>;

export const specialLabels: Record<SpecialUse, string> = {
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

/**
 * フォルダの表示名。アプリ内で付けた名前があればそれを、無ければ、受信トレイなどの
 * 役割があるフォルダは決まった名前で、ほかはメールサーバー上の名前で表示する。
 */
export function mailboxLabel(
  mailbox: Pick<MailboxSummary, "name" | "specialUse" | "displayName">,
): string {
  return mailbox.displayName || defaultMailboxLabel(mailbox);
}

/** アプリ内で名前を付けていないときの表示名。 */
export function defaultMailboxLabel(
  mailbox: Pick<MailboxSummary, "name" | "specialUse">,
): string {
  return (
    (mailbox.specialUse && specialLabels[mailbox.specialUse]) || mailbox.name
  );
}

/** アプリ内で役割を付け替えられないフォルダ (メールサーバーの仕組みと結び付いている)。 */
export function hasFixedRole(
  mailbox: Pick<MailboxSummary, "specialUse" | "detectedSpecialUse">,
): boolean {
  // 上書きの項目を持たない古い保存内容では、いまの役割で判断する。
  const detected =
    mailbox.detectedSpecialUse === undefined
      ? mailbox.specialUse
      : mailbox.detectedSpecialUse;
  return detected === "inbox" || detected === "all" || detected === "flagged";
}

type TreeMailbox = Mailbox & { unreadCount?: number };

export type MailboxNode<T extends TreeMailbox = MailboxSummary> = {
  mailbox: T;
  children: MailboxNode<T>[];
  /** このフォルダと、その下のフォルダすべての未読数の合計。 */
  unreadTotal: number;
};

function order(mailbox: Mailbox): number {
  const index = mailbox.specialUse
    ? specialOrder.indexOf(mailbox.specialUse)
    : -1;
  return index === -1 ? specialOrder.length : index;
}

/**
 * 並び替えた順 (sortOrder) があればそれに従う。並び替えた後にできたフォルダは
 * 順番を持たないので、後ろに既定の順で並べる。
 */
function compare(a: { mailbox: Mailbox }, b: { mailbox: Mailbox }): number {
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
export function buildMailboxTree<T extends TreeMailbox = MailboxSummary>(
  mailboxes: T[],
): MailboxNode<T>[] {
  const nodes = new Map<string, MailboxNode<T>>(
    mailboxes.map((mailbox) => [
      mailbox.id,
      { mailbox, children: [], unreadTotal: mailbox.unreadCount ?? 0 },
    ]),
  );
  /** 親をたどると自分に戻る (壊れたデータ) 場合は、最上位として扱う。 */
  const hasCycle = (start: MailboxNode<T>): boolean => {
    const seen = new Set([start.mailbox.id]);
    let parentId = start.mailbox.parentId;
    while (parentId) {
      if (seen.has(parentId)) return true;
      seen.add(parentId);
      parentId = nodes.get(parentId)?.mailbox.parentId ?? null;
    }
    return false;
  };

  const roots: MailboxNode<T>[] = [];
  for (const node of nodes.values()) {
    const parent = node.mailbox.parentId
      ? nodes.get(node.mailbox.parentId)
      : undefined;
    if (parent && !hasCycle(node)) parent.children.push(node);
    else roots.push(node);
  }

  const finish = (list: MailboxNode<T>[]): number => {
    list.sort(compare);
    let unread = 0;
    for (const node of list) {
      node.unreadTotal =
        (node.mailbox.unreadCount ?? 0) + finish(node.children);
      unread += node.unreadTotal;
    }
    return unread;
  };
  finish(roots);
  return roots;
}

/** 一覧に出すフォルダ 1 件。depth は階層の深さ (最上位は 0)。 */
export type MailboxEntry<T extends Mailbox = Mailbox> = {
  mailbox: T;
  depth: number;
};

/**
 * フォルダを、サイドバーに表示するのと同じ順 (親のすぐ下に子) に並べる。
 * 移動先のメニューなど、ツリーを 1 列で見せる場所で使う。
 */
export function orderMailboxes<T extends Mailbox>(
  mailboxes: T[],
): MailboxEntry<T>[] {
  const result: MailboxEntry<T>[] = [];
  const walk = (nodes: MailboxNode<T>[], depth: number) => {
    for (const node of nodes) {
      result.push({ mailbox: node.mailbox, depth });
      walk(node.children, depth + 1);
    }
  };
  walk(buildMailboxTree(mailboxes), 0);
  return result;
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
  const junk = mailboxes.find((mailbox) => mailbox.specialUse === "junk");
  const inbox = mailboxes.find((mailbox) => mailbox.specialUse === "inbox");
  const inJunk = current?.specialUse === "junk";
  return {
    /** アーカイブ先。無いか、すでにそこにあるなら null。 */
    archive: archive && archive.id !== currentMailboxId ? archive : null,
    /** ごみ箱。無ければ null。 */
    trash: trash ?? null,
    /** ごみ箱の中にある (削除は完全な削除になる)。 */
    inTrash: current?.specialUse === "trash",
    /**
     * 迷惑メールにするときの移動先。迷惑メールのフォルダが無いか、
     * すでにその中にあるなら null。
     */
    junk: junk && !inJunk ? junk : null,
    /** 迷惑メールから戻すときの移動先 (受信トレイ)。迷惑メールの中にあるときだけ。 */
    notJunk: inJunk && inbox ? inbox : null,
    /**
     * 移動先に選べるフォルダ。サイドバーと同じ順に並べる。
     * 下書きなど、受信したメールを入れる場所でないものは除く。
     */
    destinations: orderMailboxes(mailboxes).filter(
      ({ mailbox }) =>
        mailbox.id !== currentMailboxId &&
        mailbox.specialUse !== "drafts" &&
        mailbox.specialUse !== "sent" &&
        mailbox.specialUse !== "all" &&
        mailbox.specialUse !== "flagged",
    ),
  };
}
