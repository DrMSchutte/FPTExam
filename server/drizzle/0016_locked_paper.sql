-- Block 5b: the locked paper - start time, extra time, live proctoring state.
ALTER TABLE "learner_sessions" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learner_sessions" ADD COLUMN IF NOT EXISTS "extra_minutes" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "learner_sessions" ADD COLUMN IF NOT EXISTS "proctoring" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learner_sessions_status_idx" ON "learner_sessions" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_incident_log_session" ON "incident_log" ("session_id");
