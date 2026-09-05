import { Router } from "express";
import { z } from "zod";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  learnerSessions,
  examSittings,
  assessmentInstruments,
  qualifications,
  users,
  aiResponseReviews,
  assessorDecisions,
  fptstaffResultPushes,
  backgroundJobs,
  auditLog,
} from "../db/schema.js";
import { requireAuth, requireRole, type AuthedRequest } from "../auth/middleware.js";
import { enqueueJob } from "../jobs/runner.js";
import type { Question, QuestionMark, SuggestionReview, Outcome } from "../types.js";

// Phase C: the Assessor's marking workflow and the single result gate.
//
//   GET  /assessor/queue                 every submitted script on a sitting this assessor owns
//   GET  /sittings/:id/submissions       the same, for one sitting
//   GET  /sessions/:id/dossier           script + AI review + the assessor's draft decision
//   POST /sessions/:id/decision          save/replace the draft (marks, feedback, AI-suggestion review)
//   POST /sessions/:id/sign-off          FINAL: compute outcome, release, queue FPTStaff push, audit
//   POST /sessions/:id/rerun-ai-review   re-queue the Response-Review job (e.g. after a failure)
//   GET  /sessions/:id/result            learner: 404 until signed off (build brief §5.1)

export const assessorRouter = Router();

const SUBMITTED = ["submitted", "sealed"] as const;

// Loads a session and proves the caller is the Assessor of record for its
// sitting. Only that person may read the dossier or write decisions (§5.1).
type Loaded =
  | { error: 404 | 403 }
  | { session: typeof learnerSessions.$inferSelect; sitting: typeof examSittings.$inferSelect };

async function loadForAssessor(sessionId: string, assessorId: string): Promise<Loaded> {
  const [row] = await db
    .select({ session: learnerSessions, sitting: examSittings })
    .from(learnerSessions)
    .innerJoin(examSittings, eq(learnerSessions.sittingId, examSittings.id))
    .where(eq(learnerSessions.id, sessionId));
  if (!row) return { error: 404 };
  if (row.sitting.assignedAssessorId !== assessorId) return { error: 403 };
  return { session: row.session, sitting: row.sitting };
}

function decisionSerialiser(d: typeof assessorDecisions.$inferSelect) {
  return {
    id: d.id,
    sessionId: d.sessionId,
    assessorId: d.assessorId,
    perCriterionMarks: d.perCriterionMarks,
    aiSuggestionsReview: d.aiSuggestionsReview,
    overallFeedback: d.overallFeedback,
    outcome: d.outcome,
    totalMark: d.totalMark,
    totalMax: d.totalMax,
    signedOffAt: d.signedOffAt,
    updatedAt: d.updatedAt,
  };
}

// ---- Outcome rule ------------------------------------------------------------
//
// passMarkOrCompetencyRule is stored as { rule: "<plain language>" }, written by
// an Administrator or drafted by the AI (e.g. "50% overall", "Competent in every
// criterion", "60% overall and at least 40% per question"). We interpret it
// conservatively: any percentage threshold applies to the total; wording that
// demands every/each/all question or criterion additionally requires 50% (or a
// stated per-question percentage) on every question. If nothing is recognised
// the QCTO default of 50% overall applies. The interpretation is returned so
// the Assessor sees exactly what rule produced the outcome before signing off.
export function computeOutcome(
  ruleText: string | null | undefined,
  marks: QuestionMark[],
  questions: Question[]
): { outcome: Outcome; totalMark: number; totalMax: number; percentage: number; explanation: string } {
  const totalMax = questions.reduce((s, q) => s + q.maxMark, 0);
  const totalMark = marks.reduce((s, m) => s + m.mark, 0);
  const percentage = totalMax === 0 ? 0 : Math.round((totalMark / totalMax) * 1000) / 10;
  const text = (ruleText ?? "").toLowerCase();

  const pcts = [...text.matchAll(/(\d{1,3})\s*%/g)].map((m) => Number(m[1])).filter((n) => n >= 0 && n <= 100);
  const overall = pcts.length > 0 ? pcts[0] : 50;
  const perQuestionRequired = /\b(every|each|all)\b[^.]*\b(question|criteri|outcome|section)/.test(text);
  const perQuestionPct = perQuestionRequired ? (pcts.length > 1 ? pcts[1] : 50) : null;

  let pass = percentage >= overall;
  const reasons: string[] = [`${percentage}% overall against a ${overall}% pass mark`];
  if (perQuestionPct !== null) {
    const byId = new Map(marks.map((m) => [m.questionId, m.mark]));
    const failing = questions.filter((q) => q.maxMark > 0 && ((byId.get(q.id) ?? 0) / q.maxMark) * 100 < perQuestionPct);
    if (failing.length > 0) {
      pass = false;
      reasons.push(`${failing.length} question${failing.length === 1 ? "" : "s"} below the ${perQuestionPct}% per-question requirement`);
    } else {
      reasons.push(`every question at or above ${perQuestionPct}%`);
    }
  }
  return {
    outcome: pass ? "competent" : "not_yet_competent",
    totalMark,
    totalMax,
    percentage,
    explanation: reasons.join("; ") + (ruleText ? ` (rule: "${ruleText}")` : " (default rule: 50% overall)"),
  };
}

