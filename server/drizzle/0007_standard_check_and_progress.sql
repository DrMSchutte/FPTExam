ALTER TABLE "assessment_instruments" ADD COLUMN "quality_review" jsonb;--> statement-breakpoint
ALTER TABLE "assessment_instruments" ADD COLUMN "quality_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "background_jobs" ADD COLUMN "progress" jsonb;--> statement-breakpoint
ALTER TABLE "qualifications" ADD COLUMN "nqf_level" integer;--> statement-breakpoint
ALTER TABLE "saqa_qualification_extracts" ADD COLUMN "nqf_level" integer;