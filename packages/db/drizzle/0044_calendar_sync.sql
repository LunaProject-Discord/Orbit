ALTER TYPE "public"."outbox_kind" ADD VALUE 'event_create';--> statement-breakpoint
ALTER TYPE "public"."outbox_kind" ADD VALUE 'event_update';--> statement-breakpoint
ALTER TYPE "public"."outbox_kind" ADD VALUE 'event_delete';--> statement-breakpoint
ALTER TYPE "public"."outbox_kind" ADD VALUE 'event_respond';--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "oauth_scopes" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "calendar_error" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "caldav_url" text;--> statement-breakpoint
ALTER TABLE "calendars" ADD COLUMN "provider_state" jsonb;