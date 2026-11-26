CREATE TABLE "sender_icons" (
	"key" text PRIMARY KEY NOT NULL,
	"content_type" text,
	"data" "bytea",
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "auth_results" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_check" jsonb;--> statement-breakpoint
-- 取り込み済みのメールも、同期ワーカーが Authentication-Results を後から読めるように、ヘッダーの補完をやり直す。
UPDATE "messages" SET "headers_fetched_at" = NULL WHERE "headers_fetched_at" IS NOT NULL;
