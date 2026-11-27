-- 管理者が無効にした利用者 (users.disabled_at) には、セッションと通知の送り先を作らせない。
-- アプリ側でも確かめるが、無効にする処理 (利用者の行を FOR UPDATE で押さえる) と同時に
-- ログインや通知の登録が走ったときに、すり抜けないよう DB でも止める。
-- FOR SHARE で利用者の行を読むので、無効にする処理が終わるまで待ち、終わった後の値で判断する。
CREATE OR REPLACE FUNCTION orbit_reject_disabled_user() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  disabled timestamptz;
BEGIN
  SELECT disabled_at INTO disabled FROM users WHERE id = NEW.user_id FOR SHARE;
  IF disabled IS NOT NULL THEN
    RAISE EXCEPTION 'user % is disabled', NEW.user_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'user_disabled';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sessions_reject_disabled_user
  BEFORE INSERT OR UPDATE OF user_id ON sessions
  FOR EACH ROW EXECUTE FUNCTION orbit_reject_disabled_user();
--> statement-breakpoint
CREATE TRIGGER push_subscriptions_reject_disabled_user
  BEFORE INSERT OR UPDATE OF user_id ON push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION orbit_reject_disabled_user();
--> statement-breakpoint
CREATE TRIGGER devices_reject_disabled_user
  BEFORE INSERT OR UPDATE OF user_id ON devices
  FOR EACH ROW EXECUTE FUNCTION orbit_reject_disabled_user();
