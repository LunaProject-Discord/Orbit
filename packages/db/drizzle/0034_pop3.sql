ALTER TYPE "public"."mail_protocol" ADD VALUE 'pop3';--> statement-breakpoint
CREATE TABLE "message_sources" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"raw" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pop_messages" (
	"account_id" uuid NOT NULL,
	"uidl" text NOT NULL,
	"message_id" uuid,
	"downloaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pop_messages_account_id_uidl_pk" PRIMARY KEY("account_id","uidl")
);
--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "pop_leave_on_server" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "pop_delete_after_days" integer;--> statement-breakpoint
ALTER TABLE "message_sources" ADD CONSTRAINT "message_sources_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pop_messages" ADD CONSTRAINT "pop_messages_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pop_messages" ADD CONSTRAINT "pop_messages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pop_messages_message_idx" ON "pop_messages" USING btree ("message_id");