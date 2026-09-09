-- Block 3: sitting series, venue/capacity per sitting, assessor scope and marking cap.
CREATE TABLE IF NOT EXISTS "sitting_series" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "qualification_id" uuid NOT NULL REFERENCES "qualifications"("id"),
  "instrument_id" uuid NOT NULL REFERENCES "assessment_instruments"("id"),
  "cohort_id" uuid REFERENCES "cohorts"("id") ON DELETE SET NULL,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assessor_scopes" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "qualification_id" uuid NOT NULL REFERENCES "qualifications"("id") ON DELETE CASCADE,
  CONSTRAINT "assessor_scopes_user_id_qualification_id_pk" PRIMARY KEY ("user_id", "qualification_id")
);--> statement-breakpoint
ALTER TABLE "exam_sittings" ADD COLUMN IF NOT EXISTS "series_id" uuid REFERENCES "sitting_series"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "exam_sittings" ADD COLUMN IF NOT EXISTS "venue" text;--> statement-breakpoint
ALTER TABLE "exam_sittings" ADD COLUMN IF NOT EXISTS "capacity" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "marking_cap" integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exam_sittings_start_idx" ON "exam_sittings" ("start_time");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exam_sittings_series_idx" ON "exam_sittings" ("series_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learner_sessions_sitting_idx" ON "learner_sessions" ("sitting_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assessor_decisions_signed_off_idx" ON "assessor_decisions" ("signed_off_at");
