import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  assessmentInstruments,
  qualifications,
  saqaQualificationExtracts,
  qctoDocumentExtracts,
  backgroundJobs,
} from "../db/schema.js";
import { requireAuth, requireRole, type AuthedRequest } from "../auth/middleware.js";
import { fetchSaqaExtract, SaqaExtractError } from "../integrations/saqa/fetchQualification.js";
import {
  extractTextFromDocument,
  DocumentExtractionError,
} from "../integrations/qcto/extractDocumentText.js";
import { generateInstrumentFromSaqa, generateInstrumentFromOutcomes } from "../ai/instrumentGeneration.js";
import {
  extractOutcomesFromDocumentText,
  DocumentOutcomeExtractionError,
} from "../ai/documentOutcomeExtraction.js";

// Memory storage (not disk) - documents are small (a QAS document is a few
// pages), we only need the buffer transiently to pull text out of it, and
// nothing about the original file needs to persist once that's done.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

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

type JobOutcome =
  | { instrumentId: string; questionCount: number; coverageNotes: string }
  | { error: string; detail: string };

async function startJob(jobType: string, payload: Record<string, unknown>): Promise<string> {
  const [job] = await db
    .insert(backgroundJobs)
    .values({ jobType, payload, status: "running", attempts: 1 })
    .returning();
  return job.id;
}

async function finishJob(jobId: string, outcome: JobOutcome): Promise<void> {
  await db
    .update(backgroundJobs)
    .set({ status: "error" in outcome ? "failed" : "done", result: outcome })
    .where(eq(backgroundJobs.id, jobId));
}

// Fire-and-forget wrapper: whatever the work throws becomes a failed job with
// a readable reason rather than an unhandled rejection.
function runInBackground(jobId: string, work: () => Promise<JobOutcome>): void {
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
    if (job.status === "done" && result && "instrumentId" in result) {
      const [instrument] = await db
        .select()
        .from(assessmentInstruments)
        .where(eq(assessmentInstruments.id, result.instrumentId));
      return res.json({ status: "done", instrument, coverageNotes: result.coverageNotes, questionCount: result.questionCount });
    }
    if (job.status === "failed" && result && "error" in result) {
      return res.json({ status: "failed", error: result.error, detail: result.detail });
    }
    return res.json({ status: job.status });
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
});

const createSchema = z.object({
  qualificationId: z.string().uuid(),
  version: z.string().min(1),
  questions: z.array(questionSchema).min(1),
  timeAllocationMinutes: z.number().int().positive(),
  permittedMaterials: z.array(z.string()).optional(),
  passMarkOrCompetencyRule: z.string().optional(),
});

// v1 intake per Section 5 of the spec: manual entry against the defined
// schema. `source` is always 'manual' here - a v2 `/instruments/import`
// route (Curricula Builder, once it exists) would populate the same table
// with source='curricula_builder' and no other code needs to change.
instrumentsRouter.post(
  "/",
  requireAuth,
  requireRole("administrator"),
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

const updateSchema = z.object({
  version: z.string().min(1).optional(),
  questions: z.array(questionSchema).min(1).optional(),
  timeAllocationMinutes: z.number().int().positive().optional(),
  permittedMaterials: z.array(z.string()).optional(),
  passMarkOrCompetencyRule: z.string().optional(),
});

// Lets an Administrator edit any instrument after creation - manual,
// AI-generated, or (once it exists) Curricula Builder-imported. This is how
// an AI-drafted paper gets corrected in practice: FPT Academy chose not to
// require a review/approval step before an AI-generated instrument can be
// scheduled (build brief Section 5.6), so editing it afterward is the
// expected path rather than a formal gate.
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
    const { passMarkOrCompetencyRule, ...rest } = parsed.data;
    const [updated] = await db
      .update(assessmentInstruments)
      .set({
        ...rest,
        ...(passMarkOrCompetencyRule !== undefined
          ? { passMarkOrCompetencyRule: { rule: passMarkOrCompetencyRule } }
          : {}),
      })
      .where(eq(assessmentInstruments.id, req.params.id))
      .returning();
    if (!updated) return res.status(404).json({ error: "Instrument not found." });
    return res.json(updated);
  }
);

