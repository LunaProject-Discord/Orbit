ALTER TABLE "mail_accounts" RENAME TO "accounts";--> statement-breakpoint
ALTER TABLE "accounts" RENAME CONSTRAINT "mail_accounts_pkey" TO "accounts_pkey";--> statement-breakpoint
ALTER TABLE "accounts" RENAME CONSTRAINT "mail_accounts_user_id_users_id_fk" TO "accounts_user_id_users_id_fk";--> statement-breakpoint
ALTER INDEX "mail_accounts_user_email_server_idx" RENAME TO "accounts_user_email_server_idx";--> statement-breakpoint
ALTER INDEX "mail_accounts_user_email_idx" RENAME TO "accounts_user_email_idx";--> statement-breakpoint
ALTER TABLE "drafts" RENAME CONSTRAINT "drafts_account_id_mail_accounts_id_fk" TO "drafts_account_id_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "mailboxes" RENAME CONSTRAINT "mailboxes_account_id_mail_accounts_id_fk" TO "mailboxes_account_id_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "messages" RENAME CONSTRAINT "messages_account_id_mail_accounts_id_fk" TO "messages_account_id_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "outbox" RENAME CONSTRAINT "outbox_account_id_mail_accounts_id_fk" TO "outbox_account_id_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "pop_messages" RENAME CONSTRAINT "pop_messages_account_id_mail_accounts_id_fk" TO "pop_messages_account_id_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "signature_rules" RENAME CONSTRAINT "signature_rules_account_id_mail_accounts_id_fk" TO "signature_rules_account_id_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "mail_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "calendar_enabled" boolean DEFAULT false NOT NULL;