// ---- Queue -------------------------------------------------------------------

async function queueFor(assessorId: string, sittingId?: string) {
  const where = sittingId
    ? and(eq(examSittings.assignedAssessorId, assessorId), eq(examSittings.id, sittingId), inArray(learnerSessions.status, [...SUBMITTED]))
    : and(eq(examSittings.assignedAssessorId, assessorId), inArray(learnerSessions.status, [...SUBMITTED]));

  const rows = await db
    .select({
      sessionId: learnerSessions.id,
      status: learnerSessions.status,
      submissionTime: learnerSessions.submissionTime,
      learnerName: users.name,
      learnerEmail: users.email,
      sittingId: examSittings.id,
      startTime: examSittings.startTime,
      qualificationId: qualifications.id,
      qualificationTitle: qualifications.title,
      qctoRegistrationType: qualifications.qctoRegistrationType,
      instrumentVersion: assessmentInstruments.version,
      decisionSignedOffAt: assessorDecisions.signedOffAt,
      decisionId: assessorDecisions.id,
      outcome: assessorDecisions.outcome,
      totalMark: assessorDecisions.totalMark,
      totalMax: assessorDecisions.totalMax,
      reviewId: aiResponseReviews.id,
    })
    .from(learnerSessions)
    .innerJoin(examSittings, eq(learnerSessions.sittingId, examSittings.id))
    .innerJoin(users, eq(learnerSessions.learnerId, users.id))
    .innerJoin(qualifications, eq(examSittings.qualificationId, qualifications.id))
    .innerJoin(assessmentInstruments, eq(examSittings.instrumentId, assessmentInstruments.id))
    .leftJoin(assessorDecisions, eq(assessorDecisions.sessionId, learnerSessions.id))
    .leftJoin(aiResponseReviews, eq(aiResponseReviews.sessionId, learnerSessions.id))
    .where(where)
    .orderBy(desc(learnerSessions.submissionTime));

  // AI review job state for the sessions that have no review yet.
  const pendingIds = rows.filter((r) => !r.reviewId).map((r) => r.sessionId);
  const jobState = new Map<string, string>();
  if (pendingIds.length > 0) {
    const jobs = await db
      .select({ payload: backgroundJobs.payload, status: backgroundJobs.status, createdAt: backgroundJobs.createdAt })
      .from(backgroundJobs)
      .where(
        and(
          eq(backgroundJobs.jobType, "ai_response_review"),
          sql`${backgroundJobs.payload}->>'sessionId' IN (${sql.join(pendingIds.map((id) => sql`${id}`), sql`, `)})`
        )
      )
      .orderBy(desc(backgroundJobs.createdAt));
    for (const j of jobs) {
      const sid = (j.payload as { sessionId?: string }).sessionId;
      if (sid && pendingIds.includes(sid) && !jobState.has(sid)) jobState.set(sid, j.status);
    }
  }

  return rows.map((r) => ({
    sessionId: r.sessionId,
    status: r.status,
    submissionTime: r.submissionTime,
    learnerName: r.learnerName,
    learnerEmail: r.learnerEmail,
    sittingId: r.sittingId,
    startTime: r.startTime,
    qualificationId: r.qualificationId,
    qualificationTitle: r.qualificationTitle,
    qctoRegistrationType: r.qctoRegistrationType,
    instrumentVersion: r.instrumentVersion,
    aiReviewStatus: r.reviewId ? "done" : (jobState.get(r.sessionId) ?? "none"),
    decisionState: r.decisionSignedOffAt ? "signed_off" : r.decisionId ? "draft" : "none",
    outcome: r.outcome,
    totalMark: r.totalMark,
    totalMax: r.totalMax,
  }));
}

assessorRouter.get("/assessor/queue", requireAuth, requireRole("assessor"), async (req: AuthedRequest, res) => {
  return res.json(await queueFor(req.auth!.userId));
});

assessorRouter.get("/sittings/:id/submissions", requireAuth, requireRole("assessor"), async (req: AuthedRequest, res) => {
  return res.json(await queueFor(req.auth!.userId, req.params.id));
});

// ---- Dossier -----------------------------------------------------------------

assessorRouter.get("/sessions/:id/dossier", requireAuth, requireRole("assessor"), async (req: AuthedRequest, res) => {
  const loaded = await loadForAssessor(req.params.id, req.auth!.userId);
  if ("error" in loaded) {
    return res.status(loaded.error).json({ error: loaded.error === 404 ? "Session not found." : "You are not the Assessor of record for this sitting." });
  }
  const { session, sitting } = loaded;
  if (!SUBMITTED.includes(session.status as (typeof SUBMITTED)[number])) {
    return res.status(400).json({ error: "This script has not been submitted yet." });
  }

  const [learner] = await db.select().from(users).where(eq(users.id, session.learnerId));
  const [qualification] = await db.select().from(qualifications).where(eq(qualifications.id, sitting.qualificationId));
  const [instrument] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, sitting.instrumentId));
  const [review] = await db.select().from(aiResponseReviews).where(eq(aiResponseReviews.sessionId, session.id));
  const [decision] = await db.select().from(assessorDecisions).where(eq(assessorDecisions.sessionId, session.id));

  let aiReviewJob: { status: string; error?: string; detail?: string } | null = null;
  if (!review) {
    const [job] = await db
      .select()
      .from(backgroundJobs)
      .where(and(eq(backgroundJobs.jobType, "ai_response_review"), sql`${backgroundJobs.payload}->>'sessionId' = ${session.id}`))
      .orderBy(desc(backgroundJobs.createdAt))
      .limit(1);
    if (job) {
      const r = (job.result ?? {}) as { error?: string; detail?: string };
      aiReviewJob = { status: job.status, error: r.error, detail: r.detail };
    }
  }

  return res.json({
    session: {
      id: session.id,
      status: session.status,
      submissionTime: session.submissionTime,
      answers: session.answers ?? {},
    },
    learner: { id: learner.id, name: learner.name, email: learner.email },
    sitting: { id: sitting.id, startTime: sitting.startTime, endTime: sitting.endTime },
    qualification: {
      id: qualification.id,
      title: qualification.title,
      qctoRegistrationType: qualification.qctoRegistrationType,
      aqpReference: qualification.aqpReference,
      saqaQualificationId: qualification.saqaQualificationId,
    },
    instrument: {
      id: instrument.id,
      version: instrument.version,
      questions: instrument.questions,
      passMarkOrCompetencyRule: instrument.passMarkOrCompetencyRule,
    },
    aiReview: review
      ? {
          id: review.id,
          sessionId: review.sessionId,
          perQuestionSuggestions: review.perQuestionSuggestions,
          gapMap: review.gapMap ?? [],
          suggestedOutcome: review.suggestedOutcome,
          summary: review.summary,
          generatedAt: review.generatedAt,
        }
      : null,
    aiReviewJob,
    decision: decision ? decisionSerialiser(decision) : null,
  });
});

// Re-queue the AI review (after a failure, or if it never ran). Never touches
// the assessor's own marks.
assessorRouter.post("/sessions/:id/rerun-ai-review", requireAuth, requireRole("assessor"), async (req: AuthedRequest, res) => {
  const loaded = await loadForAssessor(req.params.id, req.auth!.userId);
  if ("error" in loaded) return res.status(loaded.error).json({ error: "Not available." });
  const jobId = await enqueueJob("ai_response_review", { sessionId: loaded.session.id });
  return res.status(202).json({ jobId });
});

// ---- Decision draft ----------------------------------------------------------

const markSchema = z.object({
  questionId: z.string().min(1),
  mark: z.number().min(0),
  feedback: z.string().default(""),
});
const suggestionReviewSchema = z.object({
  questionId: z.string().min(1),
  decision: z.enum(["accepted", "edited", "overridden"]),
  reason: z.string().default(""),
});
const decisionSchema = z.object({
  perCriterionMarks: z.array(markSchema),
  aiSuggestionsReview: z.array(suggestionReviewSchema).default([]),
  overallFeedback: z.string().optional(),
});

function validateMarks(marks: QuestionMark[], questions: Question[]): string | null {
  const byId = new Map(questions.map((q) => [q.id, q]));
  for (const m of marks) {
    const q = byId.get(m.questionId);
    if (!q) return `Mark refers to an unknown question (${m.questionId}).`;
    if (m.mark > q.maxMark) return `Mark for a question exceeds its maximum of ${q.maxMark}.`;
  }
  return null;
}

assessorRouter.post("/sessions/:id/decision", requireAuth, requireRole("assessor"), async (req: AuthedRequest, res) => {
  const parsed = decisionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });

  const loaded = await loadForAssessor(req.params.id, req.auth!.userId);
  if ("error" in loaded) {
    return res.status(loaded.error).json({ error: loaded.error === 404 ? "Session not found." : "You are not the Assessor of record for this sitting." });
  }
  const { session, sitting } = loaded;
  if (!SUBMITTED.includes(session.status as (typeof SUBMITTED)[number])) {
    return res.status(400).json({ error: "This script has not been submitted yet." });
  }

  const [existing] = await db.select().from(assessorDecisions).where(eq(assessorDecisions.sessionId, session.id));
  if (existing?.signedOffAt) {
    return res.status(409).json({ error: "This result has been signed off and is final.", detail: "Re-opening a signed-off result is an audited Administrator action." });
  }

  const [instrument] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, sitting.instrumentId));
  const questions = instrument.questions as Question[];
  const bad = validateMarks(parsed.data.perCriterionMarks, questions);
  if (bad) return res.status(400).json({ error: bad });

  const rule = (instrument.passMarkOrCompetencyRule as { rule?: string } | null)?.rule;
  const provisional = computeOutcome(rule, parsed.data.perCriterionMarks, questions);

  const values = {
    sessionId: session.id,
    assessorId: req.auth!.userId,
    perCriterionMarks: parsed.data.perCriterionMarks,
    aiSuggestionsReview: parsed.data.aiSuggestionsReview as SuggestionReview[],
    overallFeedback: parsed.data.overallFeedback ?? null,
    totalMark: provisional.totalMark,
    totalMax: provisional.totalMax,
    updatedAt: new Date(),
  };
  const [saved] = existing
    ? await db.update(assessorDecisions).set(values).where(eq(assessorDecisions.id, existing.id)).returning()
    : await db.insert(assessorDecisions).values(values).returning();

  return res.json({ decision: decisionSerialiser(saved), provisional });
});

// ---- Sign-off: the one and only gate (build brief §5.1) ---------------------

const signOffSchema = z.object({
  // Optional explicit override of the computed outcome, with a mandatory reason.
  overrideOutcome: z.enum(["competent", "not_yet_competent"]).optional(),
  overrideReason: z.string().optional(),
});

assessorRouter.post("/sessions/:id/sign-off", requireAuth, requireRole("assessor"), async (req: AuthedRequest, res) => {
  const parsed = signOffSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });
  if (parsed.data.overrideOutcome && !parsed.data.overrideReason?.trim()) {
    return res.status(400).json({ error: "An outcome override needs a reason." });
  }

  const loaded = await loadForAssessor(req.params.id, req.auth!.userId);
  if ("error" in loaded) {
    return res.status(loaded.error).json({ error: loaded.error === 404 ? "Session not found." : "You are not the Assessor of record for this sitting." });
  }
  const { session, sitting } = loaded;

  const [decision] = await db.select().from(assessorDecisions).where(eq(assessorDecisions.sessionId, session.id));
  if (!decision) return res.status(400).json({ error: "Save your marks before signing off." });
  if (decision.signedOffAt) return res.status(409).json({ error: "This result is already signed off." });

  const [instrument] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, sitting.instrumentId));
  const [qualification] = await db.select().from(qualifications).where(eq(qualifications.id, sitting.qualificationId));
  const [learner] = await db.select().from(users).where(eq(users.id, session.learnerId));
  const questions = instrument.questions as Question[];
  const marks = decision.perCriterionMarks as QuestionMark[];

  // (1) A mark for every question.
  const marked = new Set(marks.map((m) => m.questionId));
  const missing = questions.filter((q) => !marked.has(q.id));
  if (missing.length > 0) {
    return res.status(400).json({
      error: `Every question needs a mark before sign-off - ${missing.length} still unmarked.`,
      detail: missing.map((q) => q.id).join(", "),
    });
  }

  // (2) Outcome from the instrument's rule (or an explicit, reasoned override).
  const rule = (instrument.passMarkOrCompetencyRule as { rule?: string } | null)?.rule;
  const computed = computeOutcome(rule, marks, questions);
  const outcome: Outcome = parsed.data.overrideOutcome ?? computed.outcome;
  const signedOffAt = new Date();

  const result = await db.transaction(async (tx) => {
    // (3) Release.
    const [signed] = await tx
      .update(assessorDecisions)
      .set({ outcome, totalMark: computed.totalMark, totalMax: computed.totalMax, signedOffAt, updatedAt: signedOffAt })
      .where(and(eq(assessorDecisions.id, decision.id), sql`${assessorDecisions.signedOffAt} IS NULL`))
      .returning();
    if (!signed) throw new Error("Sign-off raced with another request.");

    // (4) Queue the result for FPTStaff (§5.9) - delivered in Phase E.
    const [push] = await tx
      .insert(fptstaffResultPushes)
      .values({
        sessionId: session.id,
        payload: {
          learner: { id: learner.id, name: learner.name, email: learner.email, fptstaffId: learner.fptstaffId },
          qualification: { id: qualification.id, title: qualification.title, type: qualification.qctoRegistrationType, saqaQualificationId: qualification.saqaQualificationId },
          sitting: { id: sitting.id, startTime: sitting.startTime },
          instrumentVersion: instrument.version,
          outcome,
          totalMark: computed.totalMark,
          totalMax: computed.totalMax,
          percentage: computed.percentage,
          assessorId: req.auth!.userId,
          signedOffAt,
        },
      })
      .returning();
    await tx.insert(backgroundJobs).values({ jobType: "fptstaff_push", payload: { pushId: push.id }, status: "pending" });

    // (5) Audit.
    await tx.insert(auditLog).values({
      actorId: req.auth!.userId,
      action: "assessor_sign_off",
      targetType: "learner_session",
      targetId: session.id,
      reason:
        `Outcome ${outcome} (${computed.totalMark}/${computed.totalMax}, ${computed.percentage}%). ${computed.explanation}` +
        (parsed.data.overrideOutcome ? ` OVERRIDE: ${parsed.data.overrideReason}` : ""),
    });
    return signed;
  });

  return res.json({ decision: decisionSerialiser(result), computed });
});

// ---- Learner's result: visible iff signed off ---------------------------------

assessorRouter.get("/sessions/:id/result", requireAuth, requireRole("learner"), async (req: AuthedRequest, res) => {
  const [row] = await db
    .select({ session: learnerSessions, sitting: examSittings, decision: assessorDecisions })
    .from(learnerSessions)
    .innerJoin(examSittings, eq(learnerSessions.sittingId, examSittings.id))
    .innerJoin(assessorDecisions, eq(assessorDecisions.sessionId, learnerSessions.id))
    .where(
      and(
        eq(learnerSessions.id, req.params.id),
        eq(learnerSessions.learnerId, req.auth!.userId),
        isNotNull(assessorDecisions.signedOffAt) // THE gate
      )
    );
  if (!row) return res.status(404).json({ error: "No released result for this session." });

  const [instrument] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, row.sitting.instrumentId));
  const [qualification] = await db.select().from(qualifications).where(eq(qualifications.id, row.sitting.qualificationId));
  const [review] = await db.select().from(aiResponseReviews).where(eq(aiResponseReviews.sessionId, row.session.id));

  const questions = instrument.questions as Question[];
  const marks = new Map((row.decision.perCriterionMarks as QuestionMark[]).map((m) => [m.questionId, m]));
  const totalMark = row.decision.totalMark ?? 0;
  const totalMax = row.decision.totalMax ?? questions.reduce((s, q) => s + q.maxMark, 0);

  return res.json({
    sessionId: row.session.id,
    qualificationTitle: qualification.title,
    outcome: row.decision.outcome,
    totalMark,
    totalMax,
    percentage: totalMax === 0 ? 0 : Math.round((totalMark / totalMax) * 1000) / 10,
    signedOffAt: row.decision.signedOffAt,
    overallFeedback: row.decision.overallFeedback,
    perQuestion: questions.map((q) => ({
      questionId: q.id,
      prompt: q.prompt,
      maxMark: q.maxMark,
      mark: marks.get(q.id)?.mark ?? 0,
      feedback: marks.get(q.id)?.feedback ?? "",
      eloRef: q.eloRef,
    })),
    // The gap map is the AI's analysis, released only because the Assessor
    // signed off the result it sits beside; it is labelled as such in the UI.
    gapMap: review?.gapMap ?? [],
  });
});
