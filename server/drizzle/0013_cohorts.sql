-- Block 2: cohorts as the working unit for students; the ID number as the unique
-- student identifier (decision 1, 9 Sep 2026).
DO $$ BEGIN
  CREATE TYPE "cohort_status" AS ENUM ('active', 'closed');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cohorts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "qualification_id" uuid REFERENCES "qualifications"("id"),
  "site" text,
  "intake" text,
  "notes" text,
  "status" "cohort_status" NOT NULL DEFAULT 'active',
  "external_ref" text,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cohort_members" (
  "cohort_id" uuid NOT NULL REFERENCES "cohorts"("id") ON DELETE CASCADE,
  "learner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "added_by" uuid REFERENCES "users"("id"),
  "added_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "cohort_members_cohort_id_learner_id_pk" PRIMARY KEY ("cohort_id", "learner_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cohort_members_learner_idx" ON "cohort_members" ("learner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cohorts_name_lower_idx" ON "cohorts" (lower("name"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cohorts_qualification_idx" ON "cohorts" ("qualification_id");--> statement-breakpoint
-- Sittings: cohort_id becomes an optional reference. Earlier sittings carried a
-- placeholder uuid per sitting; those are cleared.
ALTER TABLE "exam_sittings" ALTER COLUMN "cohort_id" DROP NOT NULL;--> statement-breakpoint
UPDATE "exam_sittings" SET "cohort_id" = NULL WHERE "cohort_id" IS NOT NULL AND "cohort_id" NOT IN (SELECT "id" FROM "cohorts");--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "exam_sittings" ADD CONSTRAINT "exam_sittings_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "cohorts"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
ALTER TABLE "exam_sittings" ADD COLUMN IF NOT EXISTS "name" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exam_sittings_cohort_idx" ON "exam_sittings" ("cohort_id");--> statement-breakpoint
-- The ID number is the unique student identifier: one person per ID number.
CREATE UNIQUE INDEX IF NOT EXISTS "users_id_number_hash_uq" ON "users" ("id_number_hash") WHERE "id_number_hash" IS NOT NULL;
