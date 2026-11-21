CREATE TYPE "public"."change_entity" AS ENUM('account', 'mailbox', 'message');--> statement-breakpoint
CREATE TYPE "public"."change_op" AS ENUM('upsert', 'delete');--> statement-breakpoint
CREATE TYPE "public"."device_platform" AS ENUM('web', 'desktop', 'android', 'ios');--> statement-breakpoint
CREATE TYPE "public"."mail_account_status" AS ENUM('active', 'auth_required', 'error', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."mail_auth_type" AS ENUM('oauth2', 'password');--> statement-breakpoint
CREATE TYPE "public"."mail_provider" AS ENUM('gmail', 'microsoft', 'icloud', 'generic');--> statement-breakpoint
CREATE TYPE "public"."mailbox_special_use" AS ENUM('inbox', 'sent', 'drafts', 'trash', 'junk', 'archive', 'all', 'flagged');--> statement-breakpoint
CREATE TYPE "public"."outbox_kind" AS ENUM('send', 'set_flags', 'move', 'delete', 'append');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'processing', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"filename" text,
	"content_type" text NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"content_id" text,
	"inline" boolean DEFAULT false NOT NULL,
	"part_id" text NOT NULL,
	"storage_key" text
);
--> statement-breakpoint
CREATE TABLE "changes" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"entity" "change_entity" NOT NULL,
	"entity_id" uuid NOT NULL,
	"op" "change_op" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"platform" "device_platform" NOT NULL,
	"push_token" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"provider" "mail_provider" NOT NULL,
	"auth_type" "mail_auth_type" NOT NULL,
	"imap_host" text NOT NULL,
	"imap_port" integer NOT NULL,
	"imap_secure" boolean DEFAULT true NOT NULL,
	"smtp_host" text NOT NULL,
	"smtp_port" integer NOT NULL,
	"smtp_secure" boolean DEFAULT false NOT NULL,
	"username" text NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"status" "mail_account_status" DEFAULT 'active' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"delimiter" text,
	"special_use" "mailbox_special_use",
	"uid_validity" bigint,
	"uid_next" bigint,
	"highest_modseq" bigint,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_mailboxes" (
	"mailbox_id" uuid NOT NULL,
	"uid" bigint NOT NULL,
	"message_id" uuid NOT NULL,
	"modseq" bigint,
	CONSTRAINT "message_mailboxes_mailbox_id_uid_pk" PRIMARY KEY("mailbox_id","uid")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"provider_message_id" text,
	"thread_key" text NOT NULL,
	"message_id_header" text,
	"in_reply_to" text,
	"references" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"from" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reply_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	"snippet" text DEFAULT '' NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"body_text" text,
	"body_html" text,
	"body_fetched_at" timestamp with time zone,
	"seen" boolean DEFAULT false NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"answered" boolean DEFAULT false NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "outbox_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mailboxes" ADD CONSTRAINT "message_mailboxes_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mailboxes" ADD CONSTRAINT "message_mailboxes_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_message_idx" ON "attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "changes_user_seq_idx" ON "changes" USING btree ("user_id","seq");--> statement-breakpoint
CREATE INDEX "devices_user_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_accounts_user_email_idx" ON "mail_accounts" USING btree ("user_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_account_path_idx" ON "mailboxes" USING btree ("account_id","path");--> statement-breakpoint
CREATE INDEX "message_mailboxes_message_idx" ON "message_mailboxes" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_account_provider_id_idx" ON "messages" USING btree ("account_id","provider_message_id");--> statement-breakpoint
CREATE INDEX "messages_account_thread_idx" ON "messages" USING btree ("account_id","thread_key");--> statement-breakpoint
CREATE INDEX "messages_account_received_idx" ON "messages" USING btree ("account_id","received_at");--> statement-breakpoint
CREATE INDEX "messages_message_id_header_idx" ON "messages" USING btree ("message_id_header");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_account_idempotency_idx" ON "outbox" USING btree ("account_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "outbox_status_run_after_idx" ON "outbox" USING btree ("status","run_after");