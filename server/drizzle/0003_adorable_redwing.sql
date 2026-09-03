ALTER TYPE "instrument_source" ADD VALUE 'qcto_upload';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "qcto_document_extracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"qualification_id" uuid NOT NULL,
	"original_filename" text NOT NULL,
	"exit_level_outcomes" jsonb NOT NULL,
	"assessment_criteria" jsonb NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assessment_instruments" ADD COLUMN "qcto_extract_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "qcto_document_extracts" ADD CONSTRAINT "qcto_document_extracts_qualification_id_qualifications_id_fk" FOREIGN KEY ("qualification_id") REFERENCES "public"."qualifications"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assessment_instruments" ADD CONSTRAINT "assessment_instruments_qcto_extract_id_qcto_document_extracts_id_fk" FOREIGN KEY ("qcto_extract_id") REFERENCES "public"."qcto_document_extracts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
