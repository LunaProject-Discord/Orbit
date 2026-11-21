ALTER TABLE "mail_accounts" ADD COLUMN "push_subscription_id" text;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "push_expires_at" timestamp with time zone;