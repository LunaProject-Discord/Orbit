-- メールの検索。部分一致 (ILIKE '%語%') を pg_trgm の索引で速くする。
-- pg_trgm は PostgreSQL に同梱の拡張で、DB の所有者なら追加できる。
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
-- 宛先などの配列 [{name, address}] を、検索用の 1 つの文字列にする。
CREATE OR REPLACE FUNCTION mail_addresses_text(addresses jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT coalesce(
    string_agg(
      btrim(coalesce(entry->>'name', '') || ' ' || coalesce(entry->>'address', '')),
      ' '
    ),
    ''
  )
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(addresses) = 'array' THEN addresses ELSE '[]'::jsonb END
  ) AS entry
$$;--> statement-breakpoint
-- HTML の本文から、タグ・スタイル・スクリプト・コメントを除いた検索用の文字列を作る。
CREATE OR REPLACE FUNCTION mail_html_to_text(html text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURNS NULL ON NULL INPUT
AS $$
  SELECT btrim(regexp_replace(
    replace(replace(replace(replace(replace(replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(html, '<!--.*?-->', ' ', 'g'),
              '<style\M[^>]*?>.*?</style\s*?>', ' ', 'gi'),
            '<script\M[^>]*?>.*?</script\s*?>', ' ', 'gi'),
          '<title\M[^>]*?>.*?</title\s*?>', ' ', 'gi'),
        '<[^>]*>', ' ', 'g'),
      '&nbsp;', ' '), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&amp;', '&'),
    '\s+', ' ', 'g'))
$$;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "search_from" text GENERATED ALWAYS AS (mail_addresses_text("from")) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "search_recipients" text GENERATED ALWAYS AS (mail_addresses_text("to" || "cc" || "bcc")) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "search_body" text GENERATED ALWAYS AS (coalesce(nullif("body_text", ''), mail_html_to_text("body_html"), "snippet", '')) STORED NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_subject_trgm_idx" ON "messages" USING gin ("subject" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "messages_search_from_trgm_idx" ON "messages" USING gin ("search_from" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "messages_search_recipients_trgm_idx" ON "messages" USING gin ("search_recipients" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "messages_search_body_trgm_idx" ON "messages" USING gin ("search_body" gin_trgm_ops);