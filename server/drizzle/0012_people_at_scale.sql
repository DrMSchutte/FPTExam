DO $$ BEGIN
 CREATE TYPE "public"."user_status" AS ENUM('invited', 'active', 'suspended', 'archived');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "id_number_enc" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "id_number_last4" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "student_number" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "registration_number" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" "user_status" DEFAULT 'invited' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_student_number_unique" UNIQUE("student_number");--> statement-breakpoint
-- Accounts that already exist could sign in before statuses existed: they are active.
UPDATE "users" SET "status" = 'active', "activated_at" = COALESCE("activated_at", "created_at");--> statement-breakpoint
-- Search and paging at tens of thousands of rows (build plan Block 1).
CREATE INDEX IF NOT EXISTS "users_name_lower_idx" ON "users" (lower("name"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_email_lower_idx" ON "users" (lower("email"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_status_idx" ON "users" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_id_last4_idx" ON "users" ("id_number_last4");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_created_at_idx" ON "users" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_roles_role_idx" ON "user_roles" ("role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learner_sessions_learner_idx" ON "learner_sessions" ("learner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exam_sittings_assessor_idx" ON "exam_sittings" ("assigned_assessor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sitting_invigilators_invigilator_idx" ON "sitting_invigilators" ("invigilator_id");
