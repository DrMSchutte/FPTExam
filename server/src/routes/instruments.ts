import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  assessmentInstruments,
  qualifications,
  saqaQualificationExtracts,
  qctoDocumentExtracts,
  backgroundJobs,
  auditLog,
} from "../db/schema.js";
import { requireAuth, requireRole, type AuthedRequest } from "../auth/middleware.js";
import { reviewInstrumentAgainstStandard } from "../ai/instrumentQualityReview.js";
import { reviseInstrumentToStandard, markLimit } from "../ai/instrumentRevision.js";
import { normaliseOutcomes } from "../ai/outcomeNormalisation.js";

import type { ProgressHook } from "../ai/longCall.js";

// Progress detail for a streamed AI call: "…about 1,400 words written so far".
export const wordsProgress = (jobId: string, step: number, total: number, label: string, prefix?: string): ProgressHook =>
  ({ words }) => setProgress(jobId, step, total, label, `${prefix ? prefix + " · " : ""}about ${words.toLocaleString("en-ZA")} words written so far`);
import type { Question, InstrumentQualityReview } from "../types.js";
import { loadAlignment, renderAlignment } from "../results/alignment.js";
import { sql } from "drizzle-orm";

export const instrumentsRouter = Router();

// ---------------------------------------------------------------------------
// Long-running generation runs as a background job, not inside the request.
//
// Drafting a paper takes the AI one to two minutes. Replit's gateway (and most
// reverse proxies) cut a request off at roughly 60s and hand the browser a
// bare 502 - which is exactly what happened on the first live attempt. So the
// generate endpoints now validate, create a `background_jobs` row, start the
// work, and return 202 with the job id immediately; the client polls
// GET /instruments/jobs/:id until it's done or failed. The job row's `result`
// carries either { instrumentId, questionCount, coverageNotes } or
// { error, detail }, so failures are as explicit as they were before.
// ---------------------------------------------------------------------------

export type JobOutcome =
  | { instrumentId: string; questionCount: number; coverageNotes: string }
  | { instrumentId: string; qualityCheck: true }
  | { error: string; detail: string };

// Live progress the UI shows while a job runs - a numbered stage plus a
// human label ("Fetching the SAQA record…"). Written to the job row so any
// poll sees it, not just the browser that started the job.
export async function setProgress(jobId: string, step: number, totalSteps: number, label: string, detail?: string): Promise<void> {
  const [job] = await db.select({ progress: backgroundJobs.progress }).from(backgroundJobs).where(eq(backgroundJobs.id, jobId));
  const prev = (job?.progress ?? {}) as { startedAt?: string };
  const now = new Date().toISOString();
  await db
    .update(backgroundJobs)
    .set({ progress: { step, totalSteps, label, detail, startedAt: prev.startedAt ?? now, updatedAt: now } })
    .where(eq(backgroundJobs.id, jobId));
}

// Runs the assessment-standard check for an instrument and stores it on the
// row. Shared by the generation paths (final stage) and the re-run endpoint.
// The reference list a paper is measured against: the outcomes and criteria
// from wherever it came (SAQA record, uploaded document, typed, Curricula Builder).
export async function outcomesForInstrument(instrument: typeof assessmentInstruments.$inferSelect) {
  const [qualification] = await db.select().from(qualifications).where(eq(qualifications.id, instrument.qualificationId));
  let exitLevelOutcomes: string[] = [];
  let assessmentCriteria: string[] = [];
  let sourceOfOutcomes: "saqa" | "qcto_upload" | "own_outcomes" | "curricula_builder" | "paper_only" = "paper_only";
  let nqfLevel = qualification.nqfLevel ?? null;
  if (instrument.saqaExtractId) {
    const [ex] = await db.select().from(saqaQualificationExtracts).where(eq(saqaQualificationExtracts.id, instrument.saqaExtractId));
    if (ex) {
      exitLevelOutcomes = ex.exitLevelOutcomes as string[];
      assessmentCriteria = ex.assessmentCriteria as string[];
      sourceOfOutcomes = "saqa";
      nqfLevel = nqfLevel ?? ex.nqfLevel ?? null;
    }
  } else if (instrument.qctoExtractId) {
    const [ex] = await db.select().from(qctoDocumentExtracts).where(eq(qctoDocumentExtracts.id, instrument.qctoExtractId));
    if (ex) {
      exitLevelOutcomes = ex.exitLevelOutcomes as string[];
      assessmentCriteria = ex.assessmentCriteria as string[];
      sourceOfOutcomes = ex.originalFilename.startsWith("curricula-builder:")
        ? "curricula_builder"
        : ex.originalFilename.startsWith("typed:")
          ? "own_outcomes"
          : "qcto_upload";
    }
  }
  return { qualification, exitLevelOutcomes, assessmentCriteria, sourceOfOutcomes, nqfLevel };
}

