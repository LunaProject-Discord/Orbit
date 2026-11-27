ALTER TABLE "calendars" ADD COLUMN "sync_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "remote_deleted_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "first_failed_at" timestamp with time zone;