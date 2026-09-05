# FPT Exam — Engineering Build Brief

**Purpose:** this is the code-ready companion to `exam-centre-spec.md`. That document explains *what* to build and *why* (roles, QCTO/POPIA compliance, exam lifecycle). This document commits to concrete technology choices, schema, API surface, and workflow logic so it can be handed to a developer (or Replit's Agent) with nothing left ambiguous. The phase plan lives in **`build-roadmap.md`**; the decision record behind the role model and sign-off gate is **`moderation-signoff-policy.md`**. Where this document and those two disagree, they win.

> **Revised 4 Sep 2026** to match the v2 spec: four roles (Moderator and Head QA removed — QA lives in FPTStaff), assessor-only sign-off, FPTStaff people/results integration designed in, deployment hardened.

## Build status (as of 2026-09-04)

Built and verified in the cloud sandbox (monorepo at `/home/claude/fpt-exam`, git history intact) and delivered to Melanie as `FPT_Exam_Scaffold.zip`, running on Replit:

- **Phase A — Foundation. Done.** Repo scaffold; full schema + migrations; login with JWT sessions, TOTP MFA, RBAC; Administrator area (qualifications with SAQA ID, instruments via manual entry / AI-from-SAQA / AI-from-uploaded-QCTO-document, sittings, learner assignment, user registration); Learner exam-taking (list → start → answer per type → autosave → submit). Verified end-to-end in a browser and in the database. AI-from-SAQA verified against a fixture and the live Anthropic API (the live `saqa.org.za` fetch itself needs Replit's network — the sandbox blocks it); AI-from-upload verified fully, including the AI refusing to fabricate outcomes from a cover-page-only document.
- **Phase B — Design & model alignment. Done.** FPT-branded design system (green/blue tokens, Manrope + Public Sans, sidebar shell, shared UI kit; light mode only). Roles cut to four; Moderator/Head QA dashboards and routes removed. New registration flow (type → FPTStaff dropdown, inactive until connected → add-details fallback → role pre-filled); `users.source` + `users.fptstaff_id` (migration 0004). Fourth "From Curricula Builder" instrument tab (disabled until its API exists). Deploy hardening: build tooling in `dependencies`; server runs migrations and creates the bootstrap admin idempotently on start-up. Verified via a full Playwright walkthrough including registering an external invigilator and seeing them offered under the independent-invigilation filter.
- **Built (Phase C, 4 Sep 2026):** Assessor workspace (marking queue, dossier, sign-off), Response-Review engine running as a polled background job on submit, the assessor-only result gate (`GET /sessions/:id/result` 404 until `signed_off_at`), FPTStaff result-push rows queued at sign-off (delivered in Phase E), audit entry per sign-off, learner result + feedback + gap-map view.
- **Built (5 Sep 2026):** Assessment Standard Check (§5.10) — every instrument carries a `quality_review`: coverage matrix of each ELO/AC → questions, Bloom's taxonomy distribution vs the NQF band, question-type/mark mix, per-question issues, recommendations, verdict; runs after AI drafting and on demand (`POST /instruments/:id/quality-check`). Generation labels each question with `bloomLevel` and `acRef`; SAQA extract records `nqf_level`. Long jobs report stage progress (`background_jobs.progress`) shown live in the UI. Instrument detail page at `/admin/instruments/:id`.
- **Not started:** Phase D (pre-checks, capture loop, seal/hash, Invigilator console, Integrity engine, R2, retention), Phase E (FPTStaff connection live), Phase F (Curricula Builder live). See `build-roadmap.md`.

---

## 1. Locked-in Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + Vite + TypeScript, Tailwind CSS | Fast dev loop on Replit, one language across the stack |
| Design system | FPT Academy tokens in `client/tailwind.config.js` (brand green `#6BBF3E`/`#4C9127`, blue `#2E86AB`, cool neutrals), Manrope (display) + Public Sans (body) via Google Fonts, shared primitives in `client/src/components/ui.tsx` + `@layer components` in `index.css`; **light mode only** (`color-scheme: light`, no `dark:` variants) | Matches the approved mockup; one place to change the look |
| Realtime | `ws` (native WebSocket) | Live invigilation feed (flags, presence) — Phase D |
| Database | PostgreSQL via Drizzle ORM | Replit's built-in Postgres; `DATABASE_URL` can point at Neon/Supabase for a longer-lived instance |
| Object storage (video/screenshots) | Cloudflare R2 (S3-compatible) — Phase D | Cheap egress, S3 SDK compatible, region choice for POPIA |
| Background jobs | Postgres-backed job table + polling worker — Phase C/D | No Redis dependency; simplest thing that works on Replit |
| Auth | JWT session cookies + bcrypt + TOTP MFA (`otplib`) for Administrator, Assessor, Invigilator; Learner uses a lighter flow | No external auth provider; MFA for every supervisory/result-affecting role |
| AI engines | Anthropic API (Claude), tool-use structured output | Instrument generation ×2 intake paths (built), document outcome extraction (built), Response-Review (Phase C), Integrity (Phase D) |
| Document text extraction | `pdf-parse` (PDF), `mammoth` (.docx) | QCTO-document-upload path; server-side, no external API |
| FPTStaff integration | Outbound HTTP client (people push, result push) + inbound people lookup, behind one connection setting — Phase E | FPTStaff is the system of record for people and QA (spec §4a) |

**Replit Secrets:** `DATABASE_URL` (normally set by Replit's Postgres), `JWT_SECRET`, `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ANTHROPIC_API_KEY`, `APP_BASE_URL`. Phase D adds `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`; Phase E adds the FPTStaff connection settings.

**Deployment rule (hard-won):** Replit runs with `NODE_ENV=production`, under which `npm install` skips `devDependencies`. Every build-time tool (typescript, vite, tsx, tailwind, postcss, type packages) therefore lives in **`dependencies`** in `client/package.json` and `server/package.json`. Do not move them back or the build fails with `tsc: not found`. Only `drizzle-kit` (migration *generation*, never needed at runtime) stays in devDependencies.

## 2. Repository Structure

```
/client                      React app
  /src
    /components/ui.tsx       shared design primitives (PageHeader, Card, Badge, Pill, Notice, …)
    /routes
      /admin                 AdminDashboard (sidebar shell + nested routes) → Overview, Qualifications, Instruments, Sittings, Users
      /learner               exam-taking UI (built); pre-checks + consent (Phase D)
      /invigilator           holding page now; live console (video wall, flag feed, actions) in Phase D
      /assessor              AssessorDashboard (shell) → AssessorQueue (queue / signed off), AssessorDossier (marking, AI review, gap map, sign-off)
      Login.tsx
    /lib                     api client (JSON + multipart), auth context, ProtectedRoute
  index.html                 Google Fonts link, color-scheme: light
  tailwind.config.js         FPT design tokens
/server
  /src
    /routes                  Express routers, one per resource (Section 4)
    /db
      schema.ts              Drizzle schema
      bootstrap.ts           runMigrations() + ensureBootstrapAdmin() — called on server start AND by the standalone scripts
      migrate.ts / seed.ts / reset-admin-password.ts
    /jobs/runner.ts          Postgres-polled worker: ai_response_review, fptstaff_push (built); ai_integrity, retention_sweep (Phase D)
    /realtime                WebSocket server, invigilation channel — Phase D
    /storage                 R2 client wrapper — Phase D
    /auth                    JWT issuance, RBAC middleware, MFA, password hashing
    /integrations
      /saqa                  SAQA qualification-page fetcher + ELO/AC parser (Section 5.6)
      /qcto                  uploaded QCTO document text extraction (Section 5.7)
      /fptstaff              people lookup / people push / result push — Phase E (Section 5.9)
    /ai                      prompt builders + parsers: instrumentGeneration, documentOutcomeExtraction, responseReview (built); integrity (Phase D)
  index.ts                   boots: migrations → bootstrap admin → listen; serves client/dist in production
/shared
  types.ts                   TypeScript types shared by client and server
/docs                        copies of the spec and this brief
```

## 3. Database Schema (PostgreSQL DDL)

Legacy note: the `user_role` enum still carries `'moderator'` and `'head_qa'`, and the `moderation_records` / `result_releases` tables and `moderation_decision` enum still exist, all from v1. They are **unused** and deliberately left in place — dropping Postgres enum values or tables is destructive for no gain. Nothing may read or write them.

```sql
CREATE TYPE user_role AS ENUM ('administrator','learner','invigilator','assessor','moderator','head_qa'); -- last two legacy, never assigned
CREATE TYPE user_source AS ENUM ('manual','fptstaff');
CREATE TYPE employment_relationship AS ENUM ('internal','external');
CREATE TYPE qcto_registration_type AS ENUM ('fisa','eisa');
CREATE TYPE instrument_source AS ENUM ('manual','ai_generated','curricula_builder','qcto_upload');
CREATE TYPE session_status AS ENUM ('scheduled','checked_in','in_progress','submitted','sealed');
CREATE TYPE capture_type AS ENUM ('screenshot','full_recording_chunk','system_event');
CREATE TYPE incident_raised_by AS ENUM ('system','invigilator');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  mfa_secret TEXT,
  id_number_hash TEXT,
  photo_reference TEXT,
  employment_relationship employment_relationship,
  source user_source NOT NULL DEFAULT 'manual',   -- how the record was created (spec §4a)
  fptstaff_id TEXT UNIQUE,                        -- the person's FPTStaff identifier once pulled from / pushed to FPTStaff
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
  aqp_reference TEXT,
  saqa_qualification_id TEXT               -- nullable; required only for the AI-from-SAQA intake path (Section 5.6)
);

CREATE TABLE saqa_qualification_extracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  qualification_id UUID NOT NULL REFERENCES qualifications(id),
  saqa_qualification_id TEXT NOT NULL,
  exit_level_outcomes JSONB NOT NULL,
  assessment_criteria JSONB NOT NULL,
  source_url TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE qcto_document_extracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  qualification_id UUID NOT NULL REFERENCES qualifications(id),
  original_filename TEXT NOT NULL,         -- the file itself is not retained (memory-only upload)
  exit_level_outcomes JSONB NOT NULL,
  assessment_criteria JSONB NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE assessment_instruments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  qualification_id UUID NOT NULL REFERENCES qualifications(id),
  version TEXT NOT NULL,
  questions JSONB NOT NULL,              -- array of {id, type, prompt, max_mark, model_answer/rubric_criteria, elo_ref?}
  time_allocation_minutes INT NOT NULL,
  permitted_materials JSONB DEFAULT '[]',
  pass_mark_or_competency_rule JSONB,
  source instrument_source NOT NULL DEFAULT 'manual',
  saqa_extract_id UUID REFERENCES saqa_qualification_extracts(id),
  qcto_extract_id UUID REFERENCES qcto_document_extracts(id),
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
  answers JSONB,
  UNIQUE (sitting_id, learner_id)
);

CREATE TABLE capture_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES learner_sessions(id) ON DELETE CASCADE,
  type capture_type NOT NULL,
  storage_ref TEXT NOT NULL,
  sha256_hash TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_capture_events_session ON capture_events(session_id);

CREATE TABLE incident_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES learner_sessions(id) ON DELETE CASCADE,
  raised_by incident_raised_by NOT NULL,
  raised_by_user_id UUID REFERENCES users(id),
  type TEXT NOT NULL,
  evidence_capture_event_id UUID REFERENCES capture_events(id),
  action_taken TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_integrity_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES learner_sessions(id) ON DELETE CASCADE,
  findings JSONB NOT NULL,
  overall_recommendation TEXT,            -- 'no_concerns' | 'minor_note' | 'flag_for_investigation'
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_response_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES learner_sessions(id) ON DELETE CASCADE,
  per_question_suggestions JSONB NOT NULL, -- array of {question_id, suggested_mark, criteria_matched[], criteria_missed[], depth_note, confidence, rationale}
  gap_map JSONB,                           -- Phase C: array of {elo_ref, demonstrated: bool, evidence_question_ids[]}
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE assessor_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES learner_sessions(id) ON DELETE CASCADE,
  assessor_id UUID NOT NULL REFERENCES users(id),
  per_criterion_marks JSONB NOT NULL,
  ai_suggestions_review JSONB NOT NULL,    -- array of {question_id, decision: accepted/edited/overridden, reason}
  outcome TEXT,                            -- Phase C: 'competent' | 'not_yet_competent', per the instrument's pass rule
  signed_off_at TIMESTAMPTZ                -- being set IS the release event (Section 5.1)
);

CREATE TABLE fptstaff_result_pushes (      -- Phase C (queued) / Phase E (delivered)
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES learner_sessions(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed
  attempts INT NOT NULL DEFAULT 0,
  fptstaff_ack JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
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
  job_type TEXT NOT NULL,                 -- 'ai_response_review' | 'ai_integrity' | 'fptstaff_push' | 'retention_sweep'
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed
  attempts INT NOT NULL DEFAULT 0,
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## 4. API Surface (REST, grouped by role)

All routes under `/api`. Every route enforces RBAC middleware. Only four roles exist (Section 3 of the spec); there are no Moderator or Head QA routes.

**Auth** — `POST /auth/login`, `POST /auth/mfa/verify`, `POST /auth/logout`

**Administrator**
- `POST /users` — register a user. Body: `{ name, email, password, roles[], employmentRelationship?, source?: 'manual'|'fptstaff', fptstaffId? }`. Roles limited to the four live ones. Enforces the invigilator≠assessor rule.
- `GET /users`, `GET /users/me`, `PATCH /users/:id`
- `GET /fptstaff/people?type=student|assessor|invigilator&q=` — **Phase E**: the registration dropdown's search against FPTStaff's matching section (Section 5.9)
- `POST /qualifications`, `PATCH /qualifications/:id`
- `POST /instruments` (manual), `PATCH /instruments/:id`, `POST /instruments/generate` (AI-from-SAQA, 5.6) and `POST /instruments/generate-from-upload` (AI-from-QCTO-document, 5.7; multipart, field `document`) — both return **202 `{ jobId }`**; `GET /instruments/jobs/:id` polls the job (Section 5.4); `POST /instruments/import` (**Phase F**, Curricula Builder)
- `POST /sittings`, `PATCH /sittings/:id`, `POST /sittings/:id/assign-learners`
- `GET /audit-log`

**Learner**
- `GET /me/sittings`
- `POST /sittings/:id/consent`, `POST /sittings/:id/precheck` — Phase D
- `POST /sessions/:id/check-in`
- `GET /sessions/:id/paper`, `POST /sessions/:id/answers` (autosave), `POST /sessions/:id/submit`
- `GET /sessions/:id/result` — **Phase C**: mark, outcome and assessor-confirmed feedback + gap map; 404 until `assessor_decisions.signed_off_at` is set
- `GET /me/recordings/:sessionId` — Phase D (data-subject access)

**Invigilator** — Phase D
- `GET /sittings/:id/live`, `POST /sessions/:id/verify-identity`, `POST /sessions/:id/incident`

**Assessor** — Phase C
- `GET /sittings/:id/submissions` — the assessor's queue for a sitting
- `GET /sessions/:id/dossier` — submission + AI response review (+ integrity report once Phase D exists)
- `POST /sessions/:id/decision` — marks + per-suggestion accept/edit/override; saveable as a draft
- `POST /sessions/:id/sign-off` — sets `signed_off_at` and `outcome`, releases the result, enqueues the FPTStaff push (Section 5.1)

**Capture ingestion** — Phase D: `POST /sessions/:id/capture`

**WebSocket** — Phase D: `/ws/invigilation/:sittingId`

## 5. Core Workflow Logic (implement as described, not just as data shapes)

**5.1 Sign-off gate (hard rule, enforce in code, not just UI)**
A `learner_session`'s result is visible to its Learner **if and only if** `assessor_decisions.signed_off_at IS NOT NULL` for that session. That is the entire gate — there is no moderation condition and no release table. `POST /sessions/:id/sign-off` does, in one transaction: (1) validate a decision exists for every question; (2) compute `outcome` from the instrument's `pass_mark_or_competency_rule`; (3) set `signed_off_at` and `outcome`; (4) insert a `fptstaff_result_pushes` row and a `background_jobs` row (`fptstaff_push`); (5) write `audit_log`. Sign-off is final — re-opening a signed-off result is an explicit, audited Administrator action, never a routine edit. Only the sitting's `assigned_assessor_id` may call decision/sign-off for its sessions. Enforce the visibility rule server-side in `GET /sessions/:id/result` (404 before sign-off), not just by hiding a button. This gate applies only to a learner's result; instrument creation (5.6/5.7) has no gate.

**5.2 Capture loop (client-side)** — Phase D
On session start: request camera + screen permissions once; run a `setInterval` at `proctoring_profile.capture_interval_seconds` that grabs a canvas snapshot of the screen-share stream and a webcam frame, and `POST`s both to `/sessions/:id/capture`. Attach `visibilitychange`, `blur`, and `paste` listeners that fire an out-of-band capture + a `tab_switch`/`paste` WebSocket event. If `full_recording_enabled`, start `MediaRecorder` on both streams with a short `timeslice` (e.g. 5s) so chunks upload continuously.

**5.3 Seal + hash on submission** — Phase D
On `POST /sessions/:id/submit`: mark the session `sealed`, compute a SHA-256 over the ordered list of that session's `capture_events` hashes, store it on the session row, and reject any further captures for the session.

**5.4 AI job triggers**
On submit/seal, insert a `background_jobs` row `ai_response_review` (Phase C) and, once proctoring exists, `ai_integrity` (Phase D), each with `payload = { session_id }`. A worker polls `status = 'pending' AND run_after <= now()`, marks `running`, calls the engine (Section 6), writes the result row, marks `done` (or `failed` with backoff). On sign-off, `fptstaff_push` is enqueued the same way (5.1). Instrument generation (5.6/5.7) also runs as a job: `POST /instruments/generate` and `/generate-from-upload` validate, create a `background_jobs` row (`ai_instrument_generation`, status `running`), start the work in-process, and return **202 `{ jobId }`** immediately; the client polls `GET /instruments/jobs/:id` (every 3s) until `done` (returns the instrument + coverage notes) or `failed` (returns `error` + `detail`). This exists because Replit's gateway cuts requests off at ~60s and the AI draft takes 1–2 minutes — the first live attempt died with a bare 502 for exactly that reason.

**5.10 Assessment Standard Check (built)**
Answers "does this paper meet the full requirement of the assessment standard?" Two layers: (a) `profileInstrument()` computes facts from the paper — marks by Bloom's level and by type, higher-order share (analyse/evaluate/create) against an NQF-level band (`ai/bloom.ts`: ≤2: 5–25%, 3–4: 15–40%, 5–6: 30–60%, 7+: 45–80%), marks per outcome, minutes per mark; (b) the AI maps every ELO and every AC from the instrument's source extract (SAQA or QCTO upload; for manual papers, the paper's own eloRefs) to the questions that evidence it — covered / partial / not covered — judges cognitive demand, flags per-question problems (vague rubric, mislabelled Bloom's, wrong criterion, ambiguous MCQ) and gives recommendations and a verdict (`meets_standard` only if every ELO/AC is covered and demand is within/above band; the code forces the verdict down if the AI's own coverage list shows gaps). Stored on `assessment_instruments.quality_review`; advice for the Administrator, not a gate.

**5.5 Retention sweep** — Phase D
A daily `retention_sweep` job finds sessions past the configured retention window with no active hold, deletes their R2 objects, and nulls `capture_events.storage_ref`/`answers` while keeping the row shell so the audit trail survives.

**5.6 AI-from-SAQA instrument generation** (built)
`POST /instruments/generate` takes `{ qualificationId, version, timeAllocationMinutes, permittedMaterials? }`. (1) load the qualification, 400 if no `saqa_qualification_id`; (2) fetch `https://allqs.saqa.org.za/showQualification.php?id=…` (falling back to `regqs.saqa.org.za`), parse the "Exit Level Outcomes" and "Associated Assessment Criteria" sections defensively, failing clearly rather than producing an empty instrument; (3) insert `saqa_qualification_extracts`; (4) call the Instrument Generation Engine; (5) insert `assessment_instruments` with `source='ai_generated'`. Usable immediately; `PATCH /instruments/:id` is the correction path.

**5.7 AI-from-uploaded-QCTO-document instrument generation** (built)
`POST /instruments/generate-from-upload` is multipart (`qualificationId`, `version`, `timeAllocationMinutes`, `permittedMaterials` as a comma-separated string, file field `document`). (1) load qualification, 404 if missing; (2) extract text (`pdf-parse` / `mammoth`; 400 for unsupported type, image-only PDF, legacy .doc); (3) AI identifies ELOs/ACs — 502 if it finds none (it is instructed to say so rather than invent); (4) insert `qcto_document_extracts`; (5) same Instrument Generation Engine; (6) insert `assessment_instruments` with `source='qcto_upload'`.

**5.8 Start-up bootstrap** (built)
`server/src/index.ts` calls `runMigrations()` then `ensureBootstrapAdmin()` from `db/bootstrap.ts` before `listen()`. Migrations resolve `server/drizzle` relative to the file so they work from `src/` (tsx) and `dist/` (node). `ensureBootstrapAdmin()` creates the `ADMIN_*` account only if none exists and **never** changes an existing password — that is `db:reset-admin-password`'s job, kept separate so a restart can't silently alter a live credential. Both are idempotent, so a fresh deployment needs only its secrets.

**5.9 FPTStaff integration** — Phase E (spec §4a)
`integrations/fptstaff/` exposes three functions behind one connection setting: `searchPeople(type, q)` for the registration dropdown; `pushPerson(user)` for "Add new" (returns the FPTStaff ID to store in `users.fptstaff_id`); `pushResult(payload)` for the `fptstaff_push` job. **Duplicate guard** on `pushPerson`: query FPTStaff by ID number and email first and surface a match to the Administrator before creating. A catch-up job pushes every `source='manual'` user without an `fptstaff_id` once the connection is live. Payload for `pushResult`: `{ fptstaff_id, qualification, instrument_version, sitting_id, mark, outcome, assessor, signed_off_at, evidence_ref }`. The client's `FPTSTAFF_CONNECTED` flag in `AdminUsers.tsx` becomes a server-provided setting at this point.

## 6. AI Engine Prompts (structure, not literal final copy)

All engines call the Anthropic API with tool-use structured output, never free-text parsing.

**Instrument Generation Engine** (built) — input: qualification title/type, `exit_level_outcomes[]`, `assessment_criteria[]` (from either extract table), `time_allocation_minutes`, a `source_description` for prompt wording. Output:
```json
{
  "questions": [{"type": "mcq|short_answer|long_answer|practical_upload", "prompt": "...", "max_mark": 0, "options": ["..."], "model_answer_or_rubric": "...", "elo_ref": "..."}],
  "pass_mark_or_competency_rule": "...",
  "coverage_notes": "which ELOs/ACs are covered, and any the model could not confidently write a question for"
}
```

**Document Outcome Extraction Engine** (built) — input: qualification title + extracted document text (≤ ~60k chars). Output: `{ "found": bool, "exitLevelOutcomes": [], "assessmentCriteria": [], "notFoundReason": "..." }`. Must say `found=false` rather than invent.

**Response-Review Engine** (built, `server/src/ai/responseReview.ts`) — input: `assessment_instruments.questions` (with rubrics and `elo_ref`) + `learner_sessions.answers`. Output:
```json
{
  "per_question": [{"question_id": "...", "suggested_mark": 0, "max_mark": 0, "criteria_matched": ["..."], "criteria_missed": ["..."], "depth_note": "e.g. correct but no justification", "confidence": "low|medium|high", "rationale": "..."}],
  "gap_map": [{"elo_ref": "...", "demonstrated": true, "evidence_question_ids": ["..."]}],
  "suggested_outcome": "competent|not_yet_competent",
  "summary": "plain language paragraph for the assessor"
}
```
Stored verbatim; rendered read-only in the dossier beside the Assessor's own editable `per_criterion_marks`. Never overwrite the AI's suggestions with the Assessor's edits — both stay visible for audit.

**Integrity Engine** — Phase D — input: capture event list (screenshots as images, event log as JSON) + proctoring profile. Output: `{ "findings": [{timestamp, type, evidence_capture_event_id, note}], "overall_recommendation": "no_concerns|minor_note|flag_for_investigation", "summary": "..." }`.

## 7. Phased Build Order

Superseded by **`build-roadmap.md`**. In one line: **A** Foundation ✅ → **B** Design & model alignment ✅ → **C** Assessor marking, Response-Review engine, sign-off + FPTStaff push hook → **D** Pre-checks, capture loop, seal/hash, Invigilator console, Integrity engine, R2, retention → **E** FPTStaff connection live (people + results, duplicate guard, login model) → **F** Curricula Builder live.

Build and verify each phase against the four-role permission matrix and the lifecycle in `exam-centre-spec.md` before moving on — in particular, AI output must never be visible anywhere a Learner could mistake it for a result before the Assessor has signed off.
