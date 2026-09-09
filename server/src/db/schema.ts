import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---- Enums --------------------------------------------------------------

export const userRoleEnum = pgEnum("user_role", [
  "administrator",
  "learner",
  "invigilator",
  "assessor",
  "moderator",
  "head_qa",
]);

// Where a person record came from. FPTStaff is the intended system of record
// for people (see the project's moderation-signoff-policy.md); "manual" covers
// people registered directly in FPT Exam before that connection exists, or
// added via "Add new" when they aren't in FPTStaff yet.
export const userSourceEnum = pgEnum("user_source", ["manual", "fptstaff"]);

// Account status (build plan Block 1). invited: registered, set-up link not yet
// used; active: can sign in; suspended: kept but cannot sign in; archived: left.
export const userStatusEnum = pgEnum("user_status", ["invited", "active", "suspended", "archived"]);

export const employmentRelationshipEnum = pgEnum("employment_relationship", [
  "internal",
  "external",
]);

export const qctoRegistrationTypeEnum = pgEnum("qcto_registration_type", [
  "fisa",
  "eisa",
  "non_qcto", // an assessment outside the QCTO rules (internal test, short course, CPD) - built here or linked from Curricula Builder
]);

export const instrumentSourceEnum = pgEnum("instrument_source", [
  "manual",
  "ai_generated",
  "curricula_builder",
  "qcto_upload",
  "uploaded_paper", // an existing paper + memo uploaded and read into structured form (the primary route from 5 Sep 2026)
]);

// How an assessment entered FPT Exam (docs/restructure-2026-09-05.md §2, rule of
// 9 Sep 2026). Fixed at creation. The two Curricula Builder routes never author
// anything here; the other two are drafted here by the AI and editable.
export const intakeRouteEnum = pgEnum("intake_route", [
  "qcto_curricula_builder", // QCTO FISA/EISA - linked in from Curricula Builder only
  "legacy_saqa", // legacy FISA - drafted from the SAQA record's ELOs/ACs
  "built_here", // outside the QCTO rules - own outcomes / uploaded document / existing paper
  "curricula_builder_other", // CPD and other Curricula Builder creations
]);

// Where a paper stands on the way into use (docs/restructure-2026-09-05.md §2).
// Only 'ready' and 'override' papers can be scheduled into a sitting.
export const intakeStatusEnum = pgEnum("intake_status", ["checking", "ready", "blocked", "override"]);

export const sessionStatusEnum = pgEnum("session_status", [
  "scheduled",
  "checked_in",
  "in_progress",
  "submitted",
  "sealed",
]);

export const captureTypeEnum = pgEnum("capture_type", [
  "screenshot",
  "full_recording_chunk",
  "system_event",
]);

export const incidentRaisedByEnum = pgEnum("incident_raised_by", [
  "system",
  "invigilator",
]);

export const moderationDecisionEnum = pgEnum("moderation_decision", [
  "confirmed",
  "referred",
]);

// ---- Core tables ----------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  mfaSecret: text("mfa_secret"),
  idNumberHash: text("id_number_hash"),
  // Learner identity for the Statement of Results (decision 9 Sep 2026): the ID
  // number is stored encrypted (AES-256-GCM, see auth/crypto.ts) and only its
  // last four digits in the clear for search and masked display.
  idNumberEnc: text("id_number_enc"),
  idNumberLast4: text("id_number_last4"),
  studentNumber: text("student_number").unique(),
  // Assessors / moderators: their professional registration number, and how
  // many scripts they may have in flight at once (null = the 60 default).
  registrationNumber: text("registration_number"),
  markingCap: integer("marking_cap"),
  status: userStatusEnum("status").notNull().default("invited"),
  // First successful set-up (or sign-in) - what turns invited into active.
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  photoReference: text("photo_reference"),
  employmentRelationship: employmentRelationshipEnum("employment_relationship"),
  // FPTStaff integration hooks (designed in from the start, active once
  // FPTStaff can be connected): how this record was created, and the person's
  // FPTStaff identifier when they were pulled from - or pushed to - FPTStaff.
  source: userSourceEnum("source").notNull().default("manual"),
  fptstaffId: text("fptstaff_id").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// One-use, expiring links that let a newly registered person choose their own
// password and enrol their authenticator (docs: "Register People"). Only the
// hash of the token is stored; the link itself goes to the person by email (or
// is copied by the Administrator when email is not connected).
export const accountSetupTokens = pgTable("account_setup_tokens", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: userRoleEnum("role").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.role] }),
  })
);