const generateSchema = z.object({
  qualificationId: z.string().uuid(),
  version: z.string().min(1),
  timeAllocationMinutes: z.number().int().positive(),
  permittedMaterials: z.array(z.string()).optional(),
});

// AI-from-SAQA intake path (spec Section 5, build brief Section 5.6): fetch
// the qualification's public SAQA page, extract its Exit Level Outcomes and
// Associated Assessment Criteria, hand them to the Instrument Generation
// Engine, and store the result as a normal instrument (source='ai_generated').
// No review/approval gate before it's usable - that was FPT Academy's
// explicit call - but the SAQA extract used is stored (saqa_extract_id) so
// exactly what justified the paper stays auditable.
instrumentsRouter.post(
  "/generate",
  requireAuth,
  requireRole("administrator"),
  async (req: AuthedRequest, res) => {
    const parsed = generateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });
    }
    const { qualificationId, version, timeAllocationMinutes, permittedMaterials } = parsed.data;

    const [qualification] = await db
      .select()
      .from(qualifications)
      .where(eq(qualifications.id, qualificationId));
    if (!qualification) return res.status(404).json({ error: "Qualification not found." });
    if (!qualification.saqaQualificationId) {
      return res.status(400).json({
        error:
          "This qualification has no SAQA qualification ID set. Set one with PATCH /qualifications/:id first.",
      });
    }

    const saqaId = qualification.saqaQualificationId;
    const jobId = await startJob("ai_instrument_generation", {
      path: "saqa",
      qualificationId,
      saqaQualificationId: saqaId,
      version,
      timeAllocationMinutes,
    });

    runInBackground(jobId, async () => {
      let extract;
      try {
        extract = await fetchSaqaExtract(saqaId);
      } catch (err) {
        if (err instanceof SaqaExtractError) {
          return { error: "Could not extract data from SAQA.", detail: err.message };
        }
        throw err;
      }

      const [extractRow] = await db
        .insert(saqaQualificationExtracts)
        .values({
          qualificationId,
          saqaQualificationId: saqaId,
          exitLevelOutcomes: extract.exitLevelOutcomes,
          assessmentCriteria: extract.assessmentCriteria,
          sourceUrl: extract.sourceUrl,
        })
        .returning();

      let generated;
      try {
        generated = await generateInstrumentFromSaqa({
          qualificationTitle: qualification.title,
          qctoRegistrationType: qualification.qctoRegistrationType,
          exitLevelOutcomes: extract.exitLevelOutcomes,
          assessmentCriteria: extract.assessmentCriteria,
          timeAllocationMinutes,
          permittedMaterials: permittedMaterials ?? [],
        });
      } catch (err) {
        return {
          error: "The AI could not draft an instrument from this SAQA data.",
          detail: err instanceof Error ? err.message : String(err),
        };
      }

      const [created] = await db
        .insert(assessmentInstruments)
        .values({
          qualificationId,
          version,
          questions: generated.questions,
          timeAllocationMinutes,
          permittedMaterials: permittedMaterials ?? [],
          passMarkOrCompetencyRule: { rule: generated.passMarkOrCompetencyRule },
          source: "ai_generated",
          saqaExtractId: extractRow.id,
        })
        .returning();

      return { instrumentId: created.id, questionCount: generated.questions.length, coverageNotes: generated.coverageNotes };
    });

    return res.status(202).json({ jobId });
  }
);

const generateFromUploadFieldsSchema = z.object({
  qualificationId: z.string().uuid(),
  version: z.string().min(1),
  timeAllocationMinutes: z.coerce.number().int().positive(),
  // Sent as a single comma-separated form field, not a JSON array -
  // multipart/form-data doesn't carry structured fields the way a JSON body does.
  permittedMaterials: z.string().optional(),
});

// Fourth instrument-intake path (spec Section 5 / build brief Section 5.6):
// an Administrator uploads the actual QCTO document for a qualification - a
// Qualification Assessment Specifications (QAS) / External Assessment
// Specifications document, in practice a PDF or .docx (QCTO does not
// distribute these as SCORM packages - SCORM is an e-learning content
// packaging/tracking standard, not an assessment-paper format). Text is
// extracted from the file, the AI identifies the outcomes/criteria in it,
// and the same Instrument Generation Engine used for the SAQA path drafts
// the paper. Same "usable immediately" rule as the SAQA path - no review gate.
instrumentsRouter.post(
  "/generate-from-upload",
  requireAuth,
  requireRole("administrator"),
  upload.single("document"),
  async (req: AuthedRequest, res) => {
    const parsed = generateFromUploadFieldsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No document file was uploaded (expected form field 'document')." });
    }
    const { qualificationId, version, timeAllocationMinutes } = parsed.data;
    const permittedMaterials = parsed.data.permittedMaterials
      ? parsed.data.permittedMaterials
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean)
      : [];

    const [qualification] = await db
      .select()
      .from(qualifications)
      .where(eq(qualifications.id, qualificationId));
    if (!qualification) return res.status(404).json({ error: "Qualification not found." });

    let rawText: string;
    try {
      rawText = await extractTextFromDocument(
        req.file.buffer,
        req.file.mimetype,
        req.file.originalname
      );
    } catch (err) {
      if (err instanceof DocumentExtractionError) {
        return res.status(400).json({ error: "Could not read the uploaded document.", detail: err.message });
      }
      throw err;
    }

    const originalFilename = req.file.originalname;
    const jobId = await startJob("ai_instrument_generation", {
      path: "upload",
      qualificationId,
      originalFilename,
      version,
      timeAllocationMinutes,
    });

    runInBackground(jobId, async () => {
      let extracted;
      try {
        extracted = await extractOutcomesFromDocumentText(rawText, qualification.title);
      } catch (err) {
        if (err instanceof DocumentOutcomeExtractionError) {
          return {
            error: "Could not identify outcomes/assessment criteria in the uploaded document.",
            detail: err.message,
          };
        }
        throw err;
      }

      const [extractRow] = await db
        .insert(qctoDocumentExtracts)
        .values({
          qualificationId,
          originalFilename,
          exitLevelOutcomes: extracted.exitLevelOutcomes,
          assessmentCriteria: extracted.assessmentCriteria,
        })
        .returning();

      let generated;
      try {
        generated = await generateInstrumentFromOutcomes({
          qualificationTitle: qualification.title,
          qctoRegistrationType: qualification.qctoRegistrationType,
          exitLevelOutcomes: extracted.exitLevelOutcomes,
          assessmentCriteria: extracted.assessmentCriteria,
          timeAllocationMinutes,
          permittedMaterials,
          sourceDescription: `as extracted from the uploaded document "${originalFilename}"`,
        });
      } catch (err) {
        return {
          error: "The AI could not draft an instrument from this document.",
          detail: err instanceof Error ? err.message : String(err),
        };
      }

      const [created] = await db
        .insert(assessmentInstruments)
        .values({
          qualificationId,
          version,
          questions: generated.questions,
          timeAllocationMinutes,
          permittedMaterials,
          passMarkOrCompetencyRule: { rule: generated.passMarkOrCompetencyRule },
          source: "qcto_upload",
          qctoExtractId: extractRow.id,
        })
        .returning();

      return { instrumentId: created.id, questionCount: generated.questions.length, coverageNotes: generated.coverageNotes };
    });

    return res.status(202).json({ jobId });
  }
);
