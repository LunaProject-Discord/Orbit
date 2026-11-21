ALTER TABLE "mailboxes" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_parent_id_mailboxes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mailboxes_parent_idx" ON "mailboxes" USING btree ("parent_id");