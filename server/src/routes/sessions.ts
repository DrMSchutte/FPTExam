import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { learnerSessions, examSittings, assessmentInstruments } from "../db/schema.js";
import { requireAuth, requireRole, type AuthedRequest } from "../auth/middleware.js";
import { proctoringOf, deadlineFor, submitSession } from "../proctoring/session.js";

export const sessionsRouter = Router();

async function loadOwnedSession(sessionId: string, learnerId: string, scope?: string) {
  if (scope && scope !== sessionId) return null; // a sitting-code cookie opens one session only
  const [session] = await db
    .select()
    .from(learnerSessions)
    .where(and(eq(learnerSessions.id, sessionId), eq(learnerSessions.learnerId, learnerId)));
  return session ?? null;
}

// Learner's own sittings, with just enough sitting context to show a list -
// no instrument content here, that's a separate call once the exam starts.
sessionsRouter.get("/me/sittings", requireAuth, requireRole("learner"), async (req: AuthedRequest, res) => {
  if (req.auth!.sittingSession) {
    // Scoped to one sitting: the list is just that sitting.
    const rows = await db
      .select({ sessionId: learnerSessions.id, status: learnerSessions.status, checkInTime: learnerSessions.checkInTime, submissionTime: learnerSessions.submissionTime, sittingId: examSittings.id, startTime: examSittings.startTime, endTime: examSittings.endTime, qualificationId: examSittings.qualificationId })
      .from(learnerSessions)
      .innerJoin(examSittings, eq(learnerSessions.sittingId, examSittings.id))
      .where(and(eq(learnerSessions.id, req.auth!.sittingSession), eq(learnerSessions.learnerId, req.auth!.userId)));
    return res.json(rows);
  }
  const rows = await db
    .select({
      sessionId: learnerSessions.id,
      status: learnerSessions.status,
      checkInTime: learnerSessions.checkInTime,
      submissionTime: learnerSessions.submissionTime,
      sittingId: examSittings.id,
      startTime: examSittings.startTime,
      endTime: examSittings.endTime,
      qualificationId: examSittings.qualificationId,
    })
    .from(learnerSessions)
    .innerJoin(examSittings, eq(learnerSessions.sittingId, examSittings.id))
    .where(eq(learnerSessions.learnerId, req.auth!.userId));
  return res.json(rows);
});

// Moves a session from 'scheduled' to 'in_progress' and stamps check-in
// time. This stands in for the full identity-verification + consent flow
// (Section 4, steps 3-4 of the spec) which is proctoring-phase work - Phase
// 3 here is deliberately "no proctoring yet" per the build brief's phase
// order, so this is a plain start action.
sessionsRouter.post("/sessions/:id/start", requireAuth, requireRole("learner"), async (req: AuthedRequest, res) => {
  const session = await loadOwnedSession(req.params.id, req.auth!.userId, req.auth!.sittingSession);
  if (!session) return res.status(404).json({ error: "Session not found." });
  if (session.status === "in_progress") return res.json(session); // already writing (re-entry)
  if (session.status !== "scheduled" && session.status !== "checked_in") {
    return res.status(400).json({ error: `Cannot start a session in status '${session.status}'.` });
  }
  // Block 5a: every sitting is proctored - the paper opens only after the
  // learner has accepted the conditions and taken an identity photo, and only
  // inside the sitting's window.
  const p = (session.precheck ?? {}) as { consentAt?: string; identityPhotoId?: string };
  if (!p.consentAt || !p.identityPhotoId) {
    return res.status(400).json({ error: "Complete the check-in first: accept the conditions and take your identity photo.", checkInRequired: true });
  }
  const [sitting] = await db.select().from(examSittings).where(eq(examSittings.id, session.sittingId));
  const now = Date.now();
  if (sitting && now < sitting.startTime.getTime()) return res.status(403).json({ error: "The sitting has not started yet.", startsAt: sitting.startTime.toISOString() });
  if (sitting && now >= sitting.endTime.getTime()) return res.status(403).json({ error: "The sitting has ended." });
  const [updated] = await db
    .update(learnerSessions)
    .set({ status: "in_progress", checkInTime: session.checkInTime ?? new Date(), startedAt: new Date() })
    .where(eq(learnerSessions.id, session.id))
    .returning();
  return res.json(updated);
});

// The learner-facing paper: strips model_answer/rubric content out of each
// question so the marking guide never reaches the client.
sessionsRouter.get("/sessions/:id/paper", requireAuth, requireRole("learner"), async (req: AuthedRequest, res) => {
  const session = await loadOwnedSession(req.params.id, req.auth!.userId, req.auth!.sittingSession);
  if (!session) return res.status(404).json({ error: "Session not found." });
  if (session.status === "scheduled") {
    return res.status(400).json({ error: "Start the session before requesting the paper." });
  }

  const [sitting] = await db.select().from(examSittings).where(eq(examSittings.id, session.sittingId));
  const [instrument] = await db
    .select()
    .from(assessmentInstruments)
    .where(eq(assessmentInstruments.id, sitting.instrumentId));

  const questions = (instrument.questions as any[]).map((q) => ({
    id: q.id,
    type: q.type,
    prompt: q.prompt,
    maxMark: q.maxMark,
    options: q.options,
  }));

  const p = proctoringOf(session.proctoring);
  return res.json({
    timeAllocationMinutes: instrument.timeAllocationMinutes,
    permittedMaterials: instrument.permittedMaterials,
    questions,
    existingAnswers: session.answers ?? {},
    startedAt: session.startedAt?.toISOString() ?? null,
    deadline: deadlineFor(session.startedAt, instrument.timeAllocationMinutes, session.extraMinutes, sitting.endTime).toISOString(),
    serverTime: new Date().toISOString(),
    locked: Boolean(p.lockedAt),
    requiresInvigilator: Boolean(p.requiresInvigilator),
    status: session.status,
  });
});

