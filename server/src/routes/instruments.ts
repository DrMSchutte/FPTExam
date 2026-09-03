import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { assessmentInstruments } from "../db/schema.js";
import { requireAuth, requireRole, type AuthedRequest } from "../auth/middleware.js";

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
