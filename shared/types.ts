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

export type InstrumentSource = "manual" | "curricula_builder";

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
