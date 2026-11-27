CREATE TABLE "event_notices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_reminder_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"minutes" integer NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"change_seq" bigint NOT NULL,
	"sent_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"seq" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_occurrences" DROP CONSTRAINT "event_occurrences_event_id_events_id_fk";
--> statement-breakpoint
ALTER TABLE "event_occurrences" ALTER COLUMN "event_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calendars" ADD COLUMN "notify" boolean;--> statement-breakpoint
ALTER TABLE "calendars" ADD COLUMN "reminders_hash" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "app" text DEFAULT 'mail' NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "notify_mail" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "notify_calendar" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "install_id" uuid;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "reminder_cover_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "reminder_cover_seq" bigint;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "exact_alarms" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "notify_mail" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD COLUMN "notify_calendar" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "calendar_notifications" jsonb;--> statement-breakpoint
ALTER TABLE "event_notices" ADD CONSTRAINT "event_notices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_reminder_jobs" ADD CONSTRAINT "event_reminder_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_reminder_jobs" ADD CONSTRAINT "event_reminder_jobs_occurrence_id_event_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."event_occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_notices_event_idx" ON "event_notices" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE INDEX "event_notices_pending_idx" ON "event_notices" USING btree ("created_at") WHERE "event_notices"."sent_at" is null;--> statement-breakpoint
CREATE INDEX "event_notices_user_idx" ON "event_notices" USING btree ("user_id","claimed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "event_reminder_jobs_occurrence_minutes_idx" ON "event_reminder_jobs" USING btree ("occurrence_id","minutes");--> statement-breakpoint
CREATE INDEX "event_reminder_jobs_pending_idx" ON "event_reminder_jobs" USING btree ("fire_at") WHERE "event_reminder_jobs"."sent_at" is null;--> statement-breakpoint
CREATE INDEX "event_reminder_jobs_user_idx" ON "event_reminder_jobs" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "event_occurrences" ADD CONSTRAINT "event_occurrences_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_occurrences_master_recurrence_idx" ON "event_occurrences" USING btree ("master_id",coalesce("recurrence_id", ''));