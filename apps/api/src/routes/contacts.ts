import { zValidator } from "@hono/zod-validator";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, RouteDeps } from "../context.js";

const contactsQuery = z.object({
  /** 名前かアドレスの一部。省略すると上位から返す。 */
  q: z.string().trim().max(200).default(""),
  /** 返す件数。端末が全件を手元に持つときは大きな値を指定する。 */
  limit: z.coerce.number().int().min(1).max(5000).default(20),
});

/**
 * やり取り 1 回の重み。送ったことのある相手を、受け取っただけの相手より重く扱う。
 * どちらも新しいほど重く、HALF_LIFE_DAYS 日で半分になる。
 */
const SENT_WEIGHT = 3;
const RECEIVED_WEIGHT = 1;
const HALF_LIFE_DAYS = 180;

/** 返信を受け付けないアドレス。送ったことがなければ候補に出さない。 */
const NO_REPLY_PATTERN =
  "^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?)([+._-]|@)";

export type ContactRow = {
  address: string;
  name: string | null;
  sentCount: number;
  receivedCount: number;
  lastAt: string | null;
  score: number;
};

/**
 * 宛先の候補にする相手の一覧。送受信したメールの相手から集める。
 * - 送ったメール (差出人が自分のアカウント、または送信済みフォルダにあるもの) の宛先・Cc・Bcc
 * - 受け取ったメールの差出人 (迷惑メール・ごみ箱だけにあるもの、メーリングリスト、
 *   返信を受け付けないアドレスは除く)
 * 自分のアカウントのアドレスは含めない。名前は、いちばん新しいメールで使われていたもの。
 */
export function contactRoutes({ db }: Pick<RouteDeps, "db">) {
  const app = new Hono<AppEnv>();

  app.get("/", zValidator("query", contactsQuery), async (c) => {
    const { q, limit } = c.req.valid("query");
    const userId = c.var.user.id;
    const pattern = `%${q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;

    const result = await db.execute<{
      address: string;
      name: string | null;
      sent_count: string;
      received_count: string;
      last_at: Date | null;
      score: number;
    }>(sql`
      with acc as (
        select id, lower(email) as email from accounts where user_id = ${userId}
      ),
      m as (
        select
          m.id,
          m."from",
          m."to" || m.cc || m.bcc as recipients,
          coalesce(m.sent_at, m.received_at) as at,
          m.list_id,
          (
            exists (
              select 1 from jsonb_array_elements(m."from") f
              where lower(f->>'address') in (select email from acc)
            )
            or exists (
              select 1 from message_mailboxes mm
              join mailboxes b on b.id = mm.mailbox_id
              where mm.message_id = m.id and b.special_use = 'sent'
            )
          ) as outgoing
        from messages m
        where m.account_id in (select id from acc) and not m.draft
      ),
      entries as (
        select lower(a->>'address') as address, nullif(trim(a->>'name'), '') as name,
          m.at, true as sent
        from m, jsonb_array_elements(m.recipients) a
        where m.outgoing
        union all
        select lower(a->>'address'), nullif(trim(a->>'name'), ''), m.at, false
        from m, jsonb_array_elements(m."from") a
        where not m.outgoing
          and m.list_id is null
          and exists (
            select 1 from message_mailboxes mm
            join mailboxes b on b.id = mm.mailbox_id
            where mm.message_id = m.id
              and (b.special_use is null or b.special_use not in ('junk', 'trash'))
          )
      ),
      contacts as (
        select
          address,
          (array_agg(name order by at desc nulls last) filter (where name is not null))[1] as name,
          count(*) filter (where sent) as sent_count,
          count(*) filter (where not sent) as received_count,
          max(at) as last_at,
          sum(
            (case when sent then ${SENT_WEIGHT}::float8 else ${RECEIVED_WEIGHT}::float8 end)
            * power(0.5, greatest(extract(epoch from (now() - coalesce(at, now()))), 0) / 86400.0 / ${HALF_LIFE_DAYS}::float8)
          )::float8 as score
        from entries
        where address like '%_@_%'
          and address not in (select email from acc)
        group by address
      )
      select address, name, sent_count, received_count, last_at, score
      from contacts
      where (sent_count > 0 or address !~ ${NO_REPLY_PATTERN})
        and (${q}::text = '' or address like ${pattern} or lower(coalesce(name, '')) like ${pattern})
      order by score desc, last_at desc nulls last, address
      limit ${limit}
    `);

    const contacts: ContactRow[] = result.rows.map((row) => ({
      address: row.address,
      name: row.name,
      sentCount: Number(row.sent_count),
      receivedCount: Number(row.received_count),
      lastAt: row.last_at ? new Date(row.last_at).toISOString() : null,
      score: Math.round(Number(row.score) * 1000) / 1000,
    }));
    return c.json({ contacts });
  });

  return app;
}
