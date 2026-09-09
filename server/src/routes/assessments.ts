import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { eq, desc, isNotNull, and, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  assessmentInstruments,
  qualifications,
  saqaQualificationExtracts,
  qctoDocumentExtracts,
  assessorDecisions,
  learnerSessions,
  examSittings,
  users,
  fptstaffResultPushes,
  cohorts,
  auditLog,
} from "../db/schema.js";
import { requireAuth, requireRole, type AuthedRequest } from "../auth/middleware.js";
import { extractTextFromDocument, DocumentExtractionError } from "../integrations/qcto/extractDocumentText.js";
import { fetchSaqaExtract, SaqaExtractError } from "../integrations/saqa/fetchQualification.js";
import {
  isCurriculaBuilderConfigured,
  listCurriculaBuilderAssessments,
  fetchCurriculaBuilderAssessment,
  CurriculaBuilderError,
} from "../integrations/curriculaBuilder/client.js";
import { extractPaper, PaperExtractionError } from "../ai/paperExtraction.js";
import { normaliseOutcomes, looksMalformed } from "../ai/outcomeNormalisation.js";
import { generateInstrumentFromOutcomes } from "../ai/instrumentGeneration.js";
import { extractOutcomesFromDocumentText, DocumentOutcomeExtractionError } from "../ai/documentOutcomeExtraction.js";
import { startJob, runInBackground, setProgress, runStandardCheck, wordsProgress, type JobOutcome } from "./instruments.js";
import type { Question } from "../types.js";

// "Set up an Assessment" - four routes (docs/restructure-2026-09-05.md §2, rule of 9 Sep 2026).
//
//   QCTO FISA / EISA ........ linked in from Curricula Builder only. Never built here.
//   Legacy FISA ............. linked to SAQA; AI drafts the paper from the ELOs/ACs.
//   Build from scratch ...... outside the QCTO rules; own outcomes, a document, or an
//                             existing paper + memo; AI builds it; editable afterwards.
//   Other (Curricula Builder) CPD and other courses created on Curricula Builder.
//
//   POST /assessments/legacy-saqa/draft          { saqaQualificationId, version, timeAllocationMinutes, permittedMaterials? }
//   POST /assessments/build/draft                multipart: title|qualificationId, nqfLevel?, version, timeAllocationMinutes,
//                                                permittedMaterials?, and outcomes+criteria text OR a document file
//   POST /assessments/intake                     multipart: intakeRoute (legacy_saqa|built_here), paper (+memo), qualification fields
//   GET  /assessments/curricula-builder/status
//   GET  /assessments/curricula-builder/assessments?kind=qcto|other
//   POST /assessments/curricula-builder/import   { externalId, kind }
//   GET  /assessments/results
//
// Every drafting/import call answers 202 { jobId }; poll GET /instruments/jobs/:id.

export const assessmentsRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 2 } });

const OCCUPATIONAL = /occupational\s+certificate/i;
const splitCsv = (s?: string) => (s ? s.split(",").map((m) => m.trim()).filter(Boolean) : []);
const splitLines = (s?: string) =>
  (s ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)]|[A-Za-z]{1,3}\s*\d+(?:\.\d+)*[.):]?)\s+/, "").trim())
    .filter(Boolean);

// SAQA's legacy pages often come through with preambles, run-on lists and
// exit-point notes among the outcomes. Tidy them before anything is measured
// against them; the raw read is kept in the job's notes for the audit trail.
async function tidySaqa(extract: Awaited<ReturnType<typeof fetchSaqaExtract>>, title: string, warnings: string[]) {
  if (!looksMalformed(extract.exitLevelOutcomes, extract.assessmentCriteria)) return extract;
  try {
    const n = await normaliseOutcomes({ qualificationTitle: title, exitLevelOutcomes: extract.exitLevelOutcomes, assessmentCriteria: extract.assessmentCriteria });
    if (n.changed) warnings.push(`SAQA's list was tidied before use (${extract.exitLevelOutcomes.length} → ${n.exitLevelOutcomes.length} outcomes, ${extract.assessmentCriteria.length} → ${n.assessmentCriteria.length} criteria). ${n.notes}`);
    return { ...extract, exitLevelOutcomes: n.exitLevelOutcomes, assessmentCriteria: n.assessmentCriteria };
  } catch (err) {
    warnings.push(`SAQA's list could not be tidied (${err instanceof Error ? err.message : String(err)}); used as read.`);
    return extract;
  }
}

// The tail every drafting route shares once outcomes and criteria are in hand: draft the
// paper, save it, run the standard check (= the gate), report.
async function draftSaveCheck(
  jobId: string,
  step: { from: number; total: number },
  p: {
    qualification: typeof qualifications.$inferSelect;
    exitLevelOutcomes: string[];
    assessmentCriteria: string[];
    sourceDescription: string;
    version: string;
    timeAllocationMinutes: number;
    permittedMaterials: string[];
    source: "ai_generated" | "qcto_upload";
    intakeRoute: "legacy_saqa" | "built_here";
    saqaExtractId?: string | null;
    qctoExtractId?: string | null;
    sourceFiles?: string[] | null;
  }
): Promise<JobOutcome> {
  await setProgress(jobId, step.from, step.total, "Drafting questions and marking rubrics", `${p.exitLevelOutcomes.length} outcomes, ${p.assessmentCriteria.length} criteria - this is the long step`);
  let generated;
  try {
    generated = await generateInstrumentFromOutcomes({
      qualificationTitle: p.qualification.title,
      qctoRegistrationType: p.qualification.qctoRegistrationType,
      exitLevelOutcomes: p.exitLevelOutcomes,
      assessmentCriteria: p.assessmentCriteria,
      timeAllocationMinutes: p.timeAllocationMinutes,
      permittedMaterials: p.permittedMaterials,
      sourceDescription: p.sourceDescription,
      nqfLevel: p.qualification.nqfLevel,
    }, wordsProgress(jobId, step.from, step.total, "Drafting questions and marking rubrics", `${p.exitLevelOutcomes.length} outcomes, ${p.assessmentCriteria.length} criteria`));
  } catch (err) {
    return { error: "The AI could not draft an assessment from these outcomes.", detail: err instanceof Error ? err.message : String(err) };
  }

  const [created] = await db
    .insert(assessmentInstruments)
    .values({
      qualificationId: p.qualification.id,
      version: p.version,
      questions: generated.questions,
      timeAllocationMinutes: p.timeAllocationMinutes,
      permittedMaterials: p.permittedMaterials,
      passMarkOrCompetencyRule: { rule: generated.passMarkOrCompetencyRule },
      source: p.source,
      intakeRoute: p.intakeRoute,
      saqaExtractId: p.saqaExtractId ?? null,
      qctoExtractId: p.qctoExtractId ?? null,
      sourceFiles: p.sourceFiles ?? null,
      intakeStatus: "checking",
    })
    .returning();

  await setProgress(jobId, step.from + 1, step.total, "Checking the paper against the assessment standard", `${generated.questions.length} questions drafted - coverage, Bloom's demand, rubrics`);
  try {
    await runStandardCheck(created.id, wordsProgress(jobId, step.from + 1, step.total, "Checking the paper against the assessment standard", `${generated.questions.length} questions · moderator's report`));
  } catch (err) {
    await db.update(assessmentInstruments).set({ intakeStatus: "blocked" }).where(eq(assessmentInstruments.id, created.id));
    console.error(`Standard check failed for instrument ${created.id}:`, err);
  }
  await setProgress(jobId, step.total, step.total, "Saved");
  return { instrumentId: created.id, questionCount: generated.questions.length, coverageNotes: generated.coverageNotes };
}

// ---------------------------------------------------------------------------------
// Route: Legacy FISA - link to SAQA, draft from the registered ELOs/ACs.
// ---------------------------------------------------------------------------------

const legacyDraftSchema = z.object({
  saqaQualificationId: z.string().trim().min(1),
  version: z.string().trim().min(1),
  timeAllocationMinutes: z.number().int().positive(),
  permittedMaterials: z.array(z.string()).optional(),
});

assessmentsRouter.post("/legacy-saqa/draft", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  const parsed = legacyDraftSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });
  const { saqaQualificationId: saqaId, version, timeAllocationMinutes } = parsed.data;
  const permittedMaterials = parsed.data.permittedMaterials ?? [];

  const total = 5;
  const jobId = await startJob("ai_instrument_generation", { path: "legacy_saqa", saqaQualificationId: saqaId, version, timeAllocationMinutes });

  runInBackground(jobId, async () => {
    await setProgress(jobId, 1, total, "Fetching the SAQA record", `SAQA qualification ID ${saqaId}`);
    let extract;
    try {
      extract = await fetchSaqaExtract(saqaId);
    } catch (err) {
      if (err instanceof SaqaExtractError) return { error: "Could not extract data from SAQA.", detail: err.message };
      throw err;
    }

    // The rule: a QCTO occupational qualification's paper may only come from Curricula
    // Builder. SAQA also lists occupational qualifications, so refuse them here.
    if (extract.title && OCCUPATIONAL.test(extract.title)) {
      return {
        error: "This is a QCTO occupational qualification, not a legacy one.",
        detail: `SAQA ${saqaId} is "${extract.title}". Its FISA/EISA paper must be linked in from Curricula Builder - FPT Exam does not build QCTO papers.`,
      };
    }

    await setProgress(jobId, 2, total, "Extracting outcomes and criteria", `${extract.exitLevelOutcomes.length} Exit Level Outcomes, ${extract.assessmentCriteria.length} Assessment Criteria${extract.nqfLevel ? `, NQF Level ${extract.nqfLevel}` : ""}`);
    const warnings: string[] = [];
    extract = await tidySaqa(extract, extract.title ?? `SAQA ${saqaId}`, warnings);

    let [qualification] = await db.select().from(qualifications).where(eq(qualifications.saqaQualificationId, saqaId));
    if (!qualification) {
      if (!extract.title) return { error: "SAQA did not give a qualification title for that ID.", detail: "Check the SAQA ID and try again." };
      [qualification] = await db
        .insert(qualifications)
        .values({ title: extract.title, qctoRegistrationType: "fisa", saqaQualificationId: saqaId, nqfLevel: extract.nqfLevel ?? null })
        .returning();
    } else if (!qualification.nqfLevel && extract.nqfLevel) {
      [qualification] = await db.update(qualifications).set({ nqfLevel: extract.nqfLevel }).where(eq(qualifications.id, qualification.id)).returning();
    }

    const [extractRow] = await db
      .insert(saqaQualificationExtracts)
      .values({
        qualificationId: qualification.id,
        saqaQualificationId: saqaId,
        exitLevelOutcomes: extract.exitLevelOutcomes,
        assessmentCriteria: extract.assessmentCriteria,
        sourceUrl: extract.sourceUrl,
        nqfLevel: extract.nqfLevel,
      })
      .returning();

    const outcome = await draftSaveCheck(jobId, { from: 3, total }, {
      qualification,
      exitLevelOutcomes: extract.exitLevelOutcomes,
      assessmentCriteria: extract.assessmentCriteria,
      sourceDescription: "as published by SAQA",
      version,
      timeAllocationMinutes,
      permittedMaterials,
      source: "ai_generated",
      intakeRoute: "legacy_saqa",
      saqaExtractId: extractRow.id,
    });
    if ("coverageNotes" in outcome && warnings.length) outcome.coverageNotes = [...warnings, outcome.coverageNotes].filter(Boolean).join("\n\n");
    return outcome;
  });

  return res.status(202).json({ jobId });
});

// ---------------------------------------------------------------------------------
// Route: Build from scratch - outside the QCTO rules. Title + own outcomes/criteria,
// or a document the outcomes are read from; the AI drafts the paper.
// ---------------------------------------------------------------------------------

const buildFields = z.object({
  qualificationId: z.string().uuid().optional(),
  title: z.string().trim().min(1).optional(),
  nqfLevel: z.coerce.number().int().min(1).max(10).optional(),
  version: z.string().trim().min(1),
  timeAllocationMinutes: z.coerce.number().int().positive(),
  permittedMaterials: z.string().optional(),
  outcomes: z.string().optional(), // one per line
  criteria: z.string().optional(), // one per line
});

// Finds or creates the non-QCTO "qualification" a built-here assessment hangs off. An
// existing QCTO qualification cannot be chosen: that would be building a QCTO paper here.
async function resolveNonQctoQualification(f: { qualificationId?: string; title?: string; nqfLevel?: number }) {
  if (f.qualificationId) {
    const [q] = await db.select().from(qualifications).where(eq(qualifications.id, f.qualificationId));
    if (!q) return { error: "Qualification not found." };
    if (q.qctoRegistrationType !== "non_qcto") {
      return { error: "That is a QCTO qualification.", detail: "A QCTO FISA/EISA paper must be linked in from Curricula Builder (or, for a legacy qualification, drafted from SAQA). Build from scratch is for assessments outside the QCTO rules." };
    }
    return { qualification: q };
  }
  if (!f.title) return { error: "Give the assessment a title." };
  if (OCCUPATIONAL.test(f.title)) {
    return { error: "That title names a QCTO occupational qualification.", detail: "Its paper must be linked in from Curricula Builder - FPT Exam does not build QCTO papers." };
  }
  const [existing] = await db.select().from(qualifications).where(and(eq(qualifications.title, f.title), eq(qualifications.qctoRegistrationType, "non_qcto")));
  if (existing) return { qualification: existing };
  const [created] = await db
    .insert(qualifications)
    .values({ title: f.title, qctoRegistrationType: "non_qcto", nqfLevel: f.nqfLevel ?? null })
    .returning();
  return { qualification: created };
}

assessmentsRouter.post("/build/draft", requireAuth, requireRole("administrator"), upload.single("document"), async (req: AuthedRequest, res) => {
  const parsed = buildFields.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });
  const f = parsed.data;
  const typedOutcomes = splitLines(f.outcomes);
  const typedCriteria = splitLines(f.criteria);
  const file = req.file;
  if (!file && typedOutcomes.length === 0) {
    return res.status(400).json({ error: "Give the outcomes this assessment must test - type them in, or upload a document that contains them." });
  }

  const resolved = await resolveNonQctoQualification(f);
  if ("error" in resolved) return res.status(400).json(resolved);
  const qualification = resolved.qualification;
  const permittedMaterials = splitCsv(f.permittedMaterials);

  // Read the document now - a bad file should fail the request, not the job.
  let rawText: string | null = null;
  if (file) {
    try {
      rawText = await extractTextFromDocument(file.buffer, file.mimetype, file.originalname);
    } catch (err) {
      if (err instanceof DocumentExtractionError) return res.status(400).json({ error: "Could not read the uploaded document.", detail: err.message });
      throw err;
    }
  }

  const total = file ? 4 : 3;
  const jobId = await startJob("ai_instrument_generation", {
    path: "built_here",
    qualificationId: qualification.id,
    version: f.version,
    timeAllocationMinutes: f.timeAllocationMinutes,
    originalFilename: file?.originalname ?? null,
  });

  runInBackground(jobId, async () => {
    let exitLevelOutcomes = typedOutcomes;
    let assessmentCriteria = typedCriteria;
    let sourceDescription = "as stated by the Administrator who set the assessment up";
    let originalFilename = "typed:administrator";

    if (file && rawText) {
      await setProgress(jobId, 1, total, "Reading outcomes and criteria from the document", file.originalname);
      try {
        const extracted = await extractOutcomesFromDocumentText(rawText, qualification.title);
        // Anything typed alongside the document is added, not replaced.
        exitLevelOutcomes = [...extracted.exitLevelOutcomes, ...typedOutcomes];
        assessmentCriteria = [...extracted.assessmentCriteria, ...typedCriteria];
      } catch (err) {
        if (err instanceof DocumentOutcomeExtractionError) {
          if (typedOutcomes.length === 0) return { error: "Could not identify outcomes or criteria in the uploaded document.", detail: err.message };
        } else throw err;
      }
      sourceDescription = `as extracted from the uploaded document "${file.originalname}"${typedOutcomes.length ? " and as typed by the Administrator" : ""}`;
      originalFilename = file.originalname;
    }
    if (exitLevelOutcomes.length === 0) return { error: "No outcomes to build from.", detail: "Type at least one outcome, or upload a document that lists them." };

    const [extractRow] = await db
      .insert(qctoDocumentExtracts)
      .values({ qualificationId: qualification.id, originalFilename, exitLevelOutcomes, assessmentCriteria })
      .returning();

    return draftSaveCheck(jobId, { from: total - 2, total }, {
      qualification,
      exitLevelOutcomes,
      assessmentCriteria,
      sourceDescription,
      version: f.version,
      timeAllocationMinutes: f.timeAllocationMinutes,
      permittedMaterials,
      source: "qcto_upload",
      intakeRoute: "built_here",
      qctoExtractId: extractRow.id,
      sourceFiles: file ? [file.originalname] : null,
    });
  });

  return res.status(202).json({ jobId });
});

// ---------------------------------------------------------------------------------
// Upload an existing paper (+ memo) - allowed on the Legacy FISA route (checked against
// the SAQA outcomes) and on Build from scratch (outside the QCTO rules). Never for QCTO.
// ---------------------------------------------------------------------------------

const intakeFields = z.object({
  intakeRoute: z.enum(["legacy_saqa", "built_here"]),
  version: z.string().trim().min(1),
  // Legacy FISA: the SAQA ID identifies the qualification.
  saqaQualificationId: z.string().trim().min(1).optional(),
  // Build from scratch: an existing non-QCTO one, or a title (+ level) to create one.
  qualificationId: z.string().uuid().optional(),
  title: z.string().trim().min(1).optional(),
  nqfLevel: z.coerce.number().int().min(1).max(10).optional(),
  // Optional overrides of what the paper states.
  timeAllocationMinutes: z.coerce.number().int().positive().optional(),
  permittedMaterials: z.string().optional(),
});

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
    if (f.intakeRoute === "legacy_saqa" && !f.saqaQualificationId) return res.status(400).json({ error: "Enter the SAQA qualification ID for a legacy FISA paper." });
    if (f.intakeRoute === "built_here" && !f.qualificationId && !f.title) return res.status(400).json({ error: "Give the assessment a title, or pick an existing one." });

    // Build from scratch: settle the (non-QCTO) qualification before the job starts.
    let builtQualification: typeof qualifications.$inferSelect | null = null;
    if (f.intakeRoute === "built_here") {
      const resolved = await resolveNonQctoQualification(f);
      if ("error" in resolved) return res.status(400).json(resolved);
      builtQualification = resolved.qualification;
    }

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
      intakeRoute: f.intakeRoute,
      version: f.version,
      paperFilename: paperFile.originalname,
      memoFilename: memoFile?.originalname ?? null,
      saqaQualificationId: f.saqaQualificationId ?? null,
      qualificationId: builtQualification?.id ?? null,
    });

    runInBackground(jobId, async () => {
      const warnings: string[] = [];
      let qualification = builtQualification;
      let saqaExtractId: string | null = null;

      // ---- 1. Qualification ----------------------------------------------------
      await setProgress(jobId, 1, totalSteps, "Identifying the qualification", f.saqaQualificationId ? `SAQA ID ${f.saqaQualificationId}` : qualification?.title);
      if (f.intakeRoute === "legacy_saqa") {
        const saqaId = f.saqaQualificationId!;
        let saqa: Awaited<ReturnType<typeof fetchSaqaExtract>> | null = null;
        try {
          saqa = await fetchSaqaExtract(saqaId);
        } catch (err) {
          const detail = err instanceof SaqaExtractError ? err.message : String(err);
          [qualification] = await db.select().from(qualifications).where(eq(qualifications.saqaQualificationId, saqaId));
          if (!qualification) return { error: "Could not reach the SAQA record for that ID.", detail };
          warnings.push("The SAQA record could not be fetched, so the standard check judges coverage against the paper's own references only.");
        }
        if (saqa?.title && OCCUPATIONAL.test(saqa.title)) {
          return {
            error: "This is a QCTO occupational qualification, not a legacy one.",
            detail: `SAQA ${saqaId} is "${saqa.title}". Its FISA/EISA paper must be linked in from Curricula Builder.`,
          };
        }
        if (saqa) saqa = await tidySaqa(saqa, saqa.title ?? `SAQA ${saqaId}`, warnings);
        if (!qualification) [qualification] = await db.select().from(qualifications).where(eq(qualifications.saqaQualificationId, saqaId));
        if (!qualification) {
          if (!saqa?.title) return { error: "SAQA did not give a qualification title for that ID.", detail: "Check the SAQA ID and try again." };
          [qualification] = await db
            .insert(qualifications)
            .values({ title: saqa.title, qctoRegistrationType: "fisa", saqaQualificationId: saqaId, nqfLevel: saqa.nqfLevel ?? null })
            .returning();
        } else if (!qualification.nqfLevel && saqa?.nqfLevel) {
          [qualification] = await db.update(qualifications).set({ nqfLevel: saqa.nqfLevel }).where(eq(qualifications.id, qualification.id)).returning();
        }
        if (saqa) {
          const [ex] = await db
            .insert(saqaQualificationExtracts)
            .values({
              qualificationId: qualification.id,
              saqaQualificationId: saqaId,
              exitLevelOutcomes: saqa.exitLevelOutcomes,
              assessmentCriteria: saqa.assessmentCriteria,
              sourceUrl: saqa.sourceUrl,
              nqfLevel: saqa.nqfLevel,
            })
            .returning();
          saqaExtractId = ex.id;
        }
      }
      if (!qualification) return { error: "Could not determine the qualification.", detail: "Try again." };

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
        }, wordsProgress(jobId, 2, totalSteps, "Reading the paper and memo", "questions, marks and memo read so far"));
      } catch (err) {
        if (err instanceof PaperExtractionError) return { error: "Could not read the paper into questions.", detail: err.message };
        throw err;
      }
      warnings.push(...extracted.warnings);

      const timeAllocationMinutes = f.timeAllocationMinutes ?? extracted.timeAllocationMinutes;
      if (!timeAllocationMinutes) return { error: "The paper does not state a time allocation.", detail: "Enter the time (minutes) on the form and upload again." };

      // ---- 3. Save ---------------------------------------------------------------
      await setProgress(jobId, 3, totalSteps, "Saving the paper", `${extracted.questions.length} questions, ${extracted.questions.reduce((s, q) => s + q.maxMark, 0)} marks`);
      const [created] = await db
        .insert(assessmentInstruments)
        .values({
          qualificationId: qualification.id,
          version: f.version,
          questions: extracted.questions,
          timeAllocationMinutes,
          permittedMaterials: splitCsv(f.permittedMaterials),
          passMarkOrCompetencyRule: extracted.passMarkOrCompetencyRule ? { rule: extracted.passMarkOrCompetencyRule } : { rule: "50% overall" },
          source: "uploaded_paper",
          intakeRoute: f.intakeRoute,
          saqaExtractId,
          intakeStatus: "checking",
          sourceFiles: [paperFile.originalname, ...(memoFile ? [memoFile.originalname] : [])],
        })
        .returning();

      // ---- 4. Standard check = gate ------------------------------------------------
      await setProgress(jobId, 4, totalSteps, "Checking the paper against the assessment standard", "Coverage of every outcome and criterion, Bloom's demand, marking guide quality");
      try {
        await runStandardCheck(created.id, wordsProgress(jobId, 4, totalSteps, "Checking the paper against the assessment standard", "moderator's report"));
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

// ---------------------------------------------------------------------------------
// Routes: QCTO FISA/EISA and Other courses - linked in from Curricula Builder.
// ---------------------------------------------------------------------------------

assessmentsRouter.get("/curricula-builder/status", requireAuth, requireRole("administrator"), (_req, res) => {
  res.json({ connected: isCurriculaBuilderConfigured() });
});

assessmentsRouter.get("/curricula-builder/assessments", requireAuth, requireRole("administrator"), async (req, res) => {
  const kind = req.query.kind === "other" ? "other" : "qcto";
  if (!isCurriculaBuilderConfigured()) return res.status(503).json({ error: "Curricula Builder is not connected yet.", detail: "Set CURRICULA_BUILDER_BASE_URL and CURRICULA_BUILDER_API_KEY in the Repl's Secrets." });
  try {
    const list = await listCurriculaBuilderAssessments(kind);
    // Mark the ones already on FPT Exam so the same version is not pulled twice.
    const existing = await db
      .select({ externalRef: assessmentInstruments.externalRef, version: assessmentInstruments.version, id: assessmentInstruments.id })
      .from(assessmentInstruments)
      .where(isNotNull(assessmentInstruments.externalRef));
    const have = new Map(existing.map((e) => [`${e.externalRef}@@${e.version}`, e.id]));
    return res.json(list.map((a) => ({ ...a, importedInstrumentId: have.get(`${a.id}@@${a.version}`) ?? null })));
  } catch (err) {
    if (err instanceof CurriculaBuilderError) return res.status(502).json({ error: "Curricula Builder could not be read.", detail: err.message });
    throw err;
  }
});

const importSchema = z.object({ externalId: z.string().min(1), kind: z.enum(["qcto", "other"]) });

assessmentsRouter.post("/curricula-builder/import", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });
  if (!isCurriculaBuilderConfigured()) return res.status(503).json({ error: "Curricula Builder is not connected yet.", detail: "Set CURRICULA_BUILDER_BASE_URL and CURRICULA_BUILDER_API_KEY in the Repl's Secrets." });
  const { externalId, kind } = parsed.data;
  const intakeRoute = kind === "qcto" ? "qcto_curricula_builder" : "curricula_builder_other";
  const total = 4;
  const jobId = await startJob("curricula_builder_import", { externalId, kind });

  runInBackground(jobId, async () => {
    await setProgress(jobId, 1, total, "Fetching the assessment from Curricula Builder", externalId);
    let cb;
    try {
      cb = await fetchCurriculaBuilderAssessment(externalId);
    } catch (err) {
      if (err instanceof CurriculaBuilderError) return { error: "Curricula Builder could not be read.", detail: err.message };
      throw err;
    }
    if (cb.kind !== kind) return { error: "Curricula Builder classifies this assessment differently.", detail: `It is "${cb.kind}", you chose "${kind}". Use the matching route.` };

    const [dupe] = await db
      .select({ id: assessmentInstruments.id })
      .from(assessmentInstruments)
      .where(and(eq(assessmentInstruments.externalRef, cb.id), eq(assessmentInstruments.version, cb.version)));
    if (dupe) return { error: "This version is already on FPT Exam.", detail: `Curricula Builder ${cb.id} version ${cb.version} was imported before. Release a new version on Curricula Builder to pull it again.` };

    await setProgress(jobId, 2, total, "Identifying the qualification", cb.qualificationTitle);
    const type = kind === "other" ? "non_qcto" : (cb.qctoRegistrationType ?? (OCCUPATIONAL.test(cb.qualificationTitle) ? "eisa" : "fisa"));
    let qualification: typeof qualifications.$inferSelect | undefined;
    if (cb.saqaQualificationId) [qualification] = await db.select().from(qualifications).where(eq(qualifications.saqaQualificationId, cb.saqaQualificationId));
    if (!qualification) [qualification] = await db.select().from(qualifications).where(and(eq(qualifications.title, cb.qualificationTitle), eq(qualifications.qctoRegistrationType, type)));
    if (!qualification) {
      [qualification] = await db
        .insert(qualifications)
        .values({ title: cb.qualificationTitle, qctoRegistrationType: type, saqaQualificationId: cb.saqaQualificationId ?? null, nqfLevel: cb.nqfLevel ?? null })
        .returning();
    } else if (!qualification.nqfLevel && cb.nqfLevel) {
      [qualification] = await db.update(qualifications).set({ nqfLevel: cb.nqfLevel }).where(eq(qualifications.id, qualification.id)).returning();
    }

    // Curricula Builder's outcomes are the reference list the standard check measures against.
    let qctoExtractId: string | null = null;
    if (cb.exitLevelOutcomes.length) {
      const [ex] = await db
        .insert(qctoDocumentExtracts)
        .values({ qualificationId: qualification.id, originalFilename: `curricula-builder:${cb.id}`, exitLevelOutcomes: cb.exitLevelOutcomes, assessmentCriteria: cb.assessmentCriteria })
        .returning();
      qctoExtractId = ex.id;
    }

    const [created] = await db
      .insert(assessmentInstruments)
      .values({
        qualificationId: qualification.id,
        version: cb.version,
        questions: cb.questions as Question[],
        timeAllocationMinutes: cb.timeAllocationMinutes,
        permittedMaterials: cb.permittedMaterials,
        passMarkOrCompetencyRule: { rule: cb.passMarkOrCompetencyRule ?? "50% overall" },
        source: "curricula_builder",
        intakeRoute,
        externalRef: cb.id,
        qctoExtractId,
        intakeStatus: "checking",
        sourceFiles: [`Curricula Builder · ${cb.title}`],
      })
      .returning();

    await setProgress(jobId, 3, total, "Checking the paper against the assessment standard", `${cb.questions.length} questions`);
    try {
      await runStandardCheck(created.id);
    } catch (err) {
      await db.update(assessmentInstruments).set({ intakeStatus: "blocked" }).where(eq(assessmentInstruments.id, created.id));
      console.error(`Standard check failed for instrument ${created.id}:`, err);
    }
    await setProgress(jobId, 4, total, "Saved");
    return { instrumentId: created.id, questionCount: cb.questions.length, coverageNotes: "" };
  });

  return res.status(202).json({ jobId });
});

// ---- Results (administrator, read-only) ------------------------------------------

const resultsQuery = z.object({
  cohortId: z.string().uuid().optional(),
  qualificationId: z.string().uuid().optional(),
  outcome: z.enum(["competent", "not_yet_competent"]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  q: z.string().trim().max(120).optional(),
});

// Signed-off results, filterable by cohort, qualification, outcome, date and
// learner; the same filter feeds the CSV results sheet below.
async function resultRows(f: z.infer<typeof resultsQuery>) {
  const where = and(
    isNotNull(assessorDecisions.signedOffAt),
    f.cohortId ? eq(examSittings.cohortId, f.cohortId) : undefined,
    f.qualificationId ? eq(examSittings.qualificationId, f.qualificationId) : undefined,
    f.outcome ? eq(assessorDecisions.outcome, f.outcome) : undefined,
    f.from ? sql`${assessorDecisions.signedOffAt} >= ${new Date(f.from)}` : undefined,
    f.to ? sql`${assessorDecisions.signedOffAt} <= ${new Date(f.to)}` : undefined,
    f.q ? sql`(${users.name} ILIKE ${"%" + f.q + "%"} OR ${users.email} ILIKE ${"%" + f.q + "%"} OR ${users.studentNumber} ILIKE ${"%" + f.q + "%"})` : undefined
  );
  const rows = await db
    .select({
      sessionId: learnerSessions.id,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      studentNumber: users.studentNumber,
      idNumberLast4: users.idNumberLast4,
      cohortId: examSittings.cohortId,
      cohortName: cohorts.name,
      sittingName: examSittings.name,
      qualificationTitle: qualifications.title,
      qctoRegistrationType: qualifications.qctoRegistrationType,
      instrumentVersion: assessmentInstruments.version,
      intakeRoute: assessmentInstruments.intakeRoute,
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
    .leftJoin(cohorts, eq(cohorts.id, examSittings.cohortId))
    .leftJoin(fptstaffResultPushes, eq(fptstaffResultPushes.sessionId, learnerSessions.id))
    .where(where)
    .orderBy(desc(assessorDecisions.signedOffAt))
    .limit(20000);
  const assessorIds = [...new Set(rows.map((r) => r.assessorId))];
  const assessors = assessorIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, assessorIds)) : [];
  const nameOf = new Map(assessors.map((a) => [a.id, a.name]));
  return rows.map((r) => ({ ...r, assessorName: nameOf.get(r.assessorId) ?? "—", idNumberMasked: r.idNumberLast4 ? `••••••••• ${r.idNumberLast4}` : null }));
}

assessmentsRouter.get("/results", requireAuth, requireRole("administrator"), async (req, res) => {
  const parsed = resultsQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid query.", detail: parsed.error.message });
  return res.json(await resultRows(parsed.data));
});

// The results sheet: one row per released result under the current filter.
// Full ID numbers are never in it; the Statement of Results (Block 5) is the
// only document that carries them.
assessmentsRouter.get("/results/export.csv", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  const parsed = resultsQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid query." });
  const rows = await resultRows(parsed.data);
  const esc = (v: unknown) => {
    const t = v == null ? "" : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const header = ["learner", "email", "id_number_last4", "student_number", "cohort", "qualification", "paper", "sitting", "sat_on", "mark", "out_of", "percent", "outcome", "assessor", "signed_off_on", "fptstaff"];
  const lines = [header.join(",")];
  for (const r of rows) {
    const pct = r.totalMark != null && r.totalMax ? Math.round((r.totalMark / r.totalMax) * 1000) / 10 : "";
    lines.push([r.learnerName, r.learnerEmail, r.idNumberLast4, r.studentNumber, r.cohortName, r.qualificationTitle, r.instrumentVersion, r.sittingName, r.sittingStart.toISOString().slice(0, 10), r.totalMark, r.totalMax, pct, r.outcome === "competent" ? "Competent" : "Not yet competent", r.assessorName, r.signedOffAt?.toISOString().slice(0, 10), r.pushStatus ?? "pending"].map(esc).join(","));
  }
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "results_exported", targetType: "result", targetId: null, reason: `${rows.length} rows${parsed.data.cohortId ? " (cohort filter)" : ""}` });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="fpt-exam-results-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join("\n") + "\n");
});
