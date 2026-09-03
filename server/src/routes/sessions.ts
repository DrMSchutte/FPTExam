import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { learnerSessions, examSittings, assessmentInstruments } from "../db/schema.js";
import { requireAuth, requireRole, type AuthedRequest } from "../auth/middleware.js";

export const sessionsRouter = Router();

async function loadOwnedSession(sessionId: string, learnerId: string) {
  const [session] = await db
    .select()
    .from(learnerSessions)
    .where(and(eq(learnerSessions.id, sessionId), eq(learnerSessions.learnerId, learnerId)));
  return session ?? null;
}

// Learner's own sittings, with just enough sitting context to show a list -
// no instrument content here, that's a separate call once the exam starts.
sessionsRouter.get("/me/sittings", requireAuth, requireRole("learner"), async (req: AuthedRequest, res) => {
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
  const session = await loadOwnedSession(req.params.id, req.auth!.userId);
  if (!session) return res.status(404).json({ error: "Session not found." });
  if (session.status !== "scheduled") {
    return res.status(400).json({ error: `Cannot start a session in status '${session.status}'.` });
  }
  const [updated] = await db
    .update(learnerSessions)
    .set({ status: "in_progress", checkInTime: new Date() })
    .where(eq(learnerSessions.id, session.id))
    .returning();
  return res.json(updated);
});

// The learner-facing paper: strips model_answer/rubric content out of each
// question so the marking guide never reaches the client.
sessionsRouter.get("/sessions/:id/paper", requireAuth, requireRole("learner"), async (req: AuthedRequest, res) => {
  const session = await loadOwnedSession(req.params.id, req.auth!.userId);
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

  return res.json({
    timeAllocationMinutes: instrument.timeAllocationMinutes,
    permittedMaterials: instrument.permittedMaterials,
    questions,
    existingAnswers: session.answers ?? {},
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
  const session = await loadOwnedSession(req.params.id, req.auth!.userId);
  if (!session) return res.status(404).json({ error: "Session not found." });
  if (session.status !== "in_progress") {
    return res.status(400).json({ error: `Cannot save answers for a session in status '${session.status}'.` });
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
  const session = await loadOwnedSession(req.params.id, req.auth!.userId);
  if (!session) return res.status(404).json({ error: "Session not found." });
  if (session.status !== "in_progress") {
    return res.status(400).json({ error: `Cannot submit a session in status '${session.status}'.` });
  }
  const [updated] = await db
    .update(learnerSessions)
    .set({ status: "submitted", submissionTime: new Date() })
    .where(eq(learnerSessions.id, session.id))
    .returning();
  return res.json(updated);
});
