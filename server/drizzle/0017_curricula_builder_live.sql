-- Block 7: a paper superseded by a newer Curricula Builder version points at it.
ALTER TABLE "assessment_instruments" ADD COLUMN IF NOT EXISTS "superseded_by_id" uuid REFERENCES "assessment_instruments"("id");
