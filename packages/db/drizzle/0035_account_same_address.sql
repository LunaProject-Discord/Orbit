DROP INDEX "mail_accounts_user_email_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "mail_accounts_user_email_server_idx" ON "mail_accounts" USING btree ("user_id","email",coalesce(lower("imap_host"), ''),"username");--> statement-breakpoint
CREATE INDEX "mail_accounts_user_email_idx" ON "mail_accounts" USING btree ("user_id","email");