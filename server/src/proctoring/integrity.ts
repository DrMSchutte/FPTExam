import { asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { learnerSessions, examSittings, assessmentInstruments, incidentLog, captureEvents, auditLog, aiIntegrityReports, users } from "../db/schema.js";
import { proctoringOf, PHOTO_EVERY_S, SCREEN_EVERY_S, SELF_RESUME_LIMIT } from "./session.js";

// Block 5c: the integrity summary. Computed the moment a paper is submitted
// (by the learner, by the clock or by the invigilator) from everything the
// room recorded - locks, focus losses, paste attempts, captures and their
// coverage, screen-share surface, the invigilator's own incidents and
// actions - and stored in ai_integrity_reports for the assessor's dossier
// and the Statement of Results. Deterministic: the same evidence always
// gives the same findings, so it can be explained to a learner or QCTO.

export type IntegritySeverity = "info" | "low" | "medium" | "high";
export type IntegrityRecommendation = "clear" | "review" | "investigate";

export interface IntegrityFinding {
  code: string;
  severity: IntegritySeverity;
  title: string;
  detail: string;
  count?: number;
}

export interface IntegritySummary {
  recommendation: IntegrityRecommendation;
  headline: string;
  findings: IntegrityFinding[];
  counts: {
    locks: number;
    focusLosses: number;
    fullscreenExits: number;
    pasteAttempts: number;
    photos: number;
    screens: number;
    photosExpected: number;
    screensExpected: number;
    invigilatorIncidents: number;
    notesToLearner: number;
    entries: number;
    extraMinutes: number;
  };
  screenShare: string | null;
  identityPhoto: boolean;
  submittedBy: "learner" | "time_up" | "invigilator" | "unknown";
  writingMinutes: number;
  generatedAt: string;
}

// Incident types the invigilator can raise by hand from the console.
export const MANUAL_INCIDENTS: Record<string, { title: string; severity: IntegritySeverity }> = {
  talking: { title: "Talking or communicating", severity: "medium" },
  unauthorised_material: { title: "Unauthorised material seen", severity: "high" },
  phone: { title: "Phone or second device", severity: "high" },
  left_seat: { title: "Left the seat", severity: "medium" },
  identity_doubt: { title: "Identity in doubt", severity: "high" },
  other_person: { title: "Another person present", severity: "high" },
  other: { title: "Other observation", severity: "medium" },
};

const RANK: Record<IntegritySeverity, number> = { info: 0, low: 1, medium: 2, high: 3 };

export async function buildIntegritySummary(sessionId: string): Promise<IntegritySummary | null> {
  const [row] = await db
    .select({ session: learnerSessions, sitting: examSittings, minutes: assessmentInstruments.timeAllocationMinutes })
    .from(learnerSessions)
    .innerJoin(examSittings, eq(examSittings.id, learnerSessions.sittingId))
    .innerJoin(assessmentInstruments, eq(assessmentInstruments.id, examSittings.instrumentId))
    .where(eq(learnerSessions.id, sessionId));
  if (!row) return null;
  const { session } = row;
  const p = proctoringOf(session.proctoring);
  const pre = (session.precheck ?? {}) as { identityPhotoId?: string };
  const incidents = await db.select().from(incidentLog).where(eq(incidentLog.sessionId, sessionId)).orderBy(asc(incidentLog.occurredAt));
  const audit = await db.select().from(auditLog).where(eq(auditLog.targetId, sessionId)).orderBy(asc(auditLog.occurredAt));

  const started = session.startedAt ?? session.checkInTime ?? row.sitting.startTime;
  const ended = session.submissionTime ?? new Date();
  const writingMinutes = Math.max(0, Math.round((ended.getTime() - started.getTime()) / 60000));
  const writingSeconds = writingMinutes * 60;
  const photosExpected = Math.max(1, Math.floor(writingSeconds / PHOTO_EVERY_S));
  const screensExpected = Math.max(1, Math.floor(writingSeconds / SCREEN_EVERY_S));

  const findings: IntegrityFinding[] = [];
  const add = (code: string, severity: IntegritySeverity, title: string, detail: string, count?: number) => findings.push({ code, severity, title, detail, count });

  // Identity
  if (!pre.identityPhotoId) add("no_identity_photo", "high", "No identity photograph", "The learner started without an identity photo on record.");
  else add("identity_photo", "info", "Identity photograph taken", "Taken at check-in; compare with the periodic photos.");

  // Leaving the exam window
  const hardLocks = Math.max(0, p.locks - SELF_RESUME_LIMIT);
  if (p.focusLosses === 0 && p.fullscreenExits === 0) add("stayed_in_window", "info", "Stayed in the exam window", "No focus loss or full-screen exit was recorded.");
  else {
    const n = p.focusLosses + p.fullscreenExits;
    add("left_window", n >= 3 ? "medium" : "low", "Left the exam window", `${p.focusLosses} time${p.focusLosses === 1 ? "" : "s"} out of the window, ${p.fullscreenExits} full-screen exit${p.fullscreenExits === 1 ? "" : "s"}; the paper locked ${p.locks} time${p.locks === 1 ? "" : "s"}.`, n);
  }
  if (hardLocks > 0) add("hard_lock", "medium", "Locked out until the invigilator released the paper", `${hardLocks} lock${hardLocks === 1 ? "" : "s"} beyond the ${SELF_RESUME_LIMIT} self-resumes allowed.`, hardLocks);

  // Copy / paste
  if (p.pasteAttempts > 0) add("paste_attempts", p.pasteAttempts >= 3 ? "medium" : "low", "Copy or paste attempted", `${p.pasteAttempts} attempt${p.pasteAttempts === 1 ? "" : "s"} were blocked and recorded.`, p.pasteAttempts);

  // Screen share surface
  if (!p.screenShare || p.screenShare === "none" || p.screenShare === "unsupported") add("no_screen_share", "high", "Screen was not shared", "No screen evidence exists for this sitting.");
  else if (p.screenShare !== "monitor") add("partial_screen_share", "medium", "Only part of the screen was shared", `The learner shared a ${p.screenShare}, not the entire screen.`);
  else add("screen_shared", "info", "Entire screen shared", "Screen stills were captured throughout.");

  // Capture coverage
  if (writingMinutes >= 2) {
    const photoCover = p.photos / photosExpected;
    const screenCover = p.screens / screensExpected;
    if (photoCover < 0.5) add("camera_gaps", "medium", "Gaps in camera evidence", `${p.photos} photo${p.photos === 1 ? "" : "s"} against about ${photosExpected} expected over ${writingMinutes} minutes.`);
    else if (photoCover < 0.8) add("camera_thin", "low", "Camera evidence thinner than expected", `${p.photos} photos against about ${photosExpected} expected.`);
    if ((p.screenShare === "monitor" || p.screenShare === "window" || p.screenShare === "browser") && screenCover < 0.5) add("screen_gaps", "medium", "Gaps in screen evidence", `${p.screens} screen still${p.screens === 1 ? "" : "s"} against about ${screensExpected} expected.`);
  }
  if ((p.cameraLost ?? 0) > 0) add("camera_lost", (p.cameraLost ?? 0) >= 2 ? "medium" : "low", "Camera stopped during the sitting", `${p.cameraLost} time${p.cameraLost === 1 ? "" : "s"}.`, p.cameraLost);

  // Browser events recorded as incidents
  const devtools = incidents.filter((i) => i.type === "devtools").length;
  if (devtools) add("devtools", "medium", "Developer tools shortcut used", `${devtools} attempt${devtools === 1 ? "" : "s"} blocked.`, devtools);

  // Invigilator's own observations
  const manual = incidents.filter((i) => i.raisedBy === "invigilator" && i.type in MANUAL_INCIDENTS);
  for (const inc of manual) {
    const m = MANUAL_INCIDENTS[inc.type];
    add(`invigilator_${inc.type}`, m.severity, m.title, `Recorded by the invigilator at ${inc.occurredAt.toLocaleTimeString("en-ZA", { timeZone: "Africa/Johannesburg", hour: "2-digit", minute: "2-digit" })}${inc.actionTaken ? `: ${inc.actionTaken}` : "."}`);
  }
  const notes = incidents.filter((i) => i.type === "note_to_learner").length;
  if (notes) add("notes", "info", "Invigilator sent a message", `${notes} message${notes === 1 ? "" : "s"} to the learner during the sitting.`, notes);
  const resumed = incidents.filter((i) => i.type === "resumed_by_invigilator").length;
  if (resumed) add("resumed_by_invigilator", "info", "Paper released by the invigilator", `${resumed} time${resumed === 1 ? "" : "s"}.`, resumed);

  // Entries, extra time, how it ended
  if (session.entries > 1) add("reentries", "low", "Re-entered the sitting", `The sitting code was used ${session.entries} times (re-entry allowed by the invigilator).`, session.entries);
  if (session.extraMinutes > 0) {
    const reasons = audit.filter((a) => a.action === "session_extra_time").map((a) => a.reason).filter(Boolean);
    add("extra_time", "info", "Extra time granted", `${session.extraMinutes} minute${session.extraMinutes === 1 ? "" : "s"}${reasons.length ? ` — ${reasons.join("; ")}` : ""}.`);
  }
  let submittedBy: IntegritySummary["submittedBy"] = "unknown";
  if (audit.some((a) => a.action === "session_submitted")) submittedBy = "learner";
  else if (audit.some((a) => a.action === "session_auto_submitted")) submittedBy = "time_up";
  else if (audit.some((a) => a.action === "session_submitted_by_invigilator")) submittedBy = "invigilator";
  if (submittedBy === "time_up") add("time_up", "info", "Submitted by the clock", "The paper was submitted as it stood when time ran out.");
  if (submittedBy === "invigilator") {
    // The reason is on the incident recorded just before the submission (the
    // audit line lands after the report is built).
    const reason = incidents.find((i) => i.type === "ended_by_invigilator")?.actionTaken ?? audit.find((a) => a.action === "session_terminated")?.reason ?? null;
    const wasIntegrity = manual.length > 0;
    add("ended_by_invigilator", wasIntegrity ? "high" : "low", "Paper ended by the invigilator", reason ? `Reason given: ${reason}` : "No reason recorded.");
  }

  const worst = findings.reduce<IntegritySeverity>((w, f) => (RANK[f.severity] > RANK[w] ? f.severity : w), "info");
  const recommendation: IntegrityRecommendation = worst === "high" ? "investigate" : worst === "medium" ? "review" : "clear";
  const flagged = findings.filter((f) => f.severity !== "info");
  const headline =
    recommendation === "clear"
      ? flagged.length ? "Minor observations only — nothing that questions the result." : "Clean sitting — no integrity concerns recorded."
      : recommendation === "review"
        ? `${flagged.length} observation${flagged.length === 1 ? "" : "s"} worth reviewing against the evidence before signing off.`
        : "Serious observations — review the evidence and follow the irregularity procedure before signing off.";

  return {
    recommendation,
    headline,
    findings: findings.sort((a, b) => RANK[b.severity] - RANK[a.severity]),
    counts: {
      locks: p.locks,
      focusLosses: p.focusLosses,
      fullscreenExits: p.fullscreenExits,
      pasteAttempts: p.pasteAttempts,
      photos: p.photos,
      screens: p.screens,
      photosExpected,
      screensExpected,
      invigilatorIncidents: manual.length,
      notesToLearner: notes,
      entries: session.entries,
      extraMinutes: session.extraMinutes,
    },
    screenShare: p.screenShare ?? null,
    identityPhoto: Boolean(pre.identityPhotoId),
    submittedBy,
    writingMinutes,
    generatedAt: new Date().toISOString(),
  };
}

// Stores (or replaces) the report for a session. Never throws: an integrity
// report that cannot be written must not stop a submission.
export async function writeIntegrityReport(sessionId: string): Promise<IntegritySummary | null> {
  try {
    const summary = await buildIntegritySummary(sessionId);
    if (!summary) return null;
    await db.delete(aiIntegrityReports).where(eq(aiIntegrityReports.sessionId, sessionId));
    await db.insert(aiIntegrityReports).values({ sessionId, findings: summary, overallRecommendation: summary.recommendation });
    return summary;
  } catch (err) {
    console.error("integrity report failed", sessionId, err);
    return null;
  }
}

export async function integrityReportFor(sessionId: string): Promise<IntegritySummary | null> {
  const [r] = await db.select().from(aiIntegrityReports).where(eq(aiIntegrityReports.sessionId, sessionId));
  return r ? (r.findings as IntegritySummary) : null;
}

// The evidence timeline for one session: every capture (with its blob when it
// is an image), every incident and every staff action, oldest first.
export interface TimelineItem {
  at: string;
  kind: "identity_photo" | "photo" | "screen" | "incident" | "action";
  blobId?: string;
  type?: string;
  detail?: string | null;
  by?: string | null;
}

export async function evidenceTimeline(sessionId: string): Promise<TimelineItem[]> {
  const caps = await db.select().from(captureEvents).where(eq(captureEvents.sessionId, sessionId)).orderBy(asc(captureEvents.capturedAt));
  const incidents = await db
    .select({ i: incidentLog, byName: users.name })
    .from(incidentLog)
    .leftJoin(users, eq(users.id, incidentLog.raisedByUserId))
    .where(eq(incidentLog.sessionId, sessionId))
    .orderBy(asc(incidentLog.occurredAt));
  const actions = await db
    .select({ a: auditLog, byName: users.name })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(eq(auditLog.targetId, sessionId))
    .orderBy(asc(auditLog.occurredAt));
  const items: TimelineItem[] = [];
  for (const c of caps) {
    if (c.storageRef.startsWith("blob:")) items.push({ at: c.capturedAt.toISOString(), kind: c.type as TimelineItem["kind"], blobId: c.storageRef.slice(5) });
  }
  for (const { i, byName } of incidents) items.push({ at: i.occurredAt.toISOString(), kind: "incident", type: i.type, detail: i.actionTaken, by: i.raisedBy === "invigilator" ? byName ?? "invigilator" : "system" });
  for (const { a, byName } of actions) {
    if (a.action.startsWith("sitting_") || a.action.startsWith("session_")) items.push({ at: a.occurredAt.toISOString(), kind: "action", type: a.action, detail: a.reason, by: byName });
  }
  return items.sort((x, y) => x.at.localeCompare(y.at));
}
