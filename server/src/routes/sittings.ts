import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  examSittings,
  sittingInvigilators,
  learnerSessions,
  users,
  userRoles,
} from "../db/schema.js";
import { requireAuth, requireRole, type AuthedRequest } from "../auth/middleware.js";

export const sittingsRouter = Router();

const proctoringProfileSchema = z.object({
  captureIntervalSeconds: z.number().int().positive().default(45),
  fullRecordingEnabled: z.boolean().default(false),
  lockdownLevel: z.enum(["none", "standard", "strict"]).default("standard"),
  breaksAllowed: z.boolean().default(false),
});

const createSchema = z.object({
  qualificationId: z.string().uuid(),
  instrumentId: z.string().uuid(),
  // One sitting = one cohort for now, so there's no separate cohorts table
  // to manage yet - the cohort_id column exists for when multiple sittings
  // need to be grouped and released together (Section 5.1 of the build
  // brief). Passing a cohortId reuses an existing group; omitting one mints
  // a fresh cohort for just this sitting.
  cohortId: z.string().uuid().optional(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  proctoringProfile: proctoringProfileSchema.optional(),
  assignedAssessorId: z.string().uuid(),
  invigilatorIds: z.array(z.string().uuid()).default([]),
  independentInvigilationRequired: z.boolean().default(false),
});

async function rolesFor(userIds: string[]) {
  if (userIds.length === 0) return new Map<string, string[]>();
  const rows = await db.select().from(userRoles).where(inArray(userRoles.userId, userIds));
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const list = map.get(r.userId) ?? [];
    list.push(r.role);
    map.set(r.userId, list);
  }
  return map;
}

sittingsRouter.post(
  "/",
  requireAuth,
  requireRole("administrator"),
  async (req: AuthedRequest, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });
    }
    const {
      qualificationId,
      instrumentId,
      cohortId,
      startTime,
      endTime,
      proctoringProfile,
      assignedAssessorId,
      invigilatorIds,
      independentInvigilationRequired,
    } = parsed.data;

    if (new Date(endTime) <= new Date(startTime)) {
      return res.status(400).json({ error: "endTime must be after startTime." });
    }

    // Role-independence check (Section 2): the Assessor of record cannot
    // also be one of this sitting's Invigilators, even if their account
    // holds both roles in the abstract (Phase 1 already blocks the most
    // common case - one account with both roles - but a Head QA-style
    // dual-role account or a data-entry mistake could still slip an
    // assessor in as an invigilator on one specific sitting without this).
    if (invigilatorIds.includes(assignedAssessorId)) {
      return res.status(400).json({
        error: "The assigned Assessor cannot also be listed as an Invigilator on this sitting.",
      });
    }

    const relevantIds = [assignedAssessorId, ...invigilatorIds];
    const roleMap = await rolesFor(relevantIds);
    const usersById = new Map(
      (await db.select().from(users).where(inArray(users.id, relevantIds))).map((u) => [u.id, u])
    );

    if (!(roleMap.get(assignedAssessorId) ?? []).includes("assessor")) {
      return res.status(400).json({ error: "assignedAssessorId does not belong to an Assessor account." });
    }
    for (const invId of invigilatorIds) {
      if (!(roleMap.get(invId) ?? []).includes("invigilator")) {
        return res.status(400).json({ error: `Invigilator ${invId} does not hold the Invigilator role.` });
      }
      if (independentInvigilationRequired && usersById.get(invId)?.employmentRelationship !== "external") {
        return res.status(400).json({
          error: `This sitting requires independent invigilation, but invigilator ${invId} is not marked external.`,
        });
      }
    }

    const [created] = await db
      .insert(examSittings)
      .values({
        qualificationId,
        instrumentId,
        cohortId: cohortId ?? randomUUID(),
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        proctoringProfile: proctoringProfileSchema.parse(proctoringProfile ?? {}),
        assignedAssessorId,
        independentInvigilationRequired,
        createdBy: req.auth!.userId,
      })
      .returning();

    if (invigilatorIds.length > 0) {
      await db
        .insert(sittingInvigilators)
        .values(invigilatorIds.map((invigilatorId) => ({ sittingId: created.id, invigilatorId })));
    }

    return res.status(201).json(created);
  }
);

sittingsRouter.get(
  "/",
  requireAuth,
  requireRole("administrator", "assessor"),
  async (_req, res) => {
    const rows = await db.select().from(examSittings);
    return res.json(rows);
  }
);

sittingsRouter.get("/:id", requireAuth, async (req: AuthedRequest, res) => {
  const [sitting] = await db.select().from(examSittings).where(eq(examSittings.id, req.params.id));
  if (!sitting) return res.status(404).json({ error: "Sitting not found." });
  const invigilators = await db
    .select()
    .from(sittingInvigilators)
    .where(eq(sittingInvigilators.sittingId, sitting.id));
  return res.json({ ...sitting, invigilatorIds: invigilators.map((i) => i.invigilatorId) });
});

const assignLearnersSchema = z.object({
  learnerIds: z.array(z.string().uuid()).min(1),
});

// Creates a scheduled LearnerSession per learner - the row that everything
// else (check-in, answers, capture events, AI reports, sign-off) hangs off.
sittingsRouter.post(
  "/:id/assign-learners",
  requireAuth,
  requireRole("administrator"),
  async (req: AuthedRequest, res) => {
    const parsed = assignLearnersSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });
    }
    const [sitting] = await db.select().from(examSittings).where(eq(examSittings.id, req.params.id));
    if (!sitting) return res.status(404).json({ error: "Sitting not found." });

    const roleMap = await rolesFor(parsed.data.learnerIds);
    for (const learnerId of parsed.data.learnerIds) {
      if (!(roleMap.get(learnerId) ?? []).includes("learner")) {
        return res.status(400).json({ error: `${learnerId} does not hold the Learner role.` });
      }
    }

    const existing = await db
      .select({ learnerId: learnerSessions.learnerId })
      .from(learnerSessions)
      .where(eq(learnerSessions.sittingId, sitting.id));
    const already = new Set(existing.map((e) => e.learnerId));
    const toInsert = parsed.data.learnerIds.filter((id) => !already.has(id));

    if (toInsert.length > 0) {
      await db.insert(learnerSessions).values(
        toInsert.map((learnerId) => ({
          sittingId: sitting.id,
          learnerId,
          status: "scheduled" as const,
        }))
      );
    }

    return res.status(201).json({ assigned: toInsert.length, alreadyAssigned: already.size });
  }
);
