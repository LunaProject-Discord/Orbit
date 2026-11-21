CREATE TYPE "public"."mail_protocol" AS ENUM('imap', 'graph');--> statement-breakpoint
ALTER TABLE "message_mailboxes" DROP CONSTRAINT "message_mailboxes_mailbox_id_uid_pk";--> statement-breakpoint
ALTER TABLE "mail_accounts" ALTER COLUMN "imap_host" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ALTER COLUMN "imap_port" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ALTER COLUMN "smtp_host" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ALTER COLUMN "smtp_port" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message_mailboxes" ALTER COLUMN "uid" DROP NOT NULL;--> statement-breakpoint
-- 同じフォルダに同じメッセージが複数の UID で入っていた場合は、UID の小さいほうだけを残す。
DELETE FROM "message_mailboxes" a USING "message_mailboxes" b WHERE a."mailbox_id" = b."mailbox_id" AND a."message_id" = b."message_id" AND a."uid" > b."uid";--> statement-breakpoint
ALTER TABLE "message_mailboxes" ADD CONSTRAINT "message_mailboxes_mailbox_id_message_id_pk" PRIMARY KEY("mailbox_id","message_id");--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "protocol" "mail_protocol" DEFAULT 'imap' NOT NULL;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "sync_state" text;--> statement-breakpoint
CREATE UNIQUE INDEX "message_mailboxes_mailbox_uid_idx" ON "message_mailboxes" USING btree ("mailbox_id","uid");