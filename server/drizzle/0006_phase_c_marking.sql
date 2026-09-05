CREATE TABLE IF NOT EXISTS "fptstaff_result_pushes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"fptstaff_ack" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ai_response_reviews" ADD COLUMN "gap_map" jsonb;--> statement-breakpoint
ALTER TABLE "ai_response_reviews" ADD COLUMN "suggested_outcome" text;--> statement-breakpoint
ALTER TABLE "ai_response_reviews" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "assessor_decisions" ADD COLUMN "overall_feedback" text;--> statement-breakpoint
ALTER TABLE "assessor_decisions" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "assessor_decisions" ADD COLUMN "total_mark" integer;--> statement-breakpoint
ALTER TABLE "assessor_decisions" ADD COLUMN "total_max" integer;--> statement-breakpoint
ALTER TABLE "assessor_decisions" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fptstaff_result_pushes" ADD CONSTRAINT "fptstaff_result_pushes_session_id_learner_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."learner_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_assessor_decisions_session" ON "assessor_decisions" USING btree ("session_id");