const answersSchema = z.object({
  answers: z.record(z.string(), z.any()),
});

// Autosave - merges into whatever's already stored rather than replacing,
// so a partial payload (e.g. one changed question) never wipes the rest.
sessionsRouter.post("/sessions/:id/answers", requireAuth, requireRole("learner"), async (req: AuthedRequest, res) => {
  const parsed = answersSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });
  }
  const session = await loadOwnedSession(req.params.id, req.auth!.userId, req.auth!.sittingSession);
  if (!session) return res.status(404).json({ error: "Session not found." });
  if (session.status !== "in_progress") {
    return res.status(400).json({ error: `Cannot save answers for a session in status '${session.status}'.` });
  }
  if (proctoringOf(session.proctoring).requiresInvigilator) {
    return res.status(423).json({ error: "Your paper is locked until your invigilator resumes it." });
  }
  const merged = { ...(session.answers as Record<string, unknown> | null ?? {}), ...parsed.data.answers };
  const [updated] = await db
    .update(learnerSessions)
    .set({ answers: merged })
    .where(eq(learnerSessions.id, session.id))
    .returning();
  return res.json({ answers: updated.answers });
});

// Submission is the seal point (Section 5.3 of the build brief covers the
// hash-chain seal for captured evidence, once proctoring exists - here it's
// just the status/timestamp transition for the answers themselves).
sessionsRouter.post("/sessions/:id/submit", requireAuth, requireRole("learner"), async (req: AuthedRequest, res) => {
  const session = await loadOwnedSession(req.params.id, req.auth!.userId, req.auth!.sittingSession);
  if (!session) return res.status(404).json({ error: "Session not found." });
  if (session.status === "submitted" || session.status === "sealed") return res.json(session); // idempotent
  if (session.status !== "in_progress") {
    return res.status(400).json({ error: `Cannot submit a session in status '${session.status}'.` });
  }
  // Block 5b: submission seals the answers with every piece of evidence
  // captured during the sitting (proctoring/session.ts), then the AI
  // Response-Review starts for the Assessor.
  const updated = await submitSession(session.id, new Date(), "learner");
  return res.json(updated ?? session);
});

// Block 8c: what was recorded of me. The consent text promises the learner may
// see their own recordings; here they are, once the paper is submitted -
// identity photo, every still, every recording segment, and how long they are
// kept. Not the integrity findings: those belong to the assessor's decision.
sessionsRouter.get("/sessions/:id/evidence", requireAuth, requireRole("learner"), async (req: AuthedRequest, res) => {
  if (req.auth!.sittingSession) return res.status(403).json({ error: "Sign in with your account to see your recordings." });
  const session = await loadOwnedSession(req.params.id, req.auth!.userId);
  if (!session) return res.status(404).json({ error: "Session not found." });
  if (session.status !== "submitted" && session.status !== "sealed") return res.status(409).json({ error: "Your recordings are available once the paper has been submitted." });
  const [sitting] = await db.select().from(examSittings).where(eq(examSittings.id, session.sittingId));
  const { captureEvents, recordingSegments, auditLog } = await import("../db/schema.js");
  const { asc } = await import("drizzle-orm");
  const caps = await db.select().from(captureEvents).where(eq(captureEvents.sessionId, session.id)).orderBy(asc(captureEvents.capturedAt));
  const segs = await db.select().from(recordingSegments).where(eq(recordingSegments.sessionId, session.id)).orderBy(asc(recordingSegments.kind), asc(recordingSegments.seq));
  const { retentionUntil } = await import("../results/portfolio.js");
  const { fullRecordingOn, SEGMENT_SECONDS } = await import("../proctoring/session.js");
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "session_evidence_self_viewed", targetType: "session", targetId: session.id });
  const pre = (session.precheck ?? {}) as { identityPhotoId?: string };
  return res.json({
    sessionId: session.id,
    submittedAt: session.submissionTime?.toISOString() ?? null,
    startedAt: session.startedAt?.toISOString() ?? null,
    sealHash: session.sealHash,
    fullRecording: fullRecordingOn(sitting.proctoringProfile),
    segmentSeconds: SEGMENT_SECONDS,
    keptUntil: retentionUntil(sitting.endTime).toISOString(),
    identityPhotoId: pre.identityPhotoId ?? null,
    captures: caps.filter((c) => c.storageRef.startsWith("blob:") && (c.type === "photo" || c.type === "screen")).map((c) => ({ id: c.storageRef.slice(5), kind: c.type, at: c.capturedAt.toISOString() })),
    segments: segs.map((s) => ({ id: s.id, kind: s.kind, seq: s.seq, startedAt: s.startedAt.toISOString(), durationMs: s.durationMs, bytes: s.bytes })),
  });
});
