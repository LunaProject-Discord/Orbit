CREATE TYPE "public"."attendee_role" AS ENUM('chair', 'required', 'optional', 'non_participant');--> statement-breakpoint
CREATE TYPE "public"."attendee_status" AS ENUM('needs_action', 'accepted', 'declined', 'tentative', 'delegated');--> statement-breakpoint
CREATE TYPE "public"."calendar_source" AS ENUM('google', 'microsoft', 'caldav', 'ics', 'local', 'holidays', 'birthdays');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('confirmed', 'tentative', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."change_entity" ADD VALUE 'calendar';--> statement-breakpoint
ALTER TYPE "public"."change_entity" ADD VALUE 'event';--> statement-breakpoint
CREATE TABLE "calendars" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid,
	"source" "calendar_source" NOT NULL,
	"remote_id" text,
	"name" text NOT NULL,
	"description" text,
	"color" text,
	"time_zone" text,
	"read_only" boolean DEFAULT false NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"sort_order" integer,
	"url" text,
	"poll_interval_seconds" integer,
	"sync_token" text,
	"etag" text,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"push_channel_id" text,
	"push_expires_at" timestamp with time zone,
	"default_reminders" jsonb,
	"expanded_until" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_attendees" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"role" "attendee_role" DEFAULT 'required' NOT NULL,
	"status" "attendee_status" DEFAULT 'needs_action' NOT NULL,
	"self" boolean DEFAULT false NOT NULL,
	"comment" text
);
--> statement-breakpoint
CREATE TABLE "event_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"master_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"recurrence_id" text,
	"all_day" boolean DEFAULT false NOT NULL,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"start_date" date,
	"end_date" date
);
--> statement-breakpoint
CREATE TABLE "event_reminders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" uuid NOT NULL,
	"method" text NOT NULL,
	"minutes" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_search" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"doc" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"uid" text NOT NULL,
	"recurrence_id" text,
	"parent_id" uuid,
	"remote_id" text,
	"etag" text,
	"summary" text,
	"location" text,
	"description" text,
	"status" "event_status" DEFAULT 'confirmed' NOT NULL,
	"busy" boolean DEFAULT true NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"start_date" date,
	"end_date" date,
	"start_time_zone" text,
	"end_time_zone" text,
	"rrule" text,
	"rdates" jsonb,
	"exdates" jsonb,
	"organizer" jsonb,
	"sequence" integer DEFAULT 0 NOT NULL,
	"conference_url" text,
	"use_default_reminders" boolean DEFAULT true NOT NULL,
	"remote_updated_at" timestamp with time zone,
	"field_updated_at" jsonb,
	"raw" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_occurrences" ADD CONSTRAINT "event_occurrences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_occurrences" ADD CONSTRAINT "event_occurrences_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_occurrences" ADD CONSTRAINT "event_occurrences_master_id_events_id_fk" FOREIGN KEY ("master_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_occurrences" ADD CONSTRAINT "event_occurrences_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_reminders" ADD CONSTRAINT "event_reminders_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_search" ADD CONSTRAINT "event_search_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_search" ADD CONSTRAINT "event_search_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_parent_id_events_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendars_user_idx" ON "calendars" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendars_account_remote_idx" ON "calendars" USING btree ("account_id","remote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_attendees_event_email_idx" ON "event_attendees" USING btree ("event_id",lower("email"));--> statement-breakpoint
CREATE INDEX "event_occurrences_user_start_at_idx" ON "event_occurrences" USING btree ("user_id","start_at");--> statement-breakpoint
CREATE INDEX "event_occurrences_user_start_date_idx" ON "event_occurrences" USING btree ("user_id","start_date");--> statement-breakpoint
CREATE INDEX "event_occurrences_master_idx" ON "event_occurrences" USING btree ("master_id");--> statement-breakpoint
CREATE INDEX "event_occurrences_event_idx" ON "event_occurrences" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_reminders_event_idx" ON "event_reminders" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_search_grams_idx" ON "event_search" USING gin (mail_search_grams("doc"));--> statement-breakpoint
CREATE INDEX "event_search_user_idx" ON "event_search" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_calendar_uid_recurrence_idx" ON "events" USING btree ("calendar_id","uid",coalesce("recurrence_id", ''));--> statement-breakpoint
CREATE INDEX "events_user_idx" ON "events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "events_parent_idx" ON "events" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "events_calendar_remote_idx" ON "events" USING btree ("calendar_id","remote_id");