ALTER TYPE "public"."outbox_kind" ADD VALUE 'mailbox_create';--> statement-breakpoint
ALTER TYPE "public"."outbox_kind" ADD VALUE 'mailbox_rename';--> statement-breakpoint
ALTER TYPE "public"."outbox_kind" ADD VALUE 'mailbox_delete';