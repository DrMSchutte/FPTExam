import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { assessmentInstruments, qualifications, saqaQualificationExtracts } from "../db/schema.js";
import { requireAuth, requireRole, type AuthedRequest } from "../auth/middleware.js";
import { fetchSaqaExtract, SaqaExtractError } from "../integrations/saqa/fetchQualification.js";
import { generateInstrumentFromSaqa } from "../ai/instrumentGeneration.js";

export const instrumentsRouter = Router();

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
  requireRole("administrator", "assessor", "moderator", "head_qa"),
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

    let extract;
    try {
      extract = await fetchSaqaExtract(qualification.saqaQualificationId);
    } catch (err) {
      if (err instanceof SaqaExtractError) {
        return res.status(502).json({ error: "Could not extract data from SAQA.", detail: err.message });
      }
      throw err;
    }

    const [extractRow] = await db
      .insert(saqaQualificationExtracts)
      .values({
        qualificationId,
        saqaQualificationId: qualification.saqaQualificationId,
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
      return res.status(502).json({
        error: "The AI could not draft an instrument from this SAQA data.",
        detail: err instanceof Error ? err.message : String(err),
      });
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

    return res.status(201).json({ ...created, coverageNotes: generated.coverageNotes });
  }
);
