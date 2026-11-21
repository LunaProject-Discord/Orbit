-- Microsoft Graph のアカウントでは、これまで添付ファイルの一覧を取得していなかった。
-- 添付ファイル (または本文に埋め込まれた画像) があるメールの本文を未取得に戻し、
-- 同期ワーカーに本文と一緒に添付ファイルの一覧を取得し直させる。
UPDATE "messages" AS m
SET "body_fetched_at" = NULL
FROM "mail_accounts" AS a
WHERE a."id" = m."account_id"
  AND a."protocol" = 'graph'
  AND m."body_fetched_at" IS NOT NULL
  AND (m."has_attachments" OR m."body_html" ILIKE '%cid:%')
  AND NOT EXISTS (SELECT 1 FROM "attachments" AS f WHERE f."message_id" = m."id");
