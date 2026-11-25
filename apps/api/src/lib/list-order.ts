import { messages } from "@orbit/db";
import { asc, desc, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

/**
 * メール一覧の並び順 (フォルダの一覧、統合フォルダ、検索結果で共通)。
 *
 * - date: 受信日時
 * - subject: 件名 (先頭の Re: や Fwd: などを除き、大文字と小文字を区別しない)
 * - from / to: 差出人 / 宛先の 1 人目 (名前があれば名前、無ければアドレス)
 *
 * 続きは keyset (並べる値と ID の組) で取得する。date の続きの位置は以前と同じ形
 * (`<ISO 日時>_<ID>`) で、それ以外は `k:` に [値, 受信日時, ID] の JSON を base64url で続けた形。
 *
 * 文字の並びは端末 (lib/list-sort.ts) と同じになるよう、照合順序 "C" (文字コード順) で比べる。
 */
export const LIST_SORT_KEYS = ["date", "subject", "from", "to"] as const;
export type ListSortKey = (typeof LIST_SORT_KEYS)[number];

export const listOrderQuery = {
  sort: z.enum(LIST_SORT_KEYS).default("date"),
  order: z.enum(["asc", "desc"]).default("desc"),
  /** 前のページの nextCursor。件名などで並べたときは長くなる。 */
  cursor: z.string().max(4000).optional(),
};

export type ListOrder = { sort: ListSortKey; order: "asc" | "desc" };

/** 件名の先頭の返信・転送の印 (Re:、Fwd:、AW: など。Re[2]: や全角のコロンも)。 */
const SUBJECT_PREFIX =
  "^(\\s*(re|fwd?|aw|wg|sv|vs|tr|rif|antw|返信|転送)\\s*(\\[\\d+\\]|\\(\\d+\\))?\\s*[:：]\\s*)+";

/** 並べる値 (date 以外)。外側の問い合わせの messages を参照する。 */
function keyExpression(sort: Exclude<ListSortKey, "date">): SQL<string> {
  if (sort === "subject") {
    return sql<string>`lower(btrim(regexp_replace(coalesce(${messages.subject}, ''), ${SUBJECT_PREFIX}, '', 'i'))) collate "C"`;
  }
  const column = sort === "from" ? messages.from : messages.to;
  return sql<string>`lower(coalesce(nullif(btrim(${column}->0->>'name'), ''), ${column}->0->>'address', '')) collate "C"`;
}

const dateCursor = /^(\d{4}-[0-9T:.-]+Z)_([0-9a-f-]{36})$/;
const uuid = /^[0-9a-f-]{36}$/;
const isoDate = /^\d{4}-[0-9T:.-]+Z$/;

/** ミリ秒より細かい部分まで含めた受信日時の文字列 (JavaScript の Date に直すと切り捨てられるため)。 */
const receivedText = sql<string>`to_char(${messages.receivedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * 並び順に必要な SQL をまとめて返す。cursor が読めなければ null。
 * - key: 結果に sortKey として含めておく値。nextListCursor で次のページの位置を作るのに使う。
 * - after: 前のページより後ろに当たる条件 (cursor が無ければ null)。
 * - orderBy: 並べ方。
 *
 * date 以外で値が同じメールは、向きにかかわらず新しい順に並べる (同じ件名のやり取りなど)。
 */
export function listOrderSql(
  { sort, order }: ListOrder,
  cursor: string | undefined,
): {
  key: SQL<unknown>;
  after: SQL | null;
  orderBy: SQL[];
} | null {
  const direction = order === "asc" ? asc : desc;
  const compare = order === "asc" ? sql`>` : sql`<`;
  if (sort === "date") {
    let after: SQL | null = null;
    if (cursor) {
      const match = dateCursor.exec(cursor);
      if (!match) return null;
      after = sql`(${messages.receivedAt}, ${messages.id}) ${compare} (${match[1]}::timestamptz, ${match[2]}::uuid)`;
    }
    return {
      key: receivedText,
      after,
      orderBy: [direction(messages.receivedAt), direction(messages.id)],
    };
  }
  const key = keyExpression(sort);
  let after: SQL | null = null;
  if (cursor) {
    const decoded = decodeKeyCursor(cursor);
    if (!decoded) return null;
    const value = sql`${decoded.value}::text collate "C"`;
    after = sql`(${key} ${compare} ${value} or (${key} = ${value} and (${messages.receivedAt}, ${messages.id}) < (${decoded.receivedAt}::timestamptz, ${decoded.id}::uuid)))`;
  }
  return {
    key: sql`json_build_array(${key}, ${receivedText})`,
    after,
    orderBy: [direction(key), desc(messages.receivedAt), desc(messages.id)],
  };
}

/** 次のページの位置。sortKey は listOrderSql の key で取得した値。 */
export function nextListCursor(
  { sort }: ListOrder,
  last: { receivedAt: Date; id: string; sortKey?: unknown },
): string {
  if (sort === "date") {
    const text =
      typeof last.sortKey === "string"
        ? last.sortKey
        : last.receivedAt.toISOString();
    return `${text}_${last.id}`;
  }
  const [value, receivedAt] = Array.isArray(last.sortKey)
    ? last.sortKey
    : ["", last.receivedAt.toISOString()];
  return `k:${Buffer.from(JSON.stringify([value, receivedAt, last.id])).toString("base64url")}`;
}

function decodeKeyCursor(
  cursor: string,
): { value: string; receivedAt: string; id: string } | null {
  if (!cursor.startsWith("k:")) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor.slice(2), "base64url").toString("utf8"),
    );
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string" &&
      isoDate.test(parsed[1]) &&
      typeof parsed[2] === "string" &&
      uuid.test(parsed[2])
    ) {
      return { value: parsed[0], receivedAt: parsed[1], id: parsed[2] };
    }
  } catch {
    // 読めない位置は null を返し、呼び出し側が 400 にする。
  }
  return null;
}
