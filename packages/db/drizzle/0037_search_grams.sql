-- メールの検索を作り直す。
--
-- 以前は messages の生成列 (search_from / search_recipients / search_body) に pg_trgm の索引を張って
-- ILIKE で探していたが、
--   - 3 文字の組の索引なので、日本語でよく使う 1〜2 文字の語 (「林」「請求」など) では索引が効かず全件を読む
--   - 全角と半角 (ＡＢＣ / ABC、ｱﾏｿﾞﾝ / アマゾン)、本文の途中の改行、HTML の文字参照で見落とす
--   - メールを書き換えるたびに生成列 (HTML からの文字の抜き出し) と 4 つの索引を作り直すので、書き込みが重い
-- という問題があった。
--
-- そこで、検索用の文字列を別の表 message_search に置き、1 文字と隣り合う 2 文字の組の GIN 索引で探す。
-- 拡張は使わない (PostgreSQL に最初からある関数だけで作る)。
--
-- このマイグレーションは、全件の書き換えや長い索引作りをしない (数秒で終わる)。
-- 取り込み済みのメールの行の作成と索引 message_search_grams_idx の作成は、同期ワーカーが裏で行う
-- (apps/worker/src/search-index.ts)。それまでの間、API は索引を使わずに探す (遅いが結果は同じ)。

