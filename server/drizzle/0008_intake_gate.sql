DO $$ BEGIN
 CREATE TYPE "public"."intake_status" AS ENUM('checking', 'ready', 'blocked', 'override');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TYPE "instrument_source" ADD VALUE 'uploaded_paper';--> statement-breakpoint
ALTER TABLE "assessment_instruments" ADD COLUMN "intake_status" "intake_status" DEFAULT 'checking' NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_instruments" ADD COLUMN "intake_override_reason" text;--> statement-breakpoint
ALTER TABLE "assessment_instruments" ADD COLUMN "source_files" jsonb;--> statement-breakpoint
-- Papers that already exist were usable before the gate existed: keep them usable
-- unless their standard check already says they do not meet the standard.
UPDATE "assessment_instruments" SET "intake_status" = CASE WHEN "quality_review"->>'verdict' = 'does_not_meet' THEN 'blocked'::"intake_status" ELSE 'ready'::"intake_status" END;
