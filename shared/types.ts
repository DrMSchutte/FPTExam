// Types shared between client and server. Kept dependency-free (no drizzle imports)
// so the client can import this file without pulling in server-only packages.

// "moderator" and "head_qa" remain in the union only because the database enum
// still carries them; FPT Exam no longer assigns or routes them - moderation
// and QA live in the separate FPTStaff application. The four live roles are
// the first four.
export type UserRole =
  | "administrator"
  | "learner"
  | "invigilator"
  | "assessor"
  | "moderator"
  | "head_qa";

export type EmploymentRelationship = "internal" | "external";

// Where a person record originated - see the project's
// moderation-signoff-policy.md. FPTStaff is the intended master record.
export type UserSource = "manual" | "fptstaff";

export type QctoRegistrationType = "fisa" | "eisa";

export type InstrumentSource =
  | "manual"
  | "ai_generated"
  | "curricula_builder"
  | "qcto_upload";

export type SessionStatus =
  | "scheduled"
  | "checked_in"
  | "in_progress"
  | "submitted"
  | "sealed";

export type CaptureType = "screenshot" | "full_recording_chunk" | "system_event";

export type IncidentRaisedBy = "system" | "invigilator";

export type ModerationDecision = "confirmed" | "referred";

export type AiOverallRecommendation =
  | "no_concerns"
  | "minor_note"
  | "flag_for_investigation";

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  roles: UserRole[];
  employmentRelationship: EmploymentRelationship | null;
  source: UserSource;
  fptstaffId: string | null;
  createdAt: string;
}

export interface LoginResponse {
  mfaRequired: boolean;
  // Present only once MFA has been verified (or if the account has no MFA configured yet).
  user?: PublicUser;
}

export interface ApiError {
  error: string;
  detail?: string;
}

export type QuestionType = "mcq" | "short_answer" | "long_answer" | "practical_upload";

export interface Question {
  id: string;
  type: QuestionType;
  prompt: string;
  maxMark: number;
  options?: string[];
  modelAnswerOrRubric?: string;
  // Set only on AI-generated questions (source = 'ai_generated'): which SAQA
  // Exit Level Outcome / Assessment Criterion this question addresses, in
  // plain language - not a formal code, just a human-readable pointer for
  // alignment/audit purposes.
  eloRef?: string;
  // Which Associated Assessment Criterion the question evidences (plain text).
  acRef?: string;
  // Cognitive demand of the question on the revised Bloom's taxonomy.
  bloomLevel?: BloomLevel;
}

// The learner-facing paper never carries modelAnswerOrRubric - the server
// strips it before responding (see server/src/routes/sessions.ts).
export type LearnerQuestion = Omit<Question, "modelAnswerOrRubric">;

export interface Qualification {
  id: string;
  title: string;
  qctoRegistrationType: QctoRegistrationType;
  aqpReference: string | null;
  saqaQualificationId: string | null;
  nqfLevel: number | null;
}

export interface SaqaQualificationExtract {
  id: string;
  qualificationId: string;
  saqaQualificationId: string;
  exitLevelOutcomes: string[];
  assessmentCriteria: string[];
  sourceUrl: string;
  fetchedAt: string;
}

export interface QctoDocumentExtract {
  id: string;
  qualificationId: string;
  originalFilename: string;
  exitLevelOutcomes: string[];
  assessmentCriteria: string[];
  uploadedAt: string;
}

export interface AssessmentInstrument {
  id: string;
  qualificationId: string;
  version: string;
  questions: Question[];
  timeAllocationMinutes: number;
  permittedMaterials: string[];
  passMarkOrCompetencyRule: unknown;
  source: InstrumentSource;
  saqaExtractId: string | null;
  qctoExtractId: string | null;
  qualityReview: InstrumentQualityReview | null;
  qualityReviewedAt: string | null;
  createdAt: string;
}

export interface ProctoringProfile {
  captureIntervalSeconds: number;
  fullRecordingEnabled: boolean;
  lockdownLevel: "none" | "standard" | "strict";
  breaksAllowed: boolean;
}

export interface ExamSitting {
  id: string;
  qualificationId: string;
  instrumentId: string;
  cohortId: string;
  startTime: string;
  endTime: string;
  proctoringProfile: ProctoringProfile;
  assignedAssessorId: string;
  independentInvigilationRequired: boolean;
  createdBy: string;
  createdAt: string;
}

export interface LearnerSittingSummary {
  sessionId: string;
  status: SessionStatus;
  checkInTime: string | null;
  submissionTime: string | null;
  sittingId: string;
  startTime: string;
  endTime: string;
  qualificationId: string;
}

export interface PaperResponse {
  timeAllocationMinutes: number;
  permittedMaterials: string[];
  questions: LearnerQuestion[];
  existingAnswers: Record<string, string>;
}

// ---- Phase C: marking, Response-Review, sign-off -----------------------------

export type Outcome = "competent" | "not_yet_competent";
export type AiConfidence = "low" | "medium" | "high";

// One entry per question from the Response-Review engine (build brief §6).
export interface AiQuestionSuggestion {
  questionId: string;
  suggestedMark: number;
  maxMark: number;
  criteriaMatched: string[];
  criteriaMissed: string[];
  depthNote: string;
  confidence: AiConfidence;
  rationale: string;
}

