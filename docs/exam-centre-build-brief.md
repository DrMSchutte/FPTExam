# FPT Exam — Engineering Build Brief

**Purpose:** this is the code-ready companion to `exam-centre-spec.md`. That document explains *what* to build and *why* (roles, QCTO/POPIA compliance, exam lifecycle). This document commits to concrete technology choices, schema, API surface, and a phased task list so it can be pasted directly into Replit's Agent (or handed to a developer) to start building. Where the spec said "either/or," this document picks one, so there's nothing left ambiguous for a coding agent to guess at.

---

## 1. Locked-in Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + Vite + TypeScript, Tailwind CSS | Fast dev loop on Replit, one language across the stack |
| Backend | Node.js + Express + TypeScript | Same runtime as frontend; easy WebSocket support |
| Realtime | `ws` (native WebSocket) or Socket.IO | Live invigilation feed (flags, presence) |
| Database | PostgreSQL, accessed via Drizzle ORM | Replit's built-in Postgres for dev; point `DATABASE_URL` at Neon/Supabase for a production instance that outlives the Repl |
| Object storage (video/screenshots) | Cloudflare R2 (S3-compatible) | Cheap egress, S3 SDK compatible, region choice available for POPIA cross-border considerations |
| Background jobs | Postgres-backed job table + a polling worker process | Avoids adding Redis as a dependency; simplest thing that works on Replit |
| Auth | JWT session cookies + bcrypt password hashing + TOTP-based MFA (e.g. `otplib`) for Administrator/Assessor/Moderator/Head QA/Invigilator roles | No external auth provider dependency; MFA required for every role except Learner |
| AI engines | Anthropic API (Claude) called from backend jobs | Vision-capable for screenshot review; structured JSON output for both engines |

Environment variables / Replit Secrets needed: `DATABASE_URL`, `JWT_SECRET`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `ANTHROPIC_API_KEY`, `APP_BASE_URL`.

## 2. Repository Structure

```
/client                      React app
  /src
    /routes
      /admin                 exam setup, instrument intake, user registration
      /learner               exam-taking UI, pre-checks, consent
      /invigilator           live console (video wall, flag feed, actions)
      /assessor              marking screen (submission + AI dossier + sign-off)
      /moderator             review + confirm/refer
      /headqa                cohort release, audit trail viewer
    /components
    /lib                     api client, websocket client, auth context
/server
  /src
    /routes                  Express routers, one per resource (see Section 4)
    /db                       Drizzle schema + migrations
    /jobs                     background workers (ai-integrity, ai-response-review, retention-sweep)
    /realtime                 WebSocket server, invigilation channel
    /storage                  R2 client wrapper (upload chunk, seal+hash, signed read URLs)
    /auth                     JWT issuance, RBAC middleware, MFA
    /ai                       prompt builders + response parsers for both engines
  index.ts
/shared
  types.ts                    TypeScript types shared by client and server (mirrors DB schema)
```

## 3. Database Schema (PostgreSQL DDL)

