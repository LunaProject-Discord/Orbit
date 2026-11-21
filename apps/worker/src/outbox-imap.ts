import type { OutboxOperation, OutboxTarget } from "@mail/core";
import type { ImapFlow } from "imapflow";
import type { OutboxResult } from "./outbox.js";

function groupByMailbox(targets: OutboxTarget[]): Map<string, OutboxTarget[]> {
  const groups = new Map<string, OutboxTarget[]>();
  for (const target of targets) {
    if (target.uid === null) continue;
    const group = groups.get(target.mailboxPath);
    if (group) group.push(target);
    else groups.set(target.mailboxPath, [target]);
  }
  return groups;
}

/**
 * 操作 1 件を IMAP サーバーへ反映する。フォルダを選択し直すので、
 * 呼び出し側は他のフォルダのロックを持っていないこと。
 * サーバーに拒否された場合は ok: false を返し、接続の問題は例外になる。
 */
export async function applyImapOperation(
  client: ImapFlow,
  operation: OutboxOperation,
): Promise<OutboxResult> {
  for (const [path, targets] of groupByMailbox(operation.payload.targets)) {
    let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>>;
    try {
      lock = await client.getMailboxLock(path);
    } catch (error) {
      const err = error as Error & { responseStatus?: string };
      // フォルダが無くなっていた場合など。接続の問題ならそのまま投げる。
      if (err.responseStatus !== "NO" && err.responseStatus !== "BAD") {
        throw error;
      }
      return { ok: false, reason: `フォルダを開けませんでした: ${path}` };
    }
    try {
      const mailbox = client.mailbox;
      if (!mailbox) {
        throw new Error(`フォルダ ${path} を選択できませんでした。`);
      }
      // UIDVALIDITY が変わっていると、同じ UID が別のメールを指しているおそれがある。
      const stale = targets.some(
        (target) =>
          target.uidValidity === null ||
          BigInt(target.uidValidity) !== mailbox.uidValidity,
      );
      if (stale) {
        return {
          ok: false,
          reason: "フォルダが作り直されたため、対象のメールを特定できません。",
        };
      }
      const range = targets.map((target) => target.uid).join(",");
      const succeeded = await run(client, operation, range);
      if (!succeeded) {
        return { ok: false, reason: "サーバーが操作を受け付けませんでした。" };
      }
    } finally {
      lock.release();
    }
  }
  return { ok: true };
}

/** 存在しない UID は、サーバーが単に無視する (他の端末で先に消された場合など)。 */
async function run(
  client: ImapFlow,
  operation: OutboxOperation,
  range: string,
): Promise<boolean> {
  const options = { uid: true };
  switch (operation.kind) {
    case "set_flags": {
      const { seen, flagged } = operation.payload;
      const add: string[] = [];
      const remove: string[] = [];
      if (seen !== undefined) (seen ? add : remove).push("\\Seen");
      if (flagged !== undefined) (flagged ? add : remove).push("\\Flagged");
      if (add.length > 0) {
        if (!(await client.messageFlagsAdd(range, add, options))) return false;
      }
      if (remove.length > 0) {
        if (!(await client.messageFlagsRemove(range, remove, options))) {
          return false;
        }
      }
      return true;
    }
    case "move":
      // MOVE に対応していないサーバーでは、ImapFlow がコピーと削除で代用する。
      return Boolean(
        await client.messageMove(
          range,
          operation.payload.destination.path,
          options,
        ),
      );
    case "delete":
      return client.messageDelete(range, options);
  }
}
