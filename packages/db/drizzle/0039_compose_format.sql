ALTER TABLE "drafts" ADD COLUMN "format" text DEFAULT 'html' NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "compose_format" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "compose_format" text DEFAULT 'html' NOT NULL;