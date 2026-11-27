-- 運用者のコマンドで作った利用者と、メールアドレスを決めた招待で登録した利用者の
-- メールアドレスを確認済みにする (IdP のメールアドレスとの自動の結び付けは、確認済みの利用者にだけ行う)。
-- メールアドレスを決めない招待で登録した利用者 (任意のアドレスを名乗れる) は、そのまま。
UPDATE "users" SET "email_verified" = true
WHERE "email_verified" = false
  AND "id" NOT IN (
    SELECT "used_by" FROM "invitations"
    WHERE "email" IS NULL AND "used_by" IS NOT NULL
  );
