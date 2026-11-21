import type { FailedOperation, MailboxSummary } from "@/lib/api";
import { mailboxLabel } from "@/lib/mailboxes";

/**
 * メールサーバーへ反映できなかった操作の、画面での呼び方。
 */

type Mailboxes = Pick<MailboxSummary, "id" | "name" | "specialUse">[];

/** 操作の種類を表す短い名前 (「1 件の○○をサーバーに反映できませんでした」の○○)。 */
export function failureLabel(
  failure: FailedOperation,
  mailboxes: Mailboxes,
): string {
  switch (failure.kind) {
    case "move": {
      const destination = mailboxes.find(
        (mailbox) => mailbox.id === failure.destinationMailboxId,
      );
      // 削除とアーカイブは、画面ではごみ箱やアーカイブへの移動として行っている。
      if (destination?.specialUse === "trash") return "削除";
      if (destination?.specialUse === "archive") return "アーカイブ";
      return "移動";
    }
    case "delete":
      return "削除";
    case "append":
      return "送信済みフォルダへの保存";
    case "set_flags":
      if (failure.seen !== null && failure.flagged === null) {
        return failure.seen ? "既読への変更" : "未読への変更";
      }
      if (failure.flagged !== null && failure.seen === null) {
        return failure.flagged ? "スター" : "スターの解除";
      }
      if (failure.answered !== null) return "返信済みの印";
      return "既読やスターの変更";
  }
}

/** 一覧の 1 行に出す説明。移動は移動先も添える。 */
export function failureDescription(
  failure: FailedOperation,
  mailboxes: Mailboxes,
): string {
  const label = failureLabel(failure, mailboxes);
  if (failure.kind === "move" && label === "移動") {
    const destination = mailboxes.find(
      (mailbox) => mailbox.id === failure.destinationMailboxId,
    );
    if (destination) {
      return `${failure.count} 件を「${mailboxLabel(destination)}」へ移動`;
    }
  }
  return `${failure.count} 件の${label}`;
}

/** 通知に出す 1 行。種類が揃っていればその名前で、混ざっていれば「操作」とまとめる。 */
export function failureSummary(
  failures: FailedOperation[],
  mailboxes: Mailboxes,
): string {
  const count = failures.reduce((sum, failure) => sum + failure.count, 0);
  const labels = new Set(
    failures.map((failure) => failureLabel(failure, mailboxes)),
  );
  const [label] = labels;
  return `${count} 件の${labels.size === 1 && label ? label : "操作"}をサーバーに反映できませんでした`;
}

/** 詳細をそのまま貼り付けて相談できるよう、テキストにまとめる。 */
export function failureReport(
  failures: FailedOperation[],
  mailboxes: Mailboxes,
  accountName: (accountId: string) => string,
): string {
  return failures
    .map((failure) =>
      [
        `${failureDescription(failure, mailboxes)} (${accountName(failure.accountId)})`,
        `日時: ${new Date(failure.failedAt).toLocaleString("ja-JP")}`,
        `理由: ${failure.error ?? "不明"}`,
      ].join("\n"),
    )
    .join("\n\n");
}
