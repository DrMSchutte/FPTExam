-- Block 8b: full recording - one-minute video segments of camera and screen, indexed here, bytes in object storage.
CREATE TABLE IF NOT EXISTS "recording_segments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "learner_sessions"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "seq" integer NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "duration_ms" integer NOT NULL,
  "bytes" integer NOT NULL,
  "mime" text NOT NULL,
  "storage_key" text NOT NULL,
  "sha256" text NOT NULL,
  "after_seal" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_recording_segments_session_kind_seq" ON "recording_segments" ("session_id", "kind", "seq");
