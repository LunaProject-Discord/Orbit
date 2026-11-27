CREATE TYPE "public"."event_conflict_kind" AS ENUM('field_lost', 'write_failed', 'create_failed', 'remote_deleted', 'delete_cancelled');--> statement-breakpoint
CREATE TABLE "event_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" "event_conflict_kind" NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lost" jsonb,
	"snapshot" jsonb,
	"title" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "event_conflicts" ADD CONSTRAINT "event_conflicts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_conflicts" ADD CONSTRAINT "event_conflicts_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_conflicts_user_open_idx" ON "event_conflicts" USING btree ("user_id","created_at") WHERE "event_conflicts"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "event_conflicts_created_idx" ON "event_conflicts" USING btree ("created_at");--> statement-breakpoint
-- changes_delete_entity_idx (changes の削除の部分索引) はここでは作らない。changes は全利用者のメールの
-- 同期も書き込む大きな表で、CONCURRENTLY なしに作ると作っている間、書き込みが待たされる。
-- 同期ワーカーが起動時に CREATE INDEX CONCURRENTLY で作る (apps/worker/src/changes-index.ts)。
-- 索引が無い間も、予定の POST の再送の確かめは正しく動く (遅いだけ)。