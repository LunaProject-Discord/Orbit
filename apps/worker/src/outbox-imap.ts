import type {
  AppendPayload,
  MailboxOperation,
  OutboxOperation,
  OutboxTarget,
} from "@mail/core";
import type { ImapFlow } from "imapflow";
import { clearRejection, firstRejection } from "./imap-rejection.js";
import {
  applyImapMailboxOperation,
  isMailboxOperation,
} from "./mailbox-operations.js";
import { buildMime, missingAttachments } from "./mime.js";
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
  if (operation.kind === "append") {
    return appendSentCopy(client, operation.payload);
  }
  if (isMailboxOperation(operation)) {
    return applyImapMailboxOperation(client, operation);
  }
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
      clearRejection(client);
      const succeeded = await run(client, operation, range);
      if (!succeeded) {
        // サーバーが返した文面があれば添える (フォルダへの書き込みを禁じている、など)。
        const response = firstRejection(client);
        return {
          ok: false,
          reason: response
            ? `サーバーが操作を受け付けませんでした。(サーバーの応答: ${response})`
            : "サーバーが操作を受け付けませんでした。",
        };
      }
    } finally {
      lock.release();
    }
  }
  return { ok: true };
}

/** サーバーに拒否された (NO / BAD) なら true。接続の問題なら false。 */
function isRejected(error: unknown): boolean {
  const status = (error as { responseStatus?: string }).responseStatus;
  return status === "NO" || status === "BAD";
}

/**
 * 送信したメールの控えを、送信済みフォルダへ保存する。
 * 同じ Message-ID のメールがすでにあれば何もしない (やり直しで二重に保存しないため。
 * サーバーが自動で保存していた場合もここで止まる)。
 */
async function appendSentCopy(
  client: ImapFlow,
  payload: AppendPayload,
): Promise<OutboxResult> {
  const { message, mailboxPath } = payload;
  let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>>;
  try {
    lock = await client.getMailboxLock(mailboxPath);
  } catch (error) {
    if (!isRejected(error)) throw error;
    return {
      ok: false,
      reason: `送信済みフォルダを開けませんでした: ${mailboxPath}`,
    };
  }
  try {
    const existing = await client.search(
      { header: { "message-id": message.messageId } },
      { uid: true },
    );
    if (existing && existing.length > 0) return { ok: true };
  } catch (error) {
    // 検索に対応していないサーバーでは、確かめずに保存する。
    if (!isRejected(error)) throw error;
  } finally {
    lock.release();
  }
  if ((await missingAttachments(message)).length > 0) {
    return {
      ok: false,
      reason:
        "添付ファイルが残っていないため、送信済みフォルダへ保存できませんでした。",
    };
  }
  try {
    const raw = await buildMime(message, { keepBcc: true });
    const appended = await client.append(
      mailboxPath,
      raw,
      ["\\Seen"],
      new Date(message.date),
    );
    if (!appended) {
      return { ok: false, reason: "送信済みフォルダへ保存できませんでした。" };
    }
    return { ok: true };
  } catch (error) {
    if (!isRejected(error)) throw error;
    return { ok: false, reason: "送信済みフォルダへ保存できませんでした。" };
  }
}

/** 存在しない UID は、サーバーが単に無視する (他の端末で先に消された場合など)。 */
async function run(
  client: ImapFlow,
  operation: Exclude<OutboxOperation, { kind: "append" } | MailboxOperation>,
  range: string,
): Promise<boolean> {
  const options = { uid: true };
  switch (operation.kind) {
    case "set_flags": {
      const { seen, flagged, answered } = operation.payload;
      const add: string[] = [];
      const remove: string[] = [];
      if (seen !== undefined) (seen ? add : remove).push("\\Seen");
      if (flagged !== undefined) (flagged ? add : remove).push("\\Flagged");
      if (answered !== undefined) {
        (answered ? add : remove).push("\\Answered");
      }
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
    case "move": {
      const destination = operation.payload.destination.path;
      // MOVE に対応していないサーバーでは、ImapFlow がコピーと削除で代用する。
      if (await client.messageMove(range, destination, options)) return true;
      return moveWithoutMove(client, range, destination);
    }
    case "delete":
      return client.messageDelete(range, options);
  }
}

/** コピーや保存し直しのときに、移動先へ引き継がないフラグ。 */
const TRANSIENT_FLAGS = new Set(["\\Recent", "\\Deleted"]);

/**
 * MOVE を拒否されたときの代わりの移動。フォルダによって MOVE や COPY を受け付けない
 * メールサーバーがある (携帯会社のメールの、迷惑メール用のフォルダなど) ので、
 * 受け付けられる方法を順に試す。
 *
 * 1. COPY してから元を削除する (MOVE に対応しているサーバーだけ。対応していないサーバーでは、
 *    ImapFlow がすでに同じことを試している)。
 * 2. メールを取得して移動先へ保存し直し (APPEND)、元を削除する。
 *
 * どれも受け付けられなければ false。元のメールは、移動先に入ったものだけを消す。
 */
async function moveWithoutMove(
  client: ImapFlow,
  range: string,
  destination: string,
): Promise<boolean> {
  const options = { uid: true };
  if (client.capabilities?.has("MOVE")) {
    if (await client.messageCopy(range, destination, options)) {
      return client.messageDelete(range, options);
    }
  }
  const moved: string[] = [];
  let complete = true;
  for (const uid of range.split(",")) {
    let appended = false;
    try {
      const message = await client.fetchOne(
        uid,
        { source: true, flags: true, internalDate: true },
        options,
      );
      // ほかの端末で先に消されたメールは、移動できたものとして扱う (MOVE と同じ)。
      if (!message || !message.source) continue;
      const flags = [...(message.flags ?? [])].filter(
        (flag) => !TRANSIENT_FLAGS.has(flag),
      );
      appended = Boolean(
        await client.append(
          destination,
          message.source,
          flags,
          message.internalDate instanceof Date
            ? message.internalDate
            : undefined,
        ),
      );
    } catch (error) {
      if (!isRejected(error)) throw error;
    }
    if (!appended) {
      // 1 通目から受け付けられないなら、残りも同じ。途中からなら、入った分だけ元を消す。
      complete = false;
      break;
    }
    moved.push(uid);
  }
  if (moved.length > 0) {
    const deleted = await client.messageDelete(moved.join(","), options);
    if (!deleted) return false;
  }
  return complete;
}