export async function runStandardCheck(instrumentId: string, onProgress?: ProgressHook): Promise<InstrumentQualityReview> {
  const [instrument] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, instrumentId));
  if (!instrument) throw new Error("Instrument not found.");
  const { qualification, exitLevelOutcomes, assessmentCriteria, sourceOfOutcomes, nqfLevel } = await outcomesForInstrument(instrument);

  const review = await reviewInstrumentAgainstStandard({
    qualificationTitle: qualification.title,
    qctoRegistrationType: qualification.qctoRegistrationType,
    nqfLevel,
    exitLevelOutcomes,
    assessmentCriteria,
    sourceOfOutcomes,
    questions: instrument.questions as Question[],
    timeAllocationMinutes: instrument.timeAllocationMinutes,
    passRule: (instrument.passMarkOrCompetencyRule as { rule?: string } | null)?.rule ?? "",
  }, onProgress);
  // The check is the gate (docs/restructure-2026-09-05.md §2): a paper that
  // does not meet the standard is blocked from sittings until fixed or
  // overridden with a reason. An existing override is left alone.
  const gate = review.verdict === "does_not_meet" ? "blocked" : "ready";
  await db
    .update(assessmentInstruments)
    .set({
      qualityReview: review,
      qualityReviewedAt: new Date(),
      ...(instrument.intakeStatus === "override" ? {} : { intakeStatus: gate }),
    })
    .where(eq(assessmentInstruments.id, instrumentId));
  return review;
}

// Question-by-question manual entry has no UI (docs/restructure-2026-09-05.md §2:
// assessments are drafted by the AI or linked in). The endpoint stays as a
// development/test seam, switched off unless explicitly enabled.
const AUTHORING_ENABLED = process.env.ENABLE_PAPER_AUTHORING === "true";
function authoringGate(_req: AuthedRequest, res: import("express").Response, next: import("express").NextFunction) {
  if (!AUTHORING_ENABLED) {
    return res.status(410).json({
      error: "FPT Exam does not take papers typed in question by question.",
      detail: "Use Set up an Assessment: link a QCTO paper from Curricula Builder, draft a legacy FISA from SAQA, or build a non-QCTO assessment from its outcomes.",
    });
  }
  next();
}

export async function startJob(jobType: string, payload: Record<string, unknown>): Promise<string> {
  const [job] = await db
    .insert(backgroundJobs)
    .values({ jobType, payload, status: "running", attempts: 1 })
    .returning();
  return job.id;
}

export async function finishJob(jobId: string, outcome: JobOutcome): Promise<void> {
  await db
    .update(backgroundJobs)
    .set({ status: "error" in outcome ? "failed" : "done", result: outcome })
    .where(eq(backgroundJobs.id, jobId));
}