export const qualifications = pgTable("qualifications", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  qctoRegistrationType: qctoRegistrationTypeEnum("qcto_registration_type").notNull(),
  aqpReference: text("aqp_reference"),
  // The SAQA-issued qualification ID/code (e.g. as used in
  // allqs.saqa.org.za/showQualification.php?id=<this>). Nullable - only
  // required to use the AI-from-SAQA instrument intake path (Section 5.6 of
  // the build brief).
  saqaQualificationId: text("saqa_qualification_id"),
  // NQF level (1-10). Drives the expected cognitive demand (Bloom's) of a
  // paper in the assessment-standard check. Filled from the SAQA record when
  // a paper is drafted from SAQA, or set by an Administrator.
  nqfLevel: integer("nqf_level"),
});

// A durable snapshot of what was parsed off a SAQA qualification page at the
// moment an AI-generated instrument was drafted from it - SAQA doesn't
// version this content, so this is the audit record of exactly what
// justified the paper, even if the live page changes later.
export const saqaQualificationExtracts = pgTable("saqa_qualification_extracts", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  qualificationId: uuid("qualification_id")
    .notNull()
    .references(() => qualifications.id),
  saqaQualificationId: text("saqa_qualification_id").notNull(),
  exitLevelOutcomes: jsonb("exit_level_outcomes").notNull(),
  assessmentCriteria: jsonb("assessment_criteria").notNull(),
  sourceUrl: text("source_url").notNull(),
  nqfLevel: integer("nqf_level"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

// A durable snapshot of a QCTO document (e.g. a Qualification Assessment
// Specifications / External Assessment Specifications document) uploaded by
// an Administrator, and what the AI extracted from it - the audit record of
// exactly what justified a 'qcto_upload'-sourced paper, in the same spirit as
// saqaQualificationExtracts above.
export const qctoDocumentExtracts = pgTable("qcto_document_extracts", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  qualificationId: uuid("qualification_id")
    .notNull()
    .references(() => qualifications.id),
  originalFilename: text("original_filename").notNull(),
  exitLevelOutcomes: jsonb("exit_level_outcomes").notNull(),
  assessmentCriteria: jsonb("assessment_criteria").notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
});

export const assessmentInstruments = pgTable("assessment_instruments", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  qualificationId: uuid("qualification_id")
    .notNull()
    .references(() => qualifications.id),
  version: text("version").notNull(),
  questions: jsonb("questions").notNull(),
  timeAllocationMinutes: integer("time_allocation_minutes").notNull(),
  permittedMaterials: jsonb("permitted_materials").default(sql`'[]'::jsonb`),
  passMarkOrCompetencyRule: jsonb("pass_mark_or_competency_rule"),
  source: instrumentSourceEnum("source").notNull().default("manual"),
  // Set only when source = 'ai_generated' - the exact SAQA snapshot the
  // paper was drafted from.
  saqaExtractId: uuid("saqa_extract_id").references(() => saqaQualificationExtracts.id),
  // Set only when source = 'qcto_upload' - the exact uploaded-document
  // snapshot the paper was drafted from.
  qctoExtractId: uuid("qcto_extract_id").references(() => qctoDocumentExtracts.id),
  // Assessment-standard check (build brief §5.10): coverage of every ELO/AC,
  // Bloom's taxonomy distribution against the NQF level, question-type and
  // mark-weighting mix, verdict and recommendations. Written after AI drafting
  // and whenever an Administrator re-runs the check.
  qualityReview: jsonb("quality_review"),
  qualityReviewedAt: timestamp("quality_reviewed_at", { withTimezone: true }),
  // Gate: set from the standard check's verdict; 'override' only via an
  // Administrator's reasoned override (audited).
  intakeRoute: intakeRouteEnum("intake_route").notNull(),
  // Curricula Builder's own id for a linked-in assessment (the two CB routes).
  externalRef: text("external_ref"),
  intakeStatus: intakeStatusEnum("intake_status").notNull().default("checking"),
  intakeOverrideReason: text("intake_override_reason"),
  // For uploaded papers: the original filenames, for the audit trail.
  sourceFiles: jsonb("source_files"),
  // The question list as it was before the last AI revision ("Fix the gaps"),
  // so an Administrator can restore it. One step back only.
  previousQuestions: jsonb("previous_questions"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cohortStatusEnum = pgEnum("cohort_status", ["active", "closed"]);

// A cohort is the working unit for students (Block 2 of the build plan): e.g.
// "ND Payroll · Durban · Jan 2026 intake". Students belong to cohorts; a sitting
// can be created for a cohort so its whole membership is allocated in one
// action. FPTStaff becomes the owner of cohorts once connected (external_ref).
export const cohorts = pgTable("cohorts", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  qualificationId: uuid("qualification_id").references(() => qualifications.id),
  site: text("site"),
  intake: text("intake"),
  notes: text("notes"),
  status: cohortStatusEnum("status").notNull().default("active"),
  externalRef: text("external_ref"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cohortMembers = pgTable(
  "cohort_members",
  {
    cohortId: uuid("cohort_id").notNull().references(() => cohorts.id, { onDelete: "cascade" }),
    learnerId: uuid("learner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    addedBy: uuid("added_by").references(() => users.id),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.cohortId, t.learnerId] }),
  })
);

// A series is one paper written by one (or more) cohorts across several
// sittings - different rooms, dates or times - created and staffed in one
// action (build plan Block 3).
export const sittingSeries = pgTable("sitting_series", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  qualificationId: uuid("qualification_id").notNull().references(() => qualifications.id),
  instrumentId: uuid("instrument_id").notNull().references(() => assessmentInstruments.id),
  cohortId: uuid("cohort_id").references(() => cohorts.id, { onDelete: "set null" }),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// The qualifications an assessor is registered to assess. No rows = scope not
// recorded yet (allowed, flagged); rows present = enforced when allocating.
export const assessorScopes = pgTable(
  "assessor_scopes",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    qualificationId: uuid("qualification_id").notNull().references(() => qualifications.id, { onDelete: "cascade" }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.qualificationId] }) })
);

export const examSittings = pgTable("exam_sittings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  qualificationId: uuid("qualification_id")
    .notNull()
    .references(() => qualifications.id),
  instrumentId: uuid("instrument_id")
    .notNull()
    .references(() => assessmentInstruments.id),
  // Optional: the cohort this sitting was scheduled for (Block 2). Null for a
  // sitting whose learners were added one by one.
  cohortId: uuid("cohort_id").references(() => cohorts.id, { onDelete: "set null" }),
  name: text("name"),
  seriesId: uuid("series_id").references(() => sittingSeries.id, { onDelete: "set null" }),
  venue: text("venue"),
  capacity: integer("capacity"),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }).notNull(),
  proctoringProfile: jsonb("proctoring_profile").notNull(),
  assignedAssessorId: uuid("assigned_assessor_id")
    .notNull()
    .references(() => users.id),
  independentInvigilationRequired: boolean("independent_invigilation_required")
    .notNull()
    .default(false),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sittingInvigilators = pgTable(
  "sitting_invigilators",
  {
    sittingId: uuid("sitting_id")
      .notNull()
      .references(() => examSittings.id, { onDelete: "cascade" }),
    invigilatorId: uuid("invigilator_id")
      .notNull()
      .references(() => users.id),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sittingId, t.invigilatorId] }),
  })
);