```sql
CREATE TYPE user_role AS ENUM ('administrator','learner','invigilator','assessor','moderator','head_qa');
CREATE TYPE employment_relationship AS ENUM ('internal','external');
CREATE TYPE qcto_registration_type AS ENUM ('fisa','eisa');
CREATE TYPE instrument_source AS ENUM ('manual','curricula_builder');
CREATE TYPE session_status AS ENUM ('scheduled','checked_in','in_progress','submitted','sealed');
CREATE TYPE capture_type AS ENUM ('screenshot','full_recording_chunk','system_event');
CREATE TYPE incident_raised_by AS ENUM ('system','invigilator');
CREATE TYPE moderation_decision AS ENUM ('confirmed','referred');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  mfa_secret TEXT,
  id_number_hash TEXT,
  photo_reference TEXT,
  employment_relationship employment_relationship,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role user_role NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE TABLE qualifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  qcto_registration_type qcto_registration_type NOT NULL,
  aqp_reference TEXT
);

CREATE TABLE assessment_instruments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  qualification_id UUID NOT NULL REFERENCES qualifications(id),
  version TEXT NOT NULL,
  questions JSONB NOT NULL,              -- array of {id, type, prompt, max_mark, model_answer/rubric_criteria}
  time_allocation_minutes INT NOT NULL,
  permitted_materials JSONB DEFAULT '[]',
  pass_mark_or_competency_rule JSONB,
  source instrument_source NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE exam_sittings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  qualification_id UUID NOT NULL REFERENCES qualifications(id),
  instrument_id UUID NOT NULL REFERENCES assessment_instruments(id),
  cohort_id UUID NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  proctoring_profile JSONB NOT NULL,     -- {capture_interval_seconds, full_recording_enabled, lockdown_level, breaks_allowed}
  assigned_assessor_id UUID NOT NULL REFERENCES users(id),
  independent_invigilation_required BOOLEAN NOT NULL DEFAULT false,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sitting_invigilators (
  sitting_id UUID NOT NULL REFERENCES exam_sittings(id) ON DELETE CASCADE,
  invigilator_id UUID NOT NULL REFERENCES users(id),
  PRIMARY KEY (sitting_id, invigilator_id)
);

CREATE TABLE consent_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learner_id UUID NOT NULL REFERENCES users(id),
  sitting_id UUID NOT NULL REFERENCES exam_sittings(id),
  consent_text_version TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address TEXT
);

CREATE TABLE learner_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sitting_id UUID NOT NULL REFERENCES exam_sittings(id),
  learner_id UUID NOT NULL REFERENCES users(id),
  consent_record_id UUID REFERENCES consent_records(id),
  status session_status NOT NULL DEFAULT 'scheduled',
  check_in_time TIMESTAMPTZ,
  submission_time TIMESTAMPTZ,
  answers JSONB,                          -- learner's submitted responses, keyed by question id
  UNIQUE (sitting_id, learner_id)
);

CREATE TABLE capture_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES learner_sessions(id) ON DELETE CASCADE,
  type capture_type NOT NULL,
  storage_ref TEXT NOT NULL,              -- R2 object key
  sha256_hash TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_capture_events_session ON capture_events(session_id);

CREATE TABLE incident_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES learner_sessions(id) ON DELETE CASCADE,
  raised_by incident_raised_by NOT NULL,
  raised_by_user_id UUID REFERENCES users(id),
  type TEXT NOT NULL,                     -- e.g. face_not_visible, multiple_faces, tab_switch, terminated
  evidence_capture_event_id UUID REFERENCES capture_events(id),
  action_taken TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_integrity_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES learner_sessions(id) ON DELETE CASCADE,
  findings JSONB NOT NULL,                -- array of {timestamp, type, evidence_ref, note}
  overall_recommendation TEXT,            -- 'no_concerns' | 'minor_note' | 'flag_for_investigation'
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_response_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES learner_sessions(id) ON DELETE CASCADE,
  per_question_suggestions JSONB NOT NULL, -- array of {question_id, suggested_mark, criteria_matched[], criteria_missed[], confidence}
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE assessor_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES learner_sessions(id) ON DELETE CASCADE,
  assessor_id UUID NOT NULL REFERENCES users(id),
  per_criterion_marks JSONB NOT NULL,
  ai_suggestions_review JSONB NOT NULL,    -- array of {question_id, decision: accepted/edited/overridden, reason}
  signed_off_at TIMESTAMPTZ
);

CREATE TABLE moderation_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES learner_sessions(id),
  cohort_id UUID,
  decision moderation_decision NOT NULL,
  notes TEXT,
  moderator_id UUID NOT NULL REFERENCES users(id),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE result_releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id UUID NOT NULL,
  released_by UUID NOT NULL REFERENCES users(id),
  released_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id UUID,
  reason TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE background_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type TEXT NOT NULL,                 -- 'ai_integrity' | 'ai_response_review' | 'retention_sweep'
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed
  attempts INT NOT NULL DEFAULT 0,
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## 4. API Surface (REST, grouped by role)

All routes under `/api`. Every route enforces RBAC middleware; the table only calls out the primary role, but Head QA has read access to everything.

**Auth** — `POST /auth/login`, `POST /auth/mfa/verify`, `POST /auth/logout`

**Administrator**
- `POST /users` — register a new user with role(s)
- `GET /users`, `PATCH /users/:id`
- `POST /qualifications`, `POST /instruments` (manual intake) / `POST /instruments/import` (v2, Curricula Builder)
- `POST /sittings`, `PATCH /sittings/:id`, `POST /sittings/:id/assign-learners`
- `GET /audit-log`

**Learner**
- `GET /me/sittings`
- `POST /sittings/:id/consent`
- `POST /sittings/:id/precheck` (device/camera/mic check result)
- `POST /sessions/:id/check-in`
- `GET /sessions/:id/paper`, `POST /sessions/:id/answers` (autosave), `POST /sessions/:id/submit`
- `GET /me/recordings/:sessionId` (data-subject access request)

**Invigilator**
- `GET /sittings/:id/live` (initial state; live updates over WebSocket)
- `POST /sessions/:id/verify-identity`
- `POST /sessions/:id/incident` (pause / message / terminate, with reason)

**Assessor**
- `GET /sessions/:id/dossier` (submission + AI integrity report + AI response review)
- `POST /sessions/:id/decision` (marks + per-suggestion accept/edit/override)
- `POST /sessions/:id/sign-off`

**Moderator**
- `GET /cohorts/:id/results`
- `POST /sessions/:id/moderate` (confirmed / referred + notes)

**Head QA**
- `GET /cohorts/:id/audit-trail`
- `POST /cohorts/:id/release`
- `POST /sessions/:id/hold`

**Capture ingestion (learner client → server, during a live session)**
- `POST /sessions/:id/capture` (multipart chunk upload: screenshot or recording segment; server computes hash, streams to R2, writes `capture_events` row)

**WebSocket channel** `/ws/invigilation/:sittingId` — server pushes `presence_flag`, `tab_switch`, `incident_raised`, `session_status_changed` events to connected Invigilator/Assessor clients.

## 5. Core Workflow Logic (implement as described, not just as data shapes)

**5.1 Sign-off gate (hard rule, enforce in code, not just UI)**
A `learner_session`'s result is never visible to a Learner or included in a `result_release` unless: (a) `assessor_decisions.signed_off_at IS NOT NULL` for that session, and (b) a `moderation_records` row exists with `decision = 'confirmed'` (or the session is outside this cohort's sampling requirement, per the qualification's moderation policy). Enforce this as a DB check in the release query, not just as a workflow suggestion in the UI — an Administrator or a bug should not be able to bypass it.

**5.2 Capture loop (client-side)**
On session start: request camera + screen permissions once; run a `setInterval` at `proctoring_profile.capture_interval_seconds` that grabs a canvas snapshot of the screen-share stream and a webcam frame, and `POST`s both to `/sessions/:id/capture`. Additionally attach `visibilitychange`, `blur`, and `paste` event listeners that immediately fire an out-of-band capture + a `tab_switch`/`paste` WebSocket event. If `full_recording_enabled`, also start `MediaRecorder` on both streams with a short `timeslice` (e.g. 5s) so chunks are emitted and uploaded continuously rather than buffered until the end.

**5.3 Seal + hash on submission**
On `POST /sessions/:id/submit`: mark the session `sealed`, compute a SHA-256 over the ordered list of that session's `capture_events` hashes (a simple hash-chain), and store it on the session row. Reject any further `POST /sessions/:id/capture` for a sealed session — this is what makes the evidence defensible later.

**5.4 AI job trigger**
On seal, insert two `background_jobs` rows (`ai_integrity`, `ai_response_review`) with `payload = { session_id }`. A worker process polls `background_jobs` for `status = 'pending' AND run_after <= now()`, marks `running`, calls the relevant AI prompt (Section 6), writes the result row, and marks `done` (or `failed` with a retry after backoff).

**5.5 Retention sweep**
A daily `retention_sweep` job finds sessions past the configured retention window (Section 10 of the spec) with no active hold, deletes their R2 objects, and nulls out `capture_events.storage_ref`/`answers` while keeping the row shell (so the audit trail — that a session existed, was marked, was moderated — survives deletion of the underlying media, which is what POPIA's "delete when no longer needed" actually requires while still leaving a defensible audit record).

## 6. AI Engine Prompts (structure, not literal final copy)

Both engines call the Anthropic API with a JSON-schema-constrained response (use tool-use / structured output, not free text parsing).

**Integrity Engine input:** the session's capture event list (screenshots as images, event log as JSON) + the sitting's proctoring profile.
**Integrity Engine output schema:**
```json
{
  "findings": [
    {"timestamp": "ISO8601", "type": "tab_switch|face_not_visible|multiple_faces|other", "evidence_capture_event_id": "uuid", "note": "plain language"}
  ],
  "overall_recommendation": "no_concerns|minor_note|flag_for_investigation",
  "summary": "plain language paragraph"
}
```

**Response-Review Engine input:** the `assessment_instruments.questions` (including rubric/model answers) + the learner's `learner_sessions.answers`.
**Response-Review Engine output schema:**
```json
{
  "per_question": [
    {"question_id": "...", "suggested_mark": 0, "max_mark": 0, "criteria_matched": ["..."], "criteria_missed": ["..."], "confidence": "low|medium|high", "rationale": "plain language"}
  ]
}
```

Both outputs are stored verbatim and rendered read-only in the Assessor's dossier screen — the Assessor's own `assessor_decisions.per_criterion_marks` is a separate, independently-editable field; never overwrite AI suggestions with the Assessor's edits, so both remain visible for the audit trail.

## 7. Phased Build Order (task list to hand to a coding agent)

1. Scaffold repo structure (Section 2), set up Drizzle + Postgres connection, run the DDL (Section 3).
2. Auth: registration (Administrator-only), login, JWT + MFA, RBAC middleware.
3. Administrator screens: qualifications, manual instrument intake, sitting creation, user registration, learner assignment.
4. Learner flow without proctoring: view assigned sitting, see paper, submit answers, autosave — get the core exam-taking loop working end to end first.
5. Add consent + identity verification (photo capture, ID document upload) and pre-checks before check-in is allowed.
6. Add capture loop (Section 5.2): screenshot interval, event-triggered captures, upload to R2, seal + hash on submit (Section 5.3).
7. Build the Invigilator live console: WebSocket channel, video wall, flag feed, incident actions.
8. Build the Assessor dossier screen (submission only, no AI yet) and the sign-off gate (Section 5.1).
9. Wire up background job table + worker process; implement the two AI engines (Section 6) and render their output read-only in the Assessor dossier.
10. Build Moderator and Head QA screens: moderation queue, audit trail viewer, cohort release (respecting the sign-off gate).
11. Add retention sweep job and the Learner-facing data-subject access/deletion request flow.
12. Replace manual instrument intake with a Curricula Builder API integration once that system exists — everything downstream already reads from the same `assessment_instruments` table, so this is additive.

Build and verify each phase against the roles/permission matrix and the exam lifecycle in `exam-centre-spec.md` before moving to the next — in particular, don't let Phase 9's AI output become visible anywhere a Learner or Moderator could mistake it for an actual result.
