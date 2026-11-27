import {
  microsoftCalendarClientState,
  microsoftCalendarWebhookUrl,
} from "@orbit/core";
import { RENEW_BEFORE_MS, SUBSCRIPTION_LIFETIME_MS } from "../../graph-push.js";
import {
  CalendarAuthError,
  type CalendarRow,
  type ProviderContext,
} from "../provider.js";
import { CalendarGraph, GraphError } from "./graph.js";

/**
 * カレンダーごとの変更通知 (Graph の subscription)。
 * - 対象は me/calendars/{id}/events の作成・変更・削除。受け口は /v1/webhooks/microsoft-calendar。
 * - 合言葉 (clientState) は、アカウントとカレンダーから鍵で計算する (保存しない)。
 * - 期限 (最長 10,080 分) の 2 日前に PATCH で延ばす。Graph 側で消えていたら作り直す。
 * - 失敗したら 1 時間あけて試し直す (providerState.pushRetryAt)。定期的な確認で同期は続く。
 */

const PUSH_RETRY_MS = 60 * 60_000;

type Subscription = { id?: string; expirationDateTime?: string };

function retryAt(row: CalendarRow): number {
  const value = row.providerState?.pushRetryAt;
  return typeof value === "string" ? Date.parse(value) || 0 : 0;
}

export async function maintainMicrosoftPush(
  ctx: ProviderContext,
  rows: CalendarRow[],
  now: () => Date = () => new Date(),
): Promise<void> {
  // 公開された HTTPS の受け口が無ければ、変更通知は使わない (定期的な確認だけ)。
  if (!ctx.webhookBaseUrl) return;
  const graph = new CalendarGraph(ctx);
  for (const row of rows) {
    if (ctx.signal.aborted) return;
    if (!row.remoteId || row.providerState?.kind === "birthdays") continue;
    const at = now().getTime();
    const expiresAt = row.pushExpiresAt?.getTime() ?? 0;
    if (row.pushChannelId && expiresAt - at > RENEW_BEFORE_MS) continue;
    if (at < retryAt(row)) continue;
    const expirationDateTime = new Date(
      at + SUBSCRIPTION_LIFETIME_MS,
    ).toISOString();
    try {
      let saved: { id: string; expiresAt: Date } | null = null;
      if (row.pushChannelId) {
        try {
          const renewed = await graph.request<Subscription>(
            "PATCH",
            `/subscriptions/${encodeURIComponent(row.pushChannelId)}`,
            { body: { expirationDateTime } },
          );
          saved = {
            id: row.pushChannelId,
            expiresAt: new Date(
              renewed.body?.expirationDateTime ?? expirationDateTime,
            ),
          };
        } catch (error) {
          // Graph 側で消えていた (期限切れなど)。作り直す。
          if (!(error instanceof GraphError && error.status === 404)) {
            throw error;
          }
        }
      }
      if (!saved) {
        const notificationUrl = microsoftCalendarWebhookUrl(
          ctx.webhookBaseUrl,
          ctx.account.id,
          row.id,
        );
        const created = await graph.request<Subscription>(
          "POST",
          "/subscriptions",
          {
            body: {
              changeType: "created,updated,deleted",
              notificationUrl,
              // 購読が消された、通知を取りこぼした、再認可が要る、も同じ受け口で受ける。
              lifecycleNotificationUrl: notificationUrl,
              resource: `me/calendars/${row.remoteId}/events`,
              expirationDateTime,
              clientState: microsoftCalendarClientState(
                ctx.encryptionKey,
                ctx.account.id,
                row.id,
              ),
            },
          },
        );
        if (!created.body?.id) {
          throw new Error("作った購読の ID が返りませんでした。");
        }
        saved = {
          id: created.body.id,
          expiresAt: new Date(
            created.body.expirationDateTime ?? expirationDateTime,
          ),
        };
        ctx.log(`カレンダー「${row.name}」の変更通知の購読を始めました`);
      }
      await ctx.saveCalendarState(row.id, {
        pushChannelId: saved.id,
        pushExpiresAt: saved.expiresAt,
        providerState: { pushRetryAt: null },
      });
    } catch (error) {
      if (error instanceof CalendarAuthError || ctx.signal.aborted) throw error;
      ctx.log(
        `カレンダー「${row.name}」の変更通知を購読できませんでした。定期的な確認で同期を続けます: ${error instanceof Error ? error.message : String(error)}`,
      );
      const alive = row.pushChannelId !== null && expiresAt > at;
      await ctx.saveCalendarState(row.id, {
        ...(alive ? {} : { pushChannelId: null, pushExpiresAt: null }),
        providerState: {
          pushRetryAt: new Date(at + PUSH_RETRY_MS).toISOString(),
        },
      });
    }
  }
}

export async function stopMicrosoftPush(
  ctx: ProviderContext,
  calendar: CalendarRow,
): Promise<void> {
  if (calendar.pushChannelId) {
    try {
      await new CalendarGraph(ctx).request(
        "DELETE",
        `/subscriptions/${encodeURIComponent(calendar.pushChannelId)}`,
      );
    } catch (error) {
      // 既に消えていれば止まっている。
      if (!(error instanceof GraphError && error.status === 404)) throw error;
    }
  }
  await ctx.saveCalendarState(calendar.id, {
    pushChannelId: null,
    pushExpiresAt: null,
  });
}
