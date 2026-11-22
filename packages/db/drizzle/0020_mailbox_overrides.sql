ALTER TABLE "mailboxes" ADD COLUMN "detected_special_use" "mailbox_special_use";--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "role_override" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "color" text;--> statement-breakpoint
-- これまでの役割は、すべてメールサーバーが知らせてきたもの。
UPDATE "mailboxes" SET "detected_special_use" = "special_use";