export interface GapMapEntry {
  eloRef: string;
  demonstrated: boolean;
  evidenceQuestionIds: string[];
  note: string;
}

export interface AiResponseReview {
  id: string;
  sessionId: string;
  perQuestionSuggestions: AiQuestionSuggestion[];
  gapMap: GapMapEntry[];
  suggestedOutcome: Outcome | null;
  summary: string | null;
  generatedAt: string;
}

export interface QuestionMark {
  questionId: string;
  mark: number;
  feedback: string;
}

export type SuggestionDecision = "accepted" | "edited" | "overridden";

export interface SuggestionReview {
  questionId: string;
  decision: SuggestionDecision;
  reason: string;
}

export interface AssessorDecision {
  id: string;
  sessionId: string;
  assessorId: string;
  perCriterionMarks: QuestionMark[];
  aiSuggestionsReview: SuggestionReview[];
  overallFeedback: string | null;
  outcome: Outcome | null;
  totalMark: number | null;
  totalMax: number | null;
  signedOffAt: string | null;
  updatedAt: string;
}

// A row in the Assessor's marking queue.
export interface AssessorQueueItem {
  sessionId: string;
  status: SessionStatus;
  submissionTime: string | null;
  learnerName: string;
  learnerEmail: string;
  sittingId: string;
  startTime: string;
  qualificationId: string;
  qualificationTitle: string;
  qctoRegistrationType: QctoRegistrationType;
  instrumentVersion: string;
  aiReviewStatus: "pending" | "running" | "done" | "failed" | "none";
  decisionState: "none" | "draft" | "signed_off";
  outcome: Outcome | null;
  totalMark: number | null;
  totalMax: number | null;
}

// Everything the Assessor needs to mark one script.
export interface Dossier {
  session: {
    id: string;
    status: SessionStatus;
    submissionTime: string | null;
    answers: Record<string, string>;
  };
  learner: { id: string; name: string; email: string };
  sitting: { id: string; startTime: string; endTime: string };
  qualification: Qualification;
  instrument: {
    id: string;
    version: string;
    questions: Question[]; // full questions incl. rubric - assessor-only
    passMarkOrCompetencyRule: unknown;
  };
  aiReview: AiResponseReview | null;
  aiReviewJob: { status: string; error?: string; detail?: string } | null;
  decision: AssessorDecision | null;
}

// What the learner sees once - and only once - the Assessor has signed off.
export interface LearnerResult {
  sessionId: string;
  qualificationTitle: string;
  outcome: Outcome;
  totalMark: number;
  totalMax: number;
  percentage: number;
  signedOffAt: string;
  overallFeedback: string | null;
  perQuestion: Array<{
    questionId: string;
    prompt: string;
    maxMark: number;
    mark: number;
    feedback: string;
    eloRef?: string;
  }>;
  gapMap: GapMapEntry[];
}

// ---- Assessment standard check (Bloom's, coverage) ---------------------------

// Revised Bloom's taxonomy, lowest to highest cognitive demand.
export type BloomLevel = "remember" | "understand" | "apply" | "analyse" | "evaluate" | "create";
export const BLOOM_LEVELS: BloomLevel[] = ["remember", "understand", "apply", "analyse", "evaluate", "create"];

export type CoverageStatus = "covered" | "partial" | "not_covered";
export type StandardVerdict = "meets_standard" | "meets_with_minor_gaps" | "does_not_meet";

export interface CoverageEntry {
  kind: "elo" | "ac";
  ref: string; // the outcome / criterion text (or the paper's own eloRef when no source extract exists)
  status: CoverageStatus;
  questionIds: string[];
  marks: number;
  note: string;
}

export interface QuestionAlignmentIssue {
  questionId: string;
  severity: "info" | "warning" | "critical";
  issue: string;
  suggestion: string;
}

// Deterministic facts computed from the paper itself (no AI).
export interface InstrumentProfile {
  totalMarks: number;
  questionCount: number;
  minutesPerMark: number;
  byType: Record<string, { count: number; marks: number }>;
  byBloom: Record<BloomLevel, { count: number; marks: number }>;
  higherOrderMarkShare: number; // % of marks at analyse/evaluate/create
  expectedHigherOrderShare: { min: number; max: number; basis: string }; // from the NQF level
  byEloRef: Record<string, { count: number; marks: number }>;
  unlabelledBloom: number; // questions with no bloomLevel
}

export interface InstrumentQualityReview {
  verdict: StandardVerdict;
  summary: string;
  profile: InstrumentProfile;
  coverage: CoverageEntry[];
  bloomAssessment: string; // AI's view of cognitive demand vs the NQF level
  questionIssues: QuestionAlignmentIssue[];
  recommendations: string[];
  sourceOfOutcomes: "saqa" | "qcto_upload" | "paper_only";
  nqfLevel: number | null;
  generatedAt: string;
  model: string;
}

export interface JobProgress {
  step: number;
  totalSteps: number;
  label: string;
  detail?: string;
  startedAt: string;
  updatedAt: string;
}
