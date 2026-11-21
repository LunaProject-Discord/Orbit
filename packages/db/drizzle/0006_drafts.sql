CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"to" jsonb NOT NULL,
	"cc" jsonb NOT NULL,
	"bcc" jsonb NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"html" text DEFAULT '' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mode" text DEFAULT 'new' NOT NULL,
	"source_message_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"synced_revision" integer,
	"remote_message_id" text,
	"remote_mailbox_path" text,
	"remote_uid" bigint,
	"remote_uid_validity" bigint,
	"remote_provider_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drafts_user_updated_idx" ON "drafts" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "drafts_account_idx" ON "drafts" USING btree ("account_id");