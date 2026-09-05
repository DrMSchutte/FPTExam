// Server-local type aliases derived directly from the Drizzle schema, rather
// than importing shared/types.ts. TypeScript's rootDir emit rules don't allow
// a package to emit .js for a file that lives outside it (shared/ sits next
// to server/, not inside it), so the server derives its own copy from the
// single source of truth that already exists for these values: the pg enums
// in db/schema.ts. The client (which never emits, just bundles) still
// imports the richer shared/types.ts directly - see client/src/lib.
import { userRoleEnum, employmentRelationshipEnum, instrumentSourceEnum } from "./db/schema.js";

export type UserRole = (typeof userRoleEnum.enumValues)[number];
export type EmploymentRelationship = (typeof employmentRelationshipEnum.enumValues)[number];
export type InstrumentSource = (typeof instrumentSourceEnum.enumValues)[number];

export type QuestionType = "mcq" | "short_answer" | "long_answer" | "practical_upload";

export interface Question {
  id: string;
  type: QuestionType;
  prompt: string;
  maxMark: number;
  options?: string[];
  modelAnswerOrRubric?: string;
  eloRef?: string;
}

// ---- Phase C: marking, Response-Review, sign-off (mirrors shared/types.ts) ----

export type Outcome = "competent" | "not_yet_competent";
export type AiConfidence = "low" | "medium" | "high";

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
