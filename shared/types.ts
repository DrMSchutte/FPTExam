// Types shared between client and server. Kept dependency-free (no drizzle imports)
// so the client can import this file without pulling in server-only packages.

export type UserRole =
  | "administrator"
  | "learner"
  | "invigilator"
  | "assessor"
  | "moderator"
  | "head_qa";

export type EmploymentRelationship = "internal" | "external";

export type QctoRegistrationType = "fisa" | "eisa";

export type InstrumentSource = "manual" | "ai_generated" | "curricula_builder";

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
