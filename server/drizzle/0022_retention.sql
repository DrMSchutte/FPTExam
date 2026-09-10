-- Block 8a: evidence retention. Captures and recordings are deleted 12 months
-- after the sitting unless it is on hold; the hashes stay so the seal can
-- still be verified.
ALTER TABLE "exam_sittings" ADD COLUMN IF NOT EXISTS "evidence_hold_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "exam_sittings" ADD COLUMN IF NOT EXISTS "evidence_hold_reason" text;--> statement-breakpoint
ALTER TABLE "exam_sittings" ADD COLUMN IF NOT EXISTS "evidence_purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learner_sessions" ADD COLUMN IF NOT EXISTS "evidence_hold_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learner_sessions" ADD COLUMN IF NOT EXISTS "evidence_hold_reason" text;--> statement-breakpoint
ALTER TABLE "recording_segments" ADD COLUMN IF NOT EXISTS "purged_at" timestamp with time zone;
