ALTER TABLE "result_releases" ALTER COLUMN "cohort_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "result_releases" ALTER COLUMN "released_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "result_releases" ADD COLUMN "session_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "result_releases" ADD CONSTRAINT "result_releases_session_id_learner_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."learner_sessions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
