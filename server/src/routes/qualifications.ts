import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { qualifications } from "../db/schema.js";
import { requireAuth, requireRole, type AuthedRequest } from "../auth/middleware.js";

export const qualificationsRouter = Router();

const createSchema = z.object({
  title: z.string().min(1),
  qctoRegistrationType: z.enum(["fisa", "eisa"]),
  aqpReference: z.string().optional(),
});

// Administrator-only, per Section 3: qualification/instrument setup is a
// configuration action, not an academic one.
qualificationsRouter.post(
  "/",
  requireAuth,
  requireRole("administrator"),
  async (req: AuthedRequest, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });
    }
    const [created] = await db
      .insert(qualifications)
      .values({
        title: parsed.data.title,
        qctoRegistrationType: parsed.data.qctoRegistrationType,
        aqpReference: parsed.data.aqpReference ?? null,
      })
      .returning();
    return res.status(201).json(created);
  }
);

// Readable by every role that needs to pick a qualification when setting up
// or reviewing an exam - Administrator (sitting setup), Assessor/Moderator/
// Head QA (context on what they're reviewing).
qualificationsRouter.get(
  "/",
  requireAuth,
  requireRole("administrator", "assessor", "moderator", "head_qa"),
  async (_req, res) => {
    const rows = await db.select().from(qualifications);
    return res.json(rows);
  }
);
