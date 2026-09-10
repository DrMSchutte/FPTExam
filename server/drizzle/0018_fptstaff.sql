-- Block 6: FPTStaff connection - when a person was last synced, and the FPTStaff section a cohort mirrors.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "fptstaff_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cohorts" ADD COLUMN IF NOT EXISTS "fptstaff_section_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cohorts_fptstaff_section" ON "cohorts" ("fptstaff_section_id");
