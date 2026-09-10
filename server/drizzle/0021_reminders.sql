-- Block 8e: the reminders the system sends (or would send, when email is not
-- connected yet). dedupe_key makes each reminder once-only.
CREATE TABLE IF NOT EXISTS "notification_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "dedupe_key" text NOT NULL,
  "to_user_id" uuid,
  "to_email" text NOT NULL,
  "subject" text NOT NULL,
  "body" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "detail" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sent_at" timestamp with time zone
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_to_user_id_users_id_fk"
    FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_notification_log_kind_key" ON "notification_log" ("kind","dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_log_created" ON "notification_log" ("created_at");