export const consentRecords = pgTable("consent_records", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  learnerId: uuid("learner_id")
    .notNull()
    .references(() => users.id),
  sittingId: uuid("sitting_id")
    .notNull()
    .references(() => examSittings.id),
  consentTextVersion: text("consent_text_version").notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
});

export const learnerSessions = pgTable(
  "learner_sessions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sittingId: uuid("sitting_id")
      .notNull()
      .references(() => examSittings.id),
    learnerId: uuid("learner_id")
      .notNull()
      .references(() => users.id),
    consentRecordId: uuid("consent_record_id").references(() => consentRecords.id),
    status: sessionStatusEnum("status").notNull().default("scheduled"),
    checkInTime: timestamp("check_in_time", { withTimezone: true }),
    submissionTime: timestamp("submission_time", { withTimezone: true }),
    answers: jsonb("answers"),
    sealHash: text("seal_hash"),
  },
  (t) => ({
    uniqSittingLearner: uniqueIndex("uq_learner_sessions_sitting_learner").on(
      t.sittingId,
      t.learnerId
    ),
  })
);

export const captureEvents = pgTable(
  "capture_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => learnerSessions.id, { onDelete: "cascade" }),
    type: captureTypeEnum("type").notNull(),
    storageRef: text("storage_ref").notNull(),
    sha256Hash: text("sha256_hash").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionIdx: index("idx_capture_events_session").on(t.sessionId),
  })
);

