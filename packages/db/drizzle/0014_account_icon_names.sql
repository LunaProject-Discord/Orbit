-- アカウントのアイコンを Lucide の全アイコンから選べるようにしたのに合わせ、
-- これまでの 20 種類のうち独自の名前だったものを、Lucide の名前 (同じ絵) に直す。
UPDATE "mail_accounts" SET "icon" = CASE "icon"
  WHEN 'building' THEN 'building-complex'
  WHEN 'home' THEN 'house'
  WHEN 'gamepad' THEN 'gamepad-2'
  WHEN 'music' THEN 'eighth-notes'
  ELSE "icon"
END
WHERE "icon" IN ('building', 'home', 'gamepad', 'music');
