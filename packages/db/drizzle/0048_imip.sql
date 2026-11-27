ALTER TYPE "public"."event_conflict_kind" ADD VALUE 'invite_failed';--> statement-breakpoint
ALTER TYPE "public"."outbox_kind" ADD VALUE 'imip_send';--> statement-breakpoint
ALTER TABLE "calendars" ADD COLUMN "imip_account_id" uuid;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD COLUMN "replied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD COLUMN "reply_sequence" integer;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "invite_stamp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_imip_account_id_accounts_id_fk" FOREIGN KEY ("imip_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;