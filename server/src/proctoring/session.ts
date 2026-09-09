import { createHash } from "node:crypto";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { learnerSessions, examSittings, assessmentInstruments, captureEvents, incidentLog, auditLog } from "../db/schema.js";
import { enqueueJob } from "../jobs/runner.js";

// Block 5b: the state of a learner's proctored session while the paper is
// open - locks, focus losses, captures - and the seal that closes it.

export interface ProctoringState {
  locks: number; // times the paper has been locked
  lockedAt?: string | null;
  lockReason?: string | null;
  requiresInvigilator?: boolean; // locked until an invigilator resumes
  focusLosses: number;
  fullscreenExits: number;
  pasteAttempts: number;
  photos: number;
  screens: number;
  lastPhotoAt?: string;
  lastScreenAt?: string;
  screenShare?: "monitor" | "window" | "browser" | "none" | "unsupported";
  cameraLost?: number;
  resumedBy?: string[]; // invigilator ids, in order
  // Block 5c: messages from the invigilator (shown once in the room), a
  // pending on-demand capture, and when the room last spoke to the server.
  notes?: { id: string; text: string; at: string; seenAt?: string }[];
  captureRequestedAt?: string | null;
  lastSeenAt?: string;
}

export const PROCTORING_DEFAULTS: ProctoringState = { locks: 0, focusLosses: 0, fullscreenExits: 0, pasteAttempts: 0, photos: 0, screens: 0 };
// The learner may put the paper back themselves this many times; after that
// an invigilator has to resume it.
export const SELF_RESUME_LIMIT = 2;
// Capture cadence and the minimum gap the server will accept.
export const PHOTO_EVERY_S = 45;
export const SCREEN_EVERY_S = 120;
export const MIN_GAP = { photo: 20, screen: 45 } as const;
// An on-demand capture request the room has not answered in this long lapses
// (the browser may be locked or offline), so the console button comes back.
export const CAPTURE_REQUEST_TTL_S = 30;
export const captureRequestPending = (p: ProctoringState) => Boolean(p.captureRequestedAt) && Date.now() - new Date(p.captureRequestedAt!).getTime() < CAPTURE_REQUEST_TTL_S * 1000;

export const proctoringOf = (raw: unknown): ProctoringState => ({ ...PROCTORING_DEFAULTS, ...((raw ?? {}) as Partial<ProctoringState>) });

// When the learner's clock runs out: time allocation from the moment the paper
// opened (plus any extra time), but never past the sitting's end.
export function deadlineFor(startedAt: Date | null, minutes: number, extraMinutes: number, sittingEnd: Date): Date {
  const byClock = startedAt ? new Date(startedAt.getTime() + (minutes + extraMinutes) * 60000) : sittingEnd;
  return byClock < sittingEnd ? byClock : sittingEnd;
}

