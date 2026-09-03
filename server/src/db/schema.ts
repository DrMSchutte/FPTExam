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

export const employmentRelationshipEnum = pgEnum("employment_relationship", [
  "internal",
  "external",
]);

export const qctoRegistrationTypeEnum = pgEnum("qcto_registration_type", [
  "fisa",
  "eisa",
]);

export const instrumentSourceEnum = pgEnum("instrument_source", [
  "manual",
  "ai_generated",
  "curricula_builder",
]);

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
  photoReference: text("photo_reference"),
  employmentRelationship: employmentRelationshipEnum("employment_relationship"),
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
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const examSittings = pgTable("exam_sittings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  qualificationId: uuid("qualification_id")
    .notNull()
    .references(() => qualifications.id),
  instrumentId: uuid("instrument_id")
    .notNull()
    .references(() => assessmentInstruments.id),
  cohortId: uuid("cohort_id").notNull(),
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

export const aiResponseReviews = pgTable("ai_response_reviews", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => learnerSessions.id, { onDelete: "cascade" }),
  perQuestionSuggestions: jsonb("per_question_suggestions").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const assessorDecisions = pgTable("assessor_decisions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => learnerSessions.id, { onDelete: "cascade" }),
  assessorId: uuid("assessor_id")
    .notNull()
    .references(() => users.id),
  perCriterionMarks: jsonb("per_criterion_marks").notNull(),
  aiSuggestionsReview: jsonb("ai_suggestions_review").notNull(),
  signedOffAt: timestamp("signed_off_at", { withTimezone: true }),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
