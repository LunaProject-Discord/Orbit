import type { OutboxOperation } from "@mail/core";
import { type GraphClient, GraphError } from "./graph-client.js";
import type { OutboxResult } from "./outbox.js";

/** 同時に送る数。Outlook の制限 (1 メールボックスあたり同時 4 件) より少なくする。 */
const CONCURRENCY = 3;

/**
 * 操作 1 件を Microsoft Graph へ反映する。
 * サーバーに拒否された場合は ok: false を返し、制限や障害が続いた場合は例外になる。
 */
export async function applyGraphOperation(
  client: GraphClient,
  operation: OutboxOperation,
  signal?: AbortSignal,
): Promise<OutboxResult> {
  const ids = [
    ...new Set(
      operation.payload.targets.flatMap(
        (target) => target.providerMessageId ?? [],
      ),
    ),
  ];
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    try {
      await Promise.all(
        ids.slice(i, i + CONCURRENCY).map(async (id) => {
          try {
            await run(client, operation, id, signal);
          } catch (error) {
            // 他の端末で先に消されていた場合は、することが無い。
            if (!(error instanceof GraphError && error.notFound)) throw error;
          }
        }),
      );
    } catch (error) {
      // 制限 (429) と障害 (5xx) は、時間を置けば通るのでやり直す。
      if (
        error instanceof GraphError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429 &&
        error.status !== 401
      ) {
        return { ok: false, reason: error.message };
      }
      throw error;
    }
  }
  return { ok: true };
}

function run(
  client: GraphClient,
  operation: OutboxOperation,
  id: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const path = `/me/messages/${encodeURIComponent(id)}`;
  switch (operation.kind) {
    case "set_flags": {
      const { seen, flagged } = operation.payload;
      return client.request(
        "PATCH",
        path,
        {
          ...(seen === undefined ? {} : { isRead: seen }),
          ...(flagged === undefined
            ? {}
            : { flag: { flagStatus: flagged ? "flagged" : "notFlagged" } }),
        },
        signal,
      );
    }
    case "move":
      return client.request(
        "POST",
        `${path}/move`,
        { destinationId: operation.payload.destination.path },
        signal,
      );
    case "delete":
      return client.request("DELETE", path, undefined, signal);
  }
}
