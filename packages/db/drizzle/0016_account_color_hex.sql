-- アカウントの色を自由に選べるようにしたのに合わせ、
-- これまでの色の名前 (8 種類) を、色そのもの ("#rrggbb") に直す。
UPDATE "mail_accounts" SET "color" = CASE "color"
  WHEN 'sky' THEN '#0ea5e9'
  WHEN 'violet' THEN '#8b5cf6'
  WHEN 'emerald' THEN '#10b981'
  WHEN 'amber' THEN '#f59e0b'
  WHEN 'rose' THEN '#f43f5e'
  WHEN 'teal' THEN '#14b8a6'
  WHEN 'orange' THEN '#f97316'
  WHEN 'slate' THEN '#64748b'
  ELSE "color"
END
WHERE "color" IN ('sky', 'violet', 'emerald', 'amber', 'rose', 'teal', 'orange', 'slate');
