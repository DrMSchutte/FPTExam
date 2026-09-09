-- Block 5a: one-time sitting codes, pre-check state, evidence storage.
ALTER TYPE "capture_type" ADD VALUE IF NOT EXISTS 'identity_photo';--> statement-breakpoint
ALTER TYPE "capture_type" ADD VALUE IF NOT EXISTS 'photo';--> statement-breakpoint
ALTER TYPE "capture_type" ADD VALUE IF NOT EXISTS 'screen';--> statement-breakpoint
ALTER TYPE "capture_type" ADD VALUE IF NOT EXISTS 'focus_loss';--> statement-breakpoint
ALTER TABLE "learner_sessions" ADD COLUMN IF NOT EXISTS "code_enc" text;--> statement-breakpoint
ALTER TABLE "learner_sessions" ADD COLUMN IF NOT EXISTS "code_hash" text;--> statement-breakpoint
ALTER TABLE "learner_sessions" ADD COLUMN IF NOT EXISTS "code_issued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learner_sessions" ADD COLUMN IF NOT EXISTS "entries" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "learner_sessions" ADD COLUMN IF NOT EXISTS "reentry_allowed" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "learner_sessions" ADD COLUMN IF NOT EXISTS "precheck" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "learner_sessions_code_hash_uq" ON "learner_sessions" ("code_hash") WHERE "code_hash" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evidence_blobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "learner_sessions"("id") ON DELETE CASCADE,
  "kind" "capture_type" NOT NULL,
  "mime" text NOT NULL,
  "bytes" bytea NOT NULL,
  "sha256" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_evidence_blobs_session" ON "evidence_blobs" ("session_id");
