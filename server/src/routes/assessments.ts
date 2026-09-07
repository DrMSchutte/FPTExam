import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { eq, desc, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  assessmentInstruments,
  qualifications,
  saqaQualificationExtracts,
  assessorDecisions,
  learnerSessions,
  examSittings,
  users,
  fptstaffResultPushes,
} from "../db/schema.js";
import { requireAuth, requireRole, type AuthedRequest } from "../auth/middleware.js";
import { extractTextFromDocument, DocumentExtractionError } from "../integrations/qcto/extractDocumentText.js";
import { fetchSaqaExtract, SaqaExtractError } from "../integrations/saqa/fetchQualification.js";
import { extractPaper, PaperExtractionError } from "../ai/paperExtraction.js";
import { startJob, runInBackground, setProgress, runStandardCheck } from "./instruments.js";

// "Set up an Assessment" (docs/restructure-2026-09-05.md §2).
//
//   POST /assessments/intake   upload the paper (+ memo) → qualification captured from the
//                              SAQA ID (or manual fields) → paper read into structured
//                              questions → standard check → gate. 202 { jobId }; poll
//                              GET /instruments/jobs/:id (same job machinery as before).
//   GET  /assessments/results  administrator's view of signed-off results + FPTStaff push status.

export const assessmentsRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 2 } });

const intakeFields = z.object({
  version: z.string().min(1),
  // Either an existing qualification…
  qualificationId: z.string().uuid().optional(),
  // …or a SAQA ID to look one up / create one from the SAQA record…
  saqaQualificationId: z.string().trim().min(1).optional(),
  // …with manual details as the fallback (or to override what SAQA says).
  title: z.string().trim().min(1).optional(),
  qctoRegistrationType: z.enum(["fisa", "eisa"]).optional(),
  nqfLevel: z.coerce.number().int().min(1).max(10).optional(),
  // Optional overrides of what the paper states.
  timeAllocationMinutes: z.coerce.number().int().positive().optional(),
  permittedMaterials: z.string().optional(),
});

function guessType(title: string): "fisa" | "eisa" {
  // Occupational Certificates are the QCTO's own (EISA); legacy National
  // Certificates/Diplomas and FET certificates run FISA.
  return /occupational certificate/i.test(title) ? "eisa" : "fisa";
}

assessmentsRouter.post(
  "/intake",
  requireAuth,
  requireRole("administrator"),
  upload.fields([
    { name: "paper", maxCount: 1 },
    { name: "memo", maxCount: 1 },
  ]),
  async (req: AuthedRequest, res) => {
    const parsed = intakeFields.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const paperFile = files?.paper?.[0];
    const memoFile = files?.memo?.[0];
    if (!paperFile) return res.status(400).json({ error: "Upload the question paper (form field 'paper')." });
    const f = parsed.data;
    if (!f.qualificationId && !f.saqaQualificationId && !f.title) {
      return res.status(400).json({ error: "Identify the qualification: pick an existing one, give its SAQA ID, or type its title." });
    }

    // Read the documents now (fast, and a bad file should fail the request, not the job).
    let paperText: string;
    let memoText: string | undefined;
    try {
      paperText = await extractTextFromDocument(paperFile.buffer, paperFile.mimetype, paperFile.originalname);
      if (memoFile) memoText = await extractTextFromDocument(memoFile.buffer, memoFile.mimetype, memoFile.originalname);
    } catch (err) {
      if (err instanceof DocumentExtractionError) return res.status(400).json({ error: "Could not read the uploaded document.", detail: err.message });
      throw err;
    }

    const totalSteps = 5;
    const jobId = await startJob("paper_intake", {
      version: f.version,
      paperFilename: paperFile.originalname,
      memoFilename: memoFile?.originalname ?? null,
      saqaQualificationId: f.saqaQualificationId ?? null,
      qualificationId: f.qualificationId ?? null,
    });

    runInBackground(jobId, async () => {
      // ---- 1. Qualification ----------------------------------------------------
      await setProgress(jobId, 1, totalSteps, "Identifying the qualification", f.saqaQualificationId ? `SAQA ID ${f.saqaQualificationId}` : f.title ?? undefined);
      let qualification: typeof qualifications.$inferSelect | undefined;
      let saqaExtractId: string | null = null;
      const warnings: string[] = [];

      if (f.qualificationId) {
        [qualification] = await db.select().from(qualifications).where(eq(qualifications.id, f.qualificationId));
        if (!qualification) return { error: "Qualification not found.", detail: f.qualificationId };
      }

      if (!qualification && f.saqaQualificationId) {
        [qualification] = await db.select().from(qualifications).where(eq(qualifications.saqaQualificationId, f.saqaQualificationId));
      }

      // Fetch the SAQA record when we have an ID: it gives the title/NQF for a
      // new qualification and, more importantly, the outcomes and criteria the
      // standard check measures the paper against.
      let saqa: Awaited<ReturnType<typeof fetchSaqaExtract>> | null = null;
      if (f.saqaQualificationId) {
        try {
          saqa = await fetchSaqaExtract(f.saqaQualificationId);
        } catch (err) {
          const detail = err instanceof SaqaExtractError ? err.message : String(err);
          if (!qualification && !f.title) {
            return {
              error: "Could not reach the SAQA record for that ID, and no title was given.",
              detail: `${detail} Type the qualification's title (and level) to continue without SAQA.`,
            };
          }
          warnings.push("The SAQA record could not be fetched, so the standard check will judge coverage against the paper's own references only.");
        }
      }

      if (!qualification) {
        const title = f.title ?? saqa?.title;
        if (!title) return { error: "Could not determine the qualification title.", detail: "Type it in the Title field." };
        [qualification] = await db
          .insert(qualifications)
          .values({
            title,
            qctoRegistrationType: f.qctoRegistrationType ?? guessType(title),
            saqaQualificationId: f.saqaQualificationId ?? null,
            nqfLevel: f.nqfLevel ?? saqa?.nqfLevel ?? null,
          })
          .returning();
      } else {
        // Fill in gaps on an existing qualification, never overwrite what's set.
        const patch: Partial<typeof qualifications.$inferInsert> = {};
        if (!qualification.nqfLevel && (f.nqfLevel ?? saqa?.nqfLevel)) patch.nqfLevel = f.nqfLevel ?? saqa?.nqfLevel ?? null;
        if (!qualification.saqaQualificationId && f.saqaQualificationId) patch.saqaQualificationId = f.saqaQualificationId;
        if (Object.keys(patch).length) {
          [qualification] = await db.update(qualifications).set(patch).where(eq(qualifications.id, qualification.id)).returning();
        }
      }

      if (saqa) {
        const [ex] = await db
          .insert(saqaQualificationExtracts)
          .values({
            qualificationId: qualification.id,
            saqaQualificationId: f.saqaQualificationId!,
            exitLevelOutcomes: saqa.exitLevelOutcomes,
            assessmentCriteria: saqa.assessmentCriteria,
            sourceUrl: saqa.sourceUrl,
            nqfLevel: saqa.nqfLevel,
          })
          .returning();
        saqaExtractId = ex.id;
      }

      // ---- 2. Read the paper -----------------------------------------------------
      await setProgress(jobId, 2, totalSteps, "Reading the paper and memo", memoFile ? `${paperFile.originalname} + ${memoFile.originalname}` : paperFile.originalname);
      let extracted;
      try {
        extracted = await extractPaper({
          qualificationTitle: qualification.title,
          paperText,
          memoText,
          paperFilename: paperFile.originalname,
          memoFilename: memoFile?.originalname,
        });
      } catch (err) {
        if (err instanceof PaperExtractionError) return { error: "Could not read the paper into questions.", detail: err.message };
        throw err;
      }
      warnings.push(...extracted.warnings);

      const timeAllocationMinutes = f.timeAllocationMinutes ?? extracted.timeAllocationMinutes;
      if (!timeAllocationMinutes) {
        return { error: "The paper does not state a time allocation.", detail: "Enter the time (minutes) on the form and upload again." };
      }

      // ---- 3. Save ---------------------------------------------------------------
      await setProgress(jobId, 3, totalSteps, "Saving the paper", `${extracted.questions.length} questions, ${extracted.questions.reduce((s, q) => s + q.maxMark, 0)} marks`);
      const [created] = await db
        .insert(assessmentInstruments)
        .values({
          qualificationId: qualification.id,
          version: f.version,
          questions: extracted.questions,
          timeAllocationMinutes,
          permittedMaterials: f.permittedMaterials
            ? f.permittedMaterials.split(",").map((m) => m.trim()).filter(Boolean)
            : [],
          passMarkOrCompetencyRule: extracted.passMarkOrCompetencyRule ? { rule: extracted.passMarkOrCompetencyRule } : { rule: "50% overall" },
          source: "uploaded_paper",
          saqaExtractId,
          intakeStatus: "checking",
          sourceFiles: [paperFile.originalname, ...(memoFile ? [memoFile.originalname] : [])],
        })
        .returning();

      // ---- 4. Standard check = gate ------------------------------------------------
      await setProgress(jobId, 4, totalSteps, "Checking the paper against the assessment standard", "Coverage of every outcome and criterion, Bloom's demand, marking guide quality");
      try {
        await runStandardCheck(created.id);
      } catch (err) {
        await db.update(assessmentInstruments).set({ intakeStatus: "blocked" }).where(eq(assessmentInstruments.id, created.id));
        warnings.push(`The standard check could not run (${err instanceof Error ? err.message : String(err)}). The paper is blocked until it is re-run from its page.`);
      }

      await setProgress(jobId, 5, totalSteps, "Saved");
      return { instrumentId: created.id, questionCount: extracted.questions.length, coverageNotes: warnings.join("\n") };
    });

    return res.status(202).json({ jobId });
  }
);

// ---- Results (administrator, read-only) ------------------------------------------

assessmentsRouter.get("/results", requireAuth, requireRole("administrator"), async (_req, res) => {
  const rows = await db
    .select({
      sessionId: learnerSessions.id,
      learnerName: users.name,
      learnerEmail: users.email,
      qualificationTitle: qualifications.title,
      qctoRegistrationType: qualifications.qctoRegistrationType,
      instrumentVersion: assessmentInstruments.version,
      sittingStart: examSittings.startTime,
      outcome: assessorDecisions.outcome,
      totalMark: assessorDecisions.totalMark,
      totalMax: assessorDecisions.totalMax,
      signedOffAt: assessorDecisions.signedOffAt,
      assessorId: assessorDecisions.assessorId,
      pushStatus: fptstaffResultPushes.status,
      pushSentAt: fptstaffResultPushes.sentAt,
    })
    .from(assessorDecisions)
    .innerJoin(learnerSessions, eq(assessorDecisions.sessionId, learnerSessions.id))
    .innerJoin(users, eq(learnerSessions.learnerId, users.id))
    .innerJoin(examSittings, eq(learnerSessions.sittingId, examSittings.id))
    .innerJoin(qualifications, eq(examSittings.qualificationId, qualifications.id))
    .innerJoin(assessmentInstruments, eq(examSittings.instrumentId, assessmentInstruments.id))
    .leftJoin(fptstaffResultPushes, eq(fptstaffResultPushes.sessionId, learnerSessions.id))
    .where(isNotNull(assessorDecisions.signedOffAt))
    .orderBy(desc(assessorDecisions.signedOffAt));

  const assessorIds = [...new Set(rows.map((r) => r.assessorId))];
  const assessors = assessorIds.length
    ? await db.select({ id: users.id, name: users.name }).from(users)
    : [];
  const nameOf = new Map(assessors.map((a) => [a.id, a.name]));

  return res.json(rows.map((r) => ({ ...r, assessorName: nameOf.get(r.assessorId) ?? "—" })));
});
