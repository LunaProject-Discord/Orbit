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
CREATE INDEX "messages_sender_check_pending_idx" ON "messages" USING btree ("account_id") WHERE "messages"."sender_check" is null;