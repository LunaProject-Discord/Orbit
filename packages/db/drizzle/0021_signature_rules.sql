CREATE TABLE "signature_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"account_id" uuid,
	"key" text NOT NULL,
	"label" text,
	"signature_html" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signature_rules" ADD CONSTRAINT "signature_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_rules" ADD CONSTRAINT "signature_rules_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "signature_rules_contact_idx" ON "signature_rules" USING btree ("user_id","key") WHERE "signature_rules"."kind" = 'contact';--> statement-breakpoint
CREATE UNIQUE INDEX "signature_rules_thread_idx" ON "signature_rules" USING btree ("account_id","key") WHERE "signature_rules"."kind" = 'thread';--> statement-breakpoint
CREATE INDEX "signature_rules_user_idx" ON "signature_rules" USING btree ("user_id");