// Fire-and-forget wrapper: whatever the work throws becomes a failed job with
// a readable reason rather than an unhandled rejection.
export function runInBackground(jobId: string, work: () => Promise<JobOutcome>): void {
  work()
    .then((outcome) => finishJob(jobId, outcome))
    .catch((err) =>
      finishJob(jobId, {
        error: "Instrument generation failed unexpectedly.",
        detail: err instanceof Error ? err.message : String(err),
      })
    )
    .catch((err) => console.error(`Could not record outcome for job ${jobId}:`, err));
}

// Poll endpoint for a generation job. Returns the instrument itself once done,
// so the client needs nothing further.
instrumentsRouter.get(
  "/jobs/:id",
  requireAuth,
  requireRole("administrator"),
  async (req: AuthedRequest, res) => {
    const [job] = await db.select().from(backgroundJobs).where(eq(backgroundJobs.id, req.params.id));
    if (!job) return res.status(404).json({ error: "Job not found." });
    const result = (job.result ?? null) as JobOutcome | null;
    const progress = job.progress ?? null;
    if (job.status === "done" && result && "instrumentId" in result) {
      const [instrument] = await db
        .select()
        .from(assessmentInstruments)
        .where(eq(assessmentInstruments.id, result.instrumentId));
      if ("qualityCheck" in result) return res.json({ status: "done", instrument, progress });
      return res.json({ status: "done", instrument, coverageNotes: result.coverageNotes, questionCount: result.questionCount, progress });
    }
    if (job.status === "failed" && result && "error" in result) {
      return res.json({ status: "failed", error: result.error, detail: result.detail, progress });
    }
    return res.json({ status: job.status, progress });
  }
);

// Mirrors the AssessmentInstrument import contract in the build brief
// (Section 5) so a future "Fetch from Curricula Builder" action can populate
// this exact same shape without any downstream changes.
const questionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["mcq", "short_answer", "long_answer", "practical_upload"]),
  prompt: z.string().min(1),
  maxMark: z.number().nonnegative(),
  modelAnswerOrRubric: z.string().optional(),
  options: z.array(z.string()).optional(), // for mcq
  eloRef: z.string().optional(), // which outcome / criterion the question addresses
  acRef: z.string().optional(),
  bloomLevel: z.enum(["remember", "understand", "apply", "analyse", "evaluate", "create"]).optional(),
});

const createSchema = z.object({
  qualificationId: z.string().uuid(),
  version: z.string().min(1),
  questions: z.array(questionSchema).min(1),
  timeAllocationMinutes: z.number().int().positive(),
  permittedMaterials: z.array(z.string()).optional(),
  passMarkOrCompetencyRule: z.string().optional(),
});

// Manual entry against the defined schema (development/test seam - see
// authoringGate). Recorded as built here.
instrumentsRouter.post(
  "/",
  requireAuth,
  requireRole("administrator"),
  authoringGate,
  async (req: AuthedRequest, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });
    }
    const { qualificationId, version, questions, timeAllocationMinutes, permittedMaterials, passMarkOrCompetencyRule } =
      parsed.data;

    const [created] = await db
      .insert(assessmentInstruments)
      .values({
        qualificationId,
        version,
        questions,
        timeAllocationMinutes,
        permittedMaterials: permittedMaterials ?? [],
        passMarkOrCompetencyRule: passMarkOrCompetencyRule ? { rule: passMarkOrCompetencyRule } : null,
        source: "manual",
        intakeRoute: "built_here",
        // Dev-only route (authoringGate): no standard check runs here, so the
        // paper is usable straight away, shown as "Not checked".
        intakeStatus: "ready",
      })
      .returning();
    return res.status(201).json(created);
  }
);

instrumentsRouter.get(
  "/",
  requireAuth,
  requireRole("administrator", "assessor"),
  async (req, res) => {
    const qualificationId = req.query.qualificationId as string | undefined;
    const rows = qualificationId
      ? await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.qualificationId, qualificationId))
      : await db.select().from(assessmentInstruments);
    return res.json(rows);
  }
);

instrumentsRouter.get(
  "/:id",
  requireAuth,
  requireRole("administrator", "assessor"),
  async (req, res) => {
    const [row] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, req.params.id));
    if (!row) return res.status(404).json({ error: "Instrument not found." });
    return res.json(row);
  }
);

// Re-run the assessment-standard check on any paper (manual ones included).
// Runs as a job like generation - the AI read takes 30-90 seconds.
instrumentsRouter.post(
  "/:id/quality-check",
  requireAuth,
  requireRole("administrator"),
  async (req: AuthedRequest, res) => {
    const [row] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, req.params.id));
    if (!row) return res.status(404).json({ error: "Instrument not found." });
    const jobId = await startJob("ai_instrument_quality_check", { instrumentId: row.id });
    runInBackground(jobId, async () => {
      await setProgress(jobId, 1, 2, "Checking the paper against the assessment standard", "Coverage of every outcome and criterion, Bloom's demand, rubric quality");
      try {
        await runStandardCheck(row.id, wordsProgress(jobId, 1, 2, "Checking the paper against the assessment standard", "moderator's report"));
      } catch (err) {
        return { error: "The assessment-standard check failed.", detail: err instanceof Error ? err.message : String(err) };
      }
      await setProgress(jobId, 2, 2, "Saved");
      return { instrumentId: row.id, qualityCheck: true as const };
    });
    return res.status(202).json({ jobId });
  }
);

// "Fix the gaps": the AI revises a paper drafted here so that it meets the
// standard the check measured it against, then the check runs again. Up to two
// rounds. The previous question list is kept so the Administrator can restore it.
// Not for Curricula Builder papers - those are corrected at their source.
instrumentsRouter.post(
  "/:id/fix-gaps",
  requireAuth,
  requireRole("administrator"),
  async (req: AuthedRequest, res) => {
    const [row] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, req.params.id));
    if (!row) return res.status(404).json({ error: "Instrument not found." });
    if (row.intakeRoute === "qcto_curricula_builder" || row.intakeRoute === "curricula_builder_other") {
      return res.status(409).json({ error: "This paper is linked in from Curricula Builder and is not revised here.", detail: "Correct it on Curricula Builder and pull the new version." });
    }
    if (row.intakeStatus === "checking") return res.status(400).json({ error: "Wait for the current standard check to finish." });
    const actorId = req.auth!.userId;
    const total = 3;
    const jobId = await startJob("ai_instrument_fix_gaps", { instrumentId: row.id });

    runInBackground(jobId, async () => {
      let current = row;
      let review = (current.qualityReview ?? null) as InstrumentQualityReview | null;
      if (!review) {
        await setProgress(jobId, 1, total, "Checking the paper against the assessment standard first");
        review = await runStandardCheck(current.id);
        [current] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, current.id));
      }
      if (review.verdict === "meets_standard") {
        await setProgress(jobId, total, total, "Saved");
        return { instrumentId: current.id, questionCount: (current.questions as Question[]).length, coverageNotes: "The paper already meets the standard - nothing to fix." };
      }

      // One revision, one re-check. A second automatic round tends to oscillate on a
      // paper whose outcomes genuinely do not fit its time allocation; the
      // Administrator decides what happens next from the report.
      const gaps = review.coverage.filter((c) => c.status !== "covered").length;
      await setProgress(jobId, 1, total, "Revising the paper to close the gaps", `${gaps} outcomes/criteria not fully covered · higher-order share ${review.profile.higherOrderMarkShare}%`);
      const ctx = await outcomesForInstrument(current);
      const revised = await reviseInstrumentToStandard({
        qualificationTitle: ctx.qualification.title,
        qctoRegistrationType: ctx.qualification.qctoRegistrationType,
        nqfLevel: ctx.nqfLevel,
        exitLevelOutcomes: ctx.exitLevelOutcomes,
        assessmentCriteria: ctx.assessmentCriteria,
        timeAllocationMinutes: current.timeAllocationMinutes,
        permittedMaterials: (current.permittedMaterials as string[]) ?? [],
        questions: current.questions as Question[],
        review,
        passRule: (current.passMarkOrCompetencyRule as { rule?: string } | null)?.rule ?? "",
      }, wordsProgress(jobId, 1, total, "Revising the paper to close the gaps", "rewriting and adding questions"));
      [current] = await db
        .update(assessmentInstruments)
        .set({
          previousQuestions: current.questions,
          questions: revised.questions,
          passMarkOrCompetencyRule: { rule: revised.passMarkOrCompetencyRule },
          intakeStatus: current.intakeStatus === "override" ? "override" : "checking",
        })
        .where(eq(assessmentInstruments.id, current.id))
        .returning();
      await db.insert(auditLog).values({
        actorId,
        action: "instrument_ai_revised",
        targetType: "assessment_instrument",
        targetId: current.id,
        reason: `kept ${revised.kept}, replaced ${revised.replaced}, added ${revised.added}`,
      });
      const marks = revised.questions.reduce((s, q) => s + q.maxMark, 0);

      await setProgress(jobId, 2, total, "Checking the revised paper against the standard", `${revised.questions.length} questions, ${marks} marks`);
      try {
        review = await runStandardCheck(current.id, wordsProgress(jobId, 2, total, "Checking the revised paper against the standard", "moderator's report"));
      } catch (err) {
        await db.update(assessmentInstruments).set({ intakeStatus: "blocked" }).where(eq(assessmentInstruments.id, current.id));
        return { error: "The paper was revised but the standard check failed.", detail: err instanceof Error ? err.message : String(err) };
      }

      const notes = [`Kept ${revised.kept}, replaced ${revised.replaced}, added ${revised.added}. ${revised.changeSummary}`];
      const stillGaps = review.coverage.filter((c) => c.status !== "covered").length;
      if (review.verdict === "does_not_meet") {
        const elos = ctx.exitLevelOutcomes.length;
        notes.push(
          `Still not meeting the standard after revision: ${stillGaps} outcomes/criteria not fully covered.` +
            (marks >= markLimit(current.timeAllocationMinutes) * 0.95 && elos >= 12
              ? ` This qualification has ${elos} exit level outcomes and the paper is already at the mark ceiling for ${current.timeAllocationMinutes} minutes - they do not all fit with depth. Consider extending the time allocation (edit it under Questions, then run Fix the gaps again), splitting into two papers, or overriding with a reason if the coverage is acceptable for this sitting.`
              : ` Run Fix the gaps again, edit the questions, or override with a reason.`)
        );
      }
      await setProgress(jobId, total, total, "Saved");
      const [final] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, current.id));
      return { instrumentId: final.id, questionCount: (final.questions as Question[]).length, coverageNotes: notes.join("\n\n") };
    });

    return res.status(202).json({ jobId });
  }
);

// Puts back the question list from before the last "Fix the gaps" run, then re-checks.
instrumentsRouter.post(
  "/:id/restore-previous",
  requireAuth,
  requireRole("administrator"),
  async (req: AuthedRequest, res) => {
    const [row] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, req.params.id));
    if (!row) return res.status(404).json({ error: "Instrument not found." });
    if (!row.previousQuestions) return res.status(400).json({ error: "There is no previous version to restore." });
    await db
      .update(assessmentInstruments)
      .set({ questions: row.previousQuestions, previousQuestions: null, intakeStatus: row.intakeStatus === "override" ? "override" : "checking" })
      .where(eq(assessmentInstruments.id, row.id));
    await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "instrument_restored_previous", targetType: "assessment_instrument", targetId: row.id, reason: "restored the question list from before the AI revision" });
    const jobId = await startJob("ai_instrument_quality_check", { instrumentId: row.id, reason: "restored" });
    runInBackground(jobId, async () => {
      await setProgress(jobId, 1, 2, "Checking the restored paper against the assessment standard");
      try {
        await runStandardCheck(row.id);
      } catch (err) {
        await db.update(assessmentInstruments).set({ intakeStatus: "blocked" }).where(eq(assessmentInstruments.id, row.id));
        return { error: "The assessment-standard check failed.", detail: err instanceof Error ? err.message : String(err) };
      }
      await setProgress(jobId, 2, 2, "Saved");
      return { instrumentId: row.id, qualityCheck: true as const };
    });
    return res.status(202).json({ jobId });
  }
);

// ---- The outcomes and criteria a paper is measured against ---------------------
//
// Readable for every paper; editable (and tidy-able by AI) for papers drafted
// here. Saving writes a new reference list, points the paper at it, and re-runs
// the check. The list that came from SAQA or the document stays on record.

instrumentsRouter.get("/:id/outcomes", requireAuth, requireRole("administrator"), async (req, res) => {
  const [row] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, req.params.id));
  if (!row) return res.status(404).json({ error: "Instrument not found." });
  const ctx = await outcomesForInstrument(row);
  return res.json({ exitLevelOutcomes: ctx.exitLevelOutcomes, assessmentCriteria: ctx.assessmentCriteria, sourceOfOutcomes: ctx.sourceOfOutcomes });
});

// AI tidy-up of the current list - returns a proposal; nothing is saved until PUT.
instrumentsRouter.post("/:id/outcomes/tidy", requireAuth, requireRole("administrator"), async (req, res) => {
  const [row] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, req.params.id));
  if (!row) return res.status(404).json({ error: "Instrument not found." });
  const ctx = await outcomesForInstrument(row);
  const body = req.body ?? {};
  const elos: string[] = Array.isArray(body.exitLevelOutcomes) ? body.exitLevelOutcomes : ctx.exitLevelOutcomes;
  const acs: string[] = Array.isArray(body.assessmentCriteria) ? body.assessmentCriteria : ctx.assessmentCriteria;
  if (elos.length === 0) return res.status(400).json({ error: "There are no outcomes to tidy." });
  const n = await normaliseOutcomes({ qualificationTitle: ctx.qualification.title, exitLevelOutcomes: elos, assessmentCriteria: acs });
  return res.json(n);
});

const outcomesSchema = z.object({
  exitLevelOutcomes: z.array(z.string().trim().min(1)).min(1),
  assessmentCriteria: z.array(z.string().trim().min(1)),
});

instrumentsRouter.put("/:id/outcomes", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  const parsed = outcomesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Give at least one outcome, one per line.", detail: parsed.error.message });
  const [row] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, req.params.id));
  if (!row) return res.status(404).json({ error: "Instrument not found." });
  if (row.intakeRoute === "qcto_curricula_builder" || row.intakeRoute === "curricula_builder_other") {
    return res.status(409).json({ error: "This paper's outcomes come from Curricula Builder and are not edited here." });
  }
  const [ex] = await db
    .insert(qctoDocumentExtracts)
    .values({ qualificationId: row.qualificationId, originalFilename: "typed:administrator (edited outcomes)", exitLevelOutcomes: parsed.data.exitLevelOutcomes, assessmentCriteria: parsed.data.assessmentCriteria })
    .returning();
  await db
    .update(assessmentInstruments)
    .set({ qctoExtractId: ex.id, saqaExtractId: null, intakeStatus: row.intakeStatus === "override" ? "override" : "checking" })
    .where(eq(assessmentInstruments.id, row.id));
  await db.insert(auditLog).values({
    actorId: req.auth!.userId,
    action: "instrument_outcomes_edited",
    targetType: "assessment_instrument",
    targetId: row.id,
    reason: `${parsed.data.exitLevelOutcomes.length} outcomes, ${parsed.data.assessmentCriteria.length} criteria`,
  });
  const jobId = await startJob("ai_instrument_quality_check", { instrumentId: row.id, reason: "outcomes edited" });
  runInBackground(jobId, async () => {
    await setProgress(jobId, 1, 2, "Checking the paper against the edited outcomes");
    try {
      await runStandardCheck(row.id, wordsProgress(jobId, 1, 2, "Checking the paper against the edited outcomes", "moderator's report"));
    } catch (err) {
      await db.update(assessmentInstruments).set({ intakeStatus: "blocked" }).where(eq(assessmentInstruments.id, row.id));
      return { error: "The assessment-standard check failed.", detail: err instanceof Error ? err.message : String(err) };
    }
    await setProgress(jobId, 2, 2, "Saved");
    return { instrumentId: row.id, qualityCheck: true as const };
  });
  return res.status(202).json({ jobId });
});

// Administrator override of the gate for a paper the check marked as not
// meeting the standard. Needs a reason; recorded in the audit log.
instrumentsRouter.post(
  "/:id/override",
  requireAuth,
  requireRole("administrator"),
  async (req: AuthedRequest, res) => {
    const reason = String(req.body?.reason ?? "").trim();
    if (reason.length < 10) return res.status(400).json({ error: "Give a reason for the override (at least 10 characters)." });
    const [row] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, req.params.id));
    if (!row) return res.status(404).json({ error: "Instrument not found." });
    if (row.intakeStatus === "checking") return res.status(400).json({ error: "Wait for the standard check to finish before overriding." });
    const [updated] = await db
      .update(assessmentInstruments)
      .set({ intakeStatus: "override", intakeOverrideReason: reason })
      .where(eq(assessmentInstruments.id, row.id))
      .returning();
    await db.insert(auditLog).values({
      actorId: req.auth!.userId,
      action: "instrument_gate_override",
      targetType: "assessment_instrument",
      targetId: row.id,
      reason,
    });
    return res.json(updated);
  }
);

const updateSchema = z.object({
  version: z.string().min(1).optional(),
  questions: z.array(questionSchema).min(1).optional(),
  timeAllocationMinutes: z.number().int().positive().optional(),
  permittedMaterials: z.array(z.string()).optional(),
  passMarkOrCompetencyRule: z.string().optional(),
});

// Edits to a paper drafted here (legacy FISA from SAQA, or built from scratch). A
// paper linked in from Curricula Builder is read-only on FPT Exam: it is
// corrected there and pulled again as a new version. Changing the questions
// makes the last standard check stale, so the paper goes back to `checking`
// and the check is re-run as a job (the response carries its id).
instrumentsRouter.patch(
  "/:id",
  requireAuth,
  requireRole("administrator"),
  async (req: AuthedRequest, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });
    }
    if (Object.keys(parsed.data).length === 0) {
      return res.status(400).json({ error: "No fields to update." });
    }
    const [row] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, req.params.id));
    if (!row) return res.status(404).json({ error: "Instrument not found." });
    if (row.intakeRoute === "qcto_curricula_builder" || row.intakeRoute === "curricula_builder_other") {
      return res.status(409).json({
        error: "This paper is linked in from Curricula Builder and cannot be edited here.",
        detail: "Correct it on Curricula Builder and pull the new version under Set up an Assessment.",
      });
    }
    const { passMarkOrCompetencyRule, ...rest } = parsed.data;
    const questionsChanged = rest.questions !== undefined && JSON.stringify(rest.questions) !== JSON.stringify(row.questions);
    const recheck = questionsChanged || rest.timeAllocationMinutes !== undefined || passMarkOrCompetencyRule !== undefined;
    const [updated] = await db
      .update(assessmentInstruments)
      .set({
        ...rest,
        ...(passMarkOrCompetencyRule !== undefined ? { passMarkOrCompetencyRule: { rule: passMarkOrCompetencyRule } } : {}),
        ...(recheck && row.intakeStatus !== "override" ? { intakeStatus: "checking" as const } : {}),
      })
      .where(eq(assessmentInstruments.id, req.params.id))
      .returning();
    await db.insert(auditLog).values({
      actorId: req.auth!.userId,
      action: "instrument_edited",
      targetType: "assessment_instrument",
      targetId: row.id,
      reason: questionsChanged ? `questions edited (${row.questions instanceof Array ? row.questions.length : "?"} → ${updated.questions instanceof Array ? updated.questions.length : "?"})` : "paper details edited",
    });
    let jobId: string | null = null;
    if (recheck) {
      jobId = await startJob("ai_instrument_quality_check", { instrumentId: row.id, reason: "edited" });
      const jid = jobId;
      runInBackground(jid, async () => {
        await setProgress(jid, 1, 2, "Checking the edited paper against the assessment standard");
        try {
          await runStandardCheck(row.id);
        } catch (err) {
          await db.update(assessmentInstruments).set({ intakeStatus: "blocked" }).where(eq(assessmentInstruments.id, row.id));
          return { error: "The assessment-standard check failed.", detail: err instanceof Error ? err.message : String(err) };
        }
        await setProgress(jid, 2, 2, "Saved");
        return { instrumentId: row.id, qualityCheck: true as const };
      });
    }
    return res.json({ ...updated, recheckJobId: jobId });
  }
);


// ---- Retire / delete a paper, and the alignment matrix report -----------------------------
//
//   POST   /instruments/:id/retire { reason }   out of use; kept for the sittings written on it; never scheduled again
//   POST   /instruments/:id/unretire
//   DELETE /instruments/:id                     only when no sitting was ever scheduled on it
//   GET    /instruments/:id/alignment.pdf       the alignment matrix report

instrumentsRouter.post("/:id/retire", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  const parsed = z.object({ reason: z.string().trim().min(3).max(300) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Give a reason (3-300 characters)." });
  const [row] = await db.update(assessmentInstruments).set({ retiredAt: new Date(), retireReason: parsed.data.reason }).where(eq(assessmentInstruments.id, req.params.id)).returning();
  if (!row) return res.status(404).json({ error: "Instrument not found." });
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "instrument_retired", targetType: "instrument", targetId: row.id, reason: parsed.data.reason });
  return res.json(row);
});

instrumentsRouter.post("/:id/unretire", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  const [row] = await db.update(assessmentInstruments).set({ retiredAt: null, retireReason: null }).where(eq(assessmentInstruments.id, req.params.id)).returning();
  if (!row) return res.status(404).json({ error: "Instrument not found." });
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "instrument_unretired", targetType: "instrument", targetId: row.id });
  return res.json(row);
});

instrumentsRouter.delete("/:id", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  const [row] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, req.params.id));
  if (!row) return res.status(404).json({ error: "Instrument not found." });
  const [{ n }] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM exam_sittings WHERE instrument_id = ${row.id}`).then((r) => r.rows);
  if (n > 0) return res.status(409).json({ error: `This paper has ${n} sitting${n === 1 ? "" : "s"} scheduled or written on it and cannot be deleted.`, detail: "Retire it instead: it stays for those sittings and can never be scheduled again." });
  await db.execute(sql`UPDATE assessment_instruments SET superseded_by_id = NULL WHERE superseded_by_id = ${row.id}`);
  await db.delete(assessmentInstruments).where(eq(assessmentInstruments.id, row.id));
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "instrument_deleted", targetType: "instrument", targetId: row.id, reason: `${row.version} (${row.intakeRoute})` });
  return res.json({ ok: true });
});

instrumentsRouter.get("/:id/alignment.pdf", requireAuth, requireRole("administrator", "assessor"), async (req: AuthedRequest, res) => {
  const data = await loadAlignment(req.params.id);
  if (!data) return res.status(404).json({ error: "Instrument not found." });
  const pdf = await renderAlignment(data);
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "alignment_report_downloaded", targetType: "instrument", targetId: data.instrument.id });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="Alignment-Matrix-${data.qualification.title.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40)}-${data.instrument.version.replace(/[^A-Za-z0-9.-]+/g, "-")}.pdf"`);
  return res.send(pdf);
});
