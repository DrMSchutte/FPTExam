ALTER TYPE "instrument_source" ADD VALUE 'ai_generated';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "saqa_qualification_extracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"qualification_id" uuid NOT NULL,
	"saqa_qualification_id" text NOT NULL,
	"exit_level_outcomes" jsonb NOT NULL,
	"assessment_criteria" jsonb NOT NULL,
	"source_url" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assessment_instruments" ADD COLUMN "saqa_extract_id" uuid;--> statement-breakpoint
ALTER TABLE "qualifications" ADD COLUMN "saqa_qualification_id" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "saqa_qualification_extracts" ADD CONSTRAINT "saqa_qualification_extracts_qualification_id_qualifications_id_fk" FOREIGN KEY ("qualification_id") REFERENCES "public"."qualifications"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assessment_instruments" ADD CONSTRAINT "assessment_instruments_saqa_extract_id_saqa_qualification_extracts_id_fk" FOREIGN KEY ("saqa_extract_id") REFERENCES "public"."saqa_qualification_extracts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