export const incidentLog = pgTable("incident_log", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => learnerSessions.id, { onDelete: "cascade" }),
  raisedBy: incidentRaisedByEnum("raised_by").notNull(),
  raisedByUserId: uuid("raised_by_user_id").references(() => users.id),
  type: text("type").notNull(),
  evidenceCaptureEventId: uuid("evidence_capture_event_id").references(
    () => captureEvents.id
  ),
  actionTaken: text("action_taken"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aiIntegrityReports = pgTable("ai_integrity_reports", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => learnerSessions.id, { onDelete: "cascade" }),
  findings: jsonb("findings").notNull(),
  overallRecommendation: text("overall_recommendation"),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
});

// The Response-Review engine's output for one submission (build brief §6).
// Stored verbatim and never edited - the Assessor's own marks live in
// assessorDecisions so both stay visible side by side for audit.
export const aiResponseReviews = pgTable("ai_response_reviews", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => learnerSessions.id, { onDelete: "cascade" }),
  // array of {questionId, suggestedMark, maxMark, criteriaMatched[], criteriaMissed[], depthNote, confidence, rationale}
  perQuestionSuggestions: jsonb("per_question_suggestions").notNull(),
  // array of {eloRef, demonstrated: bool, evidenceQuestionIds[], note}
  gapMap: jsonb("gap_map"),
  suggestedOutcome: text("suggested_outcome"), // 'competent' | 'not_yet_competent'
  summary: text("summary"),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per session: the Assessor's marking, saved as a draft until
// signedOffAt is set. Setting signedOffAt IS the result-release event (§5.1) -
// there is no other gate.
export const assessorDecisions = pgTable(
  "assessor_decisions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => learnerSessions.id, { onDelete: "cascade" }),
    assessorId: uuid("assessor_id")
      .notNull()
      .references(() => users.id),
    // array of {questionId, mark, feedback}
    perCriterionMarks: jsonb("per_criterion_marks").notNull(),
    // array of {questionId, decision: 'accepted'|'edited'|'overridden', reason}
    aiSuggestionsReview: jsonb("ai_suggestions_review").notNull(),
    // Assessor's overall feedback to the learner (released with the result).
    overallFeedback: text("overall_feedback"),
    outcome: text("outcome"), // 'competent' | 'not_yet_competent', set at sign-off
    totalMark: integer("total_mark"),
    totalMax: integer("total_max"),
    signedOffAt: timestamp("signed_off_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqSession: uniqueIndex("uq_assessor_decisions_session").on(t.sessionId),
  })
);

// Queued result pushes to FPTStaff (§5.9). Rows are created at sign-off from
// Phase C onward; they are actually delivered once the FPTStaff connection
// exists (Phase E). Until then they sit at status 'pending' so nothing is lost.
export const fptstaffResultPushes = pgTable("fptstaff_result_pushes", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => learnerSessions.id, { onDelete: "cascade" }),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("pending"), // pending | sent | failed
  attempts: integer("attempts").notNull().default(0),
  fptstaffAck: jsonb("fptstaff_ack"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

export const moderationRecords = pgTable("moderation_records", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: uuid("session_id").references(() => learnerSessions.id),
  cohortId: uuid("cohort_id"),
  decision: moderationDecisionEnum("decision").notNull(),
  notes: text("notes"),
  moderatorId: uuid("moderator_id")
    .notNull()
    .references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
});

// A row here means "official and visible to the Learner." The normal path is
// automatic: the moment assessor_decisions.signed_off_at is set AND a
// moderation_records row with decision='confirmed' exists for a session,
// insert a row here with sessionId set and cohortId/releasedBy left null -
// no Head QA (or anyone else) has to act. cohortId + releasedBy are used
// only for an optional Head QA export/rollup of already-released results
// for the AQP - a convenience, never a gate. See build brief Section 5.1.
export const resultReleases = pgTable("result_releases", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: uuid("session_id").references(() => learnerSessions.id),
  cohortId: uuid("cohort_id"),
  releasedBy: uuid("released_by").references(() => users.id),
  releasedAt: timestamp("released_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  actorId: uuid("actor_id").references(() => users.id),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: uuid("target_id"),
  reason: text("reason"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});

export const backgroundJobs = pgTable("background_jobs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  jobType: text("job_type").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
  // Outcome of a finished job - e.g. { instrumentId, coverageNotes } for
  // instrument generation, or { error, detail } when status = 'failed'. Lets
  // a client poll for a long-running job's result instead of holding one
  // request open past Replit's ~60s gateway timeout.
  result: jsonb("result"),
  // Live progress for long jobs the UI is watching:
  // { step, totalSteps, label, detail?, startedAt, updatedAt }.
  progress: jsonb("progress"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