// The seal: a hash over the answers as submitted, when, and every piece of
// evidence captured during the sitting (each already hashed), in order. Any
// later change to any of it breaks the seal.
export async function sealSession(sessionId: string, answers: unknown, submittedAt: Date): Promise<string> {
  const evidence = await db.select({ h: captureEvents.sha256Hash, t: captureEvents.capturedAt }).from(captureEvents).where(eq(captureEvents.sessionId, sessionId)).orderBy(asc(captureEvents.capturedAt), asc(captureEvents.id));
  const canonical = JSON.stringify({ sessionId, submittedAt: submittedAt.toISOString(), answers: sortKeys(answers), evidence: evidence.map((e) => e.h) });
  return createHash("sha256").update(canonical).digest("hex");
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

export async function submitSession(sessionId: string, submittedAt: Date, how: "learner" | "time_up" | "invigilator", actorId?: string) {
  const [session] = await db.select().from(learnerSessions).where(eq(learnerSessions.id, sessionId));
  if (!session || session.status !== "in_progress") return session ?? null;
  const sealHash = await sealSession(session.id, session.answers ?? {}, submittedAt);
  const [updated] = await db
    .update(learnerSessions)
    .set({ status: "submitted", submissionTime: submittedAt, sealHash })
    .where(and(eq(learnerSessions.id, session.id), eq(learnerSessions.status, "in_progress")))
    .returning();
  if (!updated) return null;
  await db.insert(auditLog).values({ actorId: actorId ?? session.learnerId, action: how === "learner" ? "session_submitted" : how === "time_up" ? "session_auto_submitted" : "session_submitted_by_invigilator", targetType: "session", targetId: session.id, reason: `seal ${sealHash.slice(0, 16)}` });
  // Block 5c: the integrity summary lands with the seal so the assessor sees
  // both together. Lazy import keeps proctoring/integrity free of a cycle.
  const { writeIntegrityReport } = await import("./integrity.js");
  await writeIntegrityReport(session.id);
  await enqueueJob("ai_response_review", { sessionId: session.id });
  return updated;
}

// Every minute: any paper still open past its deadline is submitted as it
// stands, so a learner who walks away or loses their connection is never left
// "in progress", and the clock is the server's, not the browser's.
export async function autoSubmitExpired(): Promise<number> {
  const rows = await db
    .select({ id: learnerSessions.id, startedAt: learnerSessions.startedAt, extra: learnerSessions.extraMinutes, minutes: assessmentInstruments.timeAllocationMinutes, end: examSittings.endTime })
    .from(learnerSessions)
    .innerJoin(examSittings, eq(examSittings.id, learnerSessions.sittingId))
    .innerJoin(assessmentInstruments, eq(assessmentInstruments.id, examSittings.instrumentId))
    .where(and(eq(learnerSessions.status, "in_progress"), lt(examSittings.startTime, new Date())));
  let n = 0;
  const now = new Date();
  for (const r of rows) {
    const deadline = deadlineFor(r.startedAt, r.minutes, r.extra, r.end);
    if (now.getTime() >= deadline.getTime() + 15000) {
      // 15 s grace for the client's own submit to land first
      const done = await submitSession(r.id, deadline, "time_up");
      if (done) n++;
    }
  }
  return n;
}

// A flag raised by the system or the learner's browser: recorded as an
// incident (and as a capture event so it is part of the seal).
export async function recordIncident(sessionId: string, type: string, detail: Record<string, unknown>, raisedByUserId?: string) {
  const payload = JSON.stringify({ type, ...detail, at: new Date().toISOString() });
  const [ev] = await db
    .insert(captureEvents)
    .values({ sessionId, type: type === "focus_loss" ? "focus_loss" : "system_event", storageRef: `event:${payload}`, sha256Hash: createHash("sha256").update(payload).digest("hex") })
    .returning({ id: captureEvents.id });
  await db.insert(incidentLog).values({ sessionId, raisedBy: raisedByUserId ? "invigilator" : "system", raisedByUserId: raisedByUserId ?? null, type, evidenceCaptureEventId: ev.id, actionTaken: (detail.actionTaken as string | undefined) ?? null });
  return ev.id;
}

export async function incidentsFor(sessionIds: string[]) {
  const map = new Map<string, { type: string; at: Date; actionTaken: string | null }[]>();
  if (!sessionIds.length) return map;
  const rows = await db.select().from(incidentLog).where(inArray(incidentLog.sessionId, sessionIds)).orderBy(asc(incidentLog.occurredAt));
  for (const r of rows) map.set(r.sessionId, [...(map.get(r.sessionId) ?? []), { type: r.type, at: r.occurredAt, actionTaken: r.actionTaken }]);
  return map;
}

export const captureCounts = async (sessionIds: string[]) => {
  const map = new Map<string, number>();
  if (!sessionIds.length) return map;
  const rows = await db.select({ id: captureEvents.sessionId, n: sql<number>`count(*)::int` }).from(captureEvents).where(inArray(captureEvents.sessionId, sessionIds)).groupBy(captureEvents.sessionId);
  for (const r of rows) map.set(r.id, r.n);
  return map;
};