-- 検索用にそろえる: NFKC (全角英数・半角カナなど) → 小文字 → 空白・ゼロ幅文字・制御文字を除く。
-- 空白を除くので、本文の途中で改行された語や「佐藤 美咲」も「佐藤美咲」で見つかる。
-- API と Web の foldForSearch (search-fold.ts) と同じにしておくこと。
CREATE FUNCTION mail_search_normalize(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURNS NULL ON NULL INPUT
AS $$
  SELECT regexp_replace(
    lower(normalize(value, NFKC)),
    '[\s\x01-\x1f\x7f-\x9f\u00ad\u200b-\u200f\u2028-\u202f\u205f-\u2064\ufeff]+', '', 'g')
$$;--> statement-breakpoint
-- 索引に入れる語: 1 文字ずつと、隣り合う 2 文字の組 (重複は GIN がまとめる)。
CREATE FUNCTION mail_search_grams(value text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURNS NULL ON NULL INPUT
AS $$
  SELECT chars || coalesce((
    SELECT array_agg(a || b)
    FROM unnest(chars[1:cardinality(chars) - 1], chars[2:]) AS pairs(a, b)
  ), '{}')
  FROM (SELECT string_to_array(value, NULL) AS chars) AS split
$$;--> statement-breakpoint
-- 探す語 (そろえたもの) を索引で引くときの語: 1 文字ならその文字、2 文字以上なら隣り合う 2 文字の組。
CREATE FUNCTION mail_search_query_grams(value text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURNS NULL ON NULL INPUT
AS $$
  SELECT CASE WHEN cardinality(chars) <= 1 THEN chars ELSE (
    SELECT array_agg(DISTINCT a || b)
    FROM unnest(chars[1:cardinality(chars) - 1], chars[2:]) AS pairs(a, b)
  ) END
  FROM (SELECT string_to_array(value, NULL) AS chars) AS split
$$;--> statement-breakpoint
-- 探す語 (そろえたもの) を、LIKE のパターン (部分一致) にする。% や _ はそのままの文字として探す。
-- 検索用の文字列は「件名 \x01 差出人 \x01 宛先 \x01 本文」なので、場所を限定するときは
-- split_part(doc, chr(1), n) に対して使う。
CREATE FUNCTION mail_search_like_pattern(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURNS NULL ON NULL INPUT
AS $$
  SELECT '%' || replace(replace(replace(value, '\', '\\'), '%', '\%'), '_', '\_') || '%'
$$;--> statement-breakpoint
-- HTML の本文から検索用の文字列を作る。タグ・スタイル・スクリプト・コメントを除き、
-- 文字参照 (&#12354; / &#x3042; / よく使う名前付きのもの) を文字に戻す。
CREATE FUNCTION mail_search_html_text(html text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE RETURNS NULL ON NULL INPUT
AS $$
DECLARE
  result text;
  entity text;
  code integer;
BEGIN
  result := regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(html, '<!--.*?-->', ' ', 'g'),
          '<style\M[^>]*?>.*?</style\s*?>', ' ', 'gi'),
        '<script\M[^>]*?>.*?</script\s*?>', ' ', 'gi'),
      '<title\M[^>]*?>.*?</title\s*?>', ' ', 'gi'),
    '<[^>]*>', ' ', 'g');
  IF strpos(result, '&') = 0 THEN
    RETURN result;
  END IF;
  -- 数値の文字参照。同じものは 1 回でまとめて置き換える。
  FOR entity IN
    SELECT DISTINCT m[1]
    FROM regexp_matches(result, '&#([xX][0-9a-fA-F]{1,6}|[0-9]{1,7});', 'g') AS m
  LOOP
    IF lower(left(entity, 1)) = 'x' THEN
      code := ('x' || lpad(substr(entity, 2), 8, '0'))::bit(32)::integer;
    ELSE
      code := entity::integer;
    END IF;
    IF code BETWEEN 1 AND 1114111 AND code NOT BETWEEN 55296 AND 57343 THEN
      result := replace(result, '&#' || entity || ';', chr(code));
    END IF;
  END LOOP;
  RETURN replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
    replace(replace(replace(replace(replace(replace(replace(result,
    '&nbsp;', ' '), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&apos;', ''''),
    '&yen;', '¥'), '&copy;', '©'), '&reg;', '®'), '&hellip;', '…'), '&mdash;', '—'),
    '&ndash;', '–'), '&lsquo;', '‘'), '&rsquo;', '’'), '&ldquo;', '“'), '&rdquo;', '”'),
    '&zwnj;', ''), '&amp;', '&');
END
$$;--> statement-breakpoint
-- 1 通の検索用の文字列。本文は、テキストが無ければ HTML から作り、本文の取得前は冒頭の抜粋を使う。
CREATE FUNCTION mail_search_document(
  subject text, sender jsonb, recipients jsonb, body_text text, body_html text, snippet text
) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT coalesce(mail_search_normalize(subject), '') || chr(1)
    || coalesce(mail_search_normalize(mail_addresses_text(sender)), '') || chr(1)
    || coalesce(mail_search_normalize(mail_addresses_text(recipients)), '') || chr(1)
    || coalesce(mail_search_normalize(
      coalesce(nullif(body_text, ''), mail_search_html_text(body_html), snippet)), '')
$$;--> statement-breakpoint
CREATE TABLE "message_search" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"doc" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_search" ADD CONSTRAINT "message_search_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- 索引 message_search_grams_idx は、ここでは作らない (同期ワーカーが CREATE INDEX CONCURRENTLY で作る)。
-- メールの追加・変更に合わせて、検索用の文字列を作り直す。
CREATE FUNCTION messages_search_sync() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO message_search (message_id, doc)
  VALUES (
    NEW.id,
    mail_search_document(NEW.subject, NEW."from", NEW."to" || NEW.cc || NEW.bcc, NEW.body_text, NEW.body_html, NEW.snippet)
  )
  ON CONFLICT (message_id) DO UPDATE SET doc = excluded.doc
  WHERE message_search.doc IS DISTINCT FROM excluded.doc;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER messages_search_insert AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION messages_search_sync();--> statement-breakpoint
CREATE TRIGGER messages_search_update AFTER UPDATE OF subject, "from", "to", cc, bcc, body_text, body_html, snippet ON messages
FOR EACH ROW
WHEN (
  OLD.subject IS DISTINCT FROM NEW.subject
  OR OLD."from" IS DISTINCT FROM NEW."from"
  OR OLD."to" IS DISTINCT FROM NEW."to"
  OR OLD.cc IS DISTINCT FROM NEW.cc
  OR OLD.bcc IS DISTINCT FROM NEW.bcc
  OR OLD.body_text IS DISTINCT FROM NEW.body_text
  OR OLD.body_html IS DISTINCT FROM NEW.body_html
  OR OLD.snippet IS DISTINCT FROM NEW.snippet
)
EXECUTE FUNCTION messages_search_sync();--> statement-breakpoint
-- 以前の検索用の列と索引を外す (列を外すのは表の定義を変えるだけで、全件の書き換えはしない)。
DROP INDEX "messages_subject_trgm_idx";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "search_from";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "search_recipients";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "search_body";--> statement-breakpoint
DROP FUNCTION mail_html_to_text(text);
