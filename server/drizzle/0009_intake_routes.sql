DO $$ BEGIN
 CREATE TYPE "public"."intake_route" AS ENUM('qcto_curricula_builder', 'legacy_saqa', 'built_here', 'curricula_builder_other');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TYPE "qcto_registration_type" ADD VALUE 'non_qcto';--> statement-breakpoint
ALTER TABLE "assessment_instruments" ADD COLUMN "intake_route" "intake_route";--> statement-breakpoint
-- Papers that already exist entered before the route rule (9 Sep 2026). Papers drafted
-- from SAQA were the legacy-FISA route; anything linked from Curricula Builder was the
-- QCTO route; everything else (manual, uploaded, drafted from a document) was built here.
UPDATE "assessment_instruments" SET "intake_route" = CASE
  WHEN "source" = 'ai_generated' THEN 'legacy_saqa'::"intake_route"
  WHEN "source" = 'curricula_builder' THEN 'qcto_curricula_builder'::"intake_route"
  ELSE 'built_here'::"intake_route" END;--> statement-breakpoint
ALTER TABLE "assessment_instruments" ALTER COLUMN "intake_route" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_instruments" ADD COLUMN "external_ref" text;
