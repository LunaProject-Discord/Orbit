import { useEffect, useState } from "react";
import { listMailboxes, type Mailbox } from "@/lib/api";

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

const mailboxLabels: Partial<
  Record<NonNullable<Mailbox["specialUse"]>, string>
> = {
  inbox: "受信トレイ",
  sent: "送信済み",
  drafts: "下書き",
  trash: "ごみ箱",
  junk: "迷惑メール",
  archive: "アーカイブ",
};

/** 画面に出すフォルダ名。受信トレイなどの役割があれば、日本語の名前にする。 */
export function mailboxLabel(mailbox: Mailbox): string {
  return (
    (mailbox.specialUse && mailboxLabels[mailbox.specialUse]) || mailbox.name
  );
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
  const archive = mailboxes.find((mailbox) => mailbox.specialUse === "archive");
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
