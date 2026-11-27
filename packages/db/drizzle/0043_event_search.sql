-- 予定の検索用の文字列 (タイトル \x01 場所 \x01 メモ) を、予定の追加・変更に合わせて作り直す。
-- そろえ方と索引の引き方はメールの検索 (0037_search_grams.sql) と同じ。
CREATE FUNCTION events_search_sync() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO event_search (event_id, user_id, doc)
  VALUES (
    NEW.id,
    NEW.user_id,
    coalesce(mail_search_normalize(NEW.summary), '') || chr(1)
      || coalesce(mail_search_normalize(NEW.location), '') || chr(1)
      || coalesce(mail_search_normalize(mail_search_html_text(NEW.description)), '')
  )
  ON CONFLICT (event_id) DO UPDATE SET doc = excluded.doc;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER events_search_sync
AFTER INSERT OR UPDATE OF summary, location, description ON events
FOR EACH ROW EXECUTE FUNCTION events_search_sync();
