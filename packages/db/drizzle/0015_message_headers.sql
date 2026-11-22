ALTER TABLE "messages" ADD COLUMN "sender" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "list_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "list_unsubscribe" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "headers_fetched_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "messages_headers_pending_idx" ON "messages" USING btree ("account_id") WHERE "messages"."headers_fetched_at" is null;