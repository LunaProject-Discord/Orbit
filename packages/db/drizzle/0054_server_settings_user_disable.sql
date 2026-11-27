CREATE TABLE "server_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"password_login" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_settings_single_row" CHECK ("server_settings"."id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disabled_at" timestamp with time zone;