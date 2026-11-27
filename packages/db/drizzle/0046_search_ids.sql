-- 検索の語に当てはまるメールの ID を、必ず索引 message_search_grams_idx で引いて返す。
--
-- 以前は API が「mail_search_grams(doc) @> 語の組」を副問い合わせに直接書いていたが、よく出る文字
-- (「a」や英語の「ca」「re」など) では、DB が「当てはまる行が多いので表を順に読む方が速い」と見積もり、
-- 1 通ずつ mail_search_grams を計算する計画を選ぶことがあった。この計算は 1 通で約 1 ミリ秒かかり、
-- 10 万通では 30 秒を超える (索引で引けば 1 秒未満)。
--
-- 関数に SET enable_seqscan = off を付けると、関数の中の問い合わせだけ表を順に読む計画を選ばない
-- (外側の問い合わせには影響しない)。関数を作るだけなので、すぐに終わる。
--
-- grams: mail_search_query_grams でそろえた語の組。
-- pattern: mail_search_like_pattern で作った LIKE のパターン。null なら確かめない (組だけで決まる語)。
-- part: doc のどの部分を確かめるか (0 = 全体、1 = 件名、2 = 差出人、3 = 宛先、4 = 本文)。
-- ROWS は返す行の数の見積もり。よく出る語で多くの行を返しても、外側が 1 通ずつ引く計画にならないよう多めにしてある。
CREATE FUNCTION mail_search_ids(grams text[], pattern text, part integer) RETURNS SETOF uuid
LANGUAGE sql STABLE PARALLEL RESTRICTED
ROWS 10000
SET enable_seqscan = off
AS $$
  SELECT message_id FROM message_search
  WHERE mail_search_grams(doc) @> grams
    AND (pattern IS NULL
      OR (CASE WHEN part = 0 THEN doc ELSE split_part(doc, chr(1), part) END) LIKE pattern)
$$;
