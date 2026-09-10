-- Papers can be retired (kept for the sittings written on them, never scheduled again).
ALTER TABLE "assessment_instruments" ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assessment_instruments" ADD COLUMN IF NOT EXISTS "retire_reason" text;
