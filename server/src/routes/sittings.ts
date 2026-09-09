import { Router } from "express";
import { z } from "zod";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  examSittings,
  sittingInvigilators,
  learnerSessions,
  users,
  userRoles,
  assessmentInstruments,
  cohorts,
  cohortMembers,
  qualifications,
  auditLog,
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
  // Block 2: schedule the sitting for a cohort - its whole membership is
  // allocated in the same action (allocateCohort, default true).
  cohortId: z.string().uuid().optional(),
  allocateCohort: z.boolean().default(true),
  name: z.string().trim().max(120).optional(),
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
      allocateCohort,
      name,
      startTime,
      endTime,
      proctoringProfile,
      assignedAssessorId,
      invigilatorIds,
      independentInvigilationRequired,
    } = parsed.data;

    let cohort: typeof cohorts.$inferSelect | undefined;
    if (cohortId) {
      [cohort] = await db.select().from(cohorts).where(eq(cohorts.id, cohortId));
      if (!cohort) return res.status(404).json({ error: "Cohort not found." });
      if (cohort.status === "closed") return res.status(409).json({ error: `${cohort.name} is closed. Reopen it to schedule a sitting for it.` });
    }

    if (new Date(endTime) <= new Date(startTime)) {
      return res.status(400).json({ error: "endTime must be after startTime." });
    }

    // The standard check is the gate (docs/restructure-2026-09-05.md §2): only a
    // paper that meets the standard, or carries a reasoned override, may be sat.
    const [instrument] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, instrumentId));
    if (!instrument) return res.status(404).json({ error: "Instrument not found." });
    if (instrument.qualificationId !== qualificationId) {
      return res.status(400).json({ error: "That paper belongs to a different qualification." });
    }
    if (instrument.intakeStatus !== "ready" && instrument.intakeStatus !== "override") {
      return res.status(400).json({
        error: instrument.intakeStatus === "checking" ? "This paper is still being checked against the assessment standard." : "This paper does not meet the assessment standard and cannot be scheduled.",
        detail: "Open the paper under Set up an Assessment to see the check, fix and re-upload, or record an override with a reason.",
      });
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
        cohortId: cohort?.id ?? null,
        name: name || null,
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

    let allocation: Awaited<ReturnType<typeof allocateCohortToSitting>> | null = null;
    if (cohort && allocateCohort) {
      allocation = await allocateCohortToSitting(created.id, cohort, req.auth!.userId);
    }
    await db.insert(auditLog).values({
      actorId: req.auth!.userId,
      action: "sitting_created",
      targetType: "sitting",
      targetId: created.id,
      reason: cohort ? `for cohort ${cohort.name}${allocation ? ` (${allocation.assigned} learners allocated)` : ""}` : "learners added individually",
    });

    return res.status(201).json({ ...created, allocation });
  }
);

// Every eligible member of the cohort gets a scheduled LearnerSession on the
// sitting. Suspended and archived students are left out and reported.
async function allocateCohortToSitting(sittingId: string, cohort: typeof cohorts.$inferSelect, actorId: string) {
  const members = await db
    .select({ id: users.id, status: users.status })
    .from(cohortMembers)
    .innerJoin(users, eq(users.id, cohortMembers.learnerId))
    .where(eq(cohortMembers.cohortId, cohort.id));
  const eligible = members.filter((m) => m.status === "active" || m.status === "invited").map((m) => m.id);
  const skipped = members.length - eligible.length;
  const existing = await db.select({ learnerId: learnerSessions.learnerId }).from(learnerSessions).where(eq(learnerSessions.sittingId, sittingId));
  const already = new Set(existing.map((e) => e.learnerId));
  const toInsert = eligible.filter((id) => !already.has(id));
  const alreadyFromCohort = eligible.length - toInsert.length;
  for (let i = 0; i < toInsert.length; i += 500) {
    await db.insert(learnerSessions).values(toInsert.slice(i, i + 500).map((learnerId) => ({ sittingId, learnerId, status: "scheduled" as const })));
  }
  await db.insert(auditLog).values({ actorId, action: "sitting_cohort_allocated", targetType: "sitting", targetId: sittingId, reason: `${cohort.name}: ${toInsert.length} allocated, ${alreadyFromCohort} already on the sitting, ${skipped} suspended/archived skipped` });
  return { cohortId: cohort.id, cohortName: cohort.name, members: members.length, assigned: toInsert.length, alreadyAssigned: alreadyFromCohort, skipped };
}

sittingsRouter.post("/:id/assign-cohort", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  const parsed = z.object({ cohortId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });
  const [sitting] = await db.select().from(examSittings).where(eq(examSittings.id, req.params.id));
  if (!sitting) return res.status(404).json({ error: "Sitting not found." });
  const [cohort] = await db.select().from(cohorts).where(eq(cohorts.id, parsed.data.cohortId));
  if (!cohort) return res.status(404).json({ error: "Cohort not found." });
  const result = await allocateCohortToSitting(sitting.id, cohort, req.auth!.userId);
  if (!sitting.cohortId) await db.update(examSittings).set({ cohortId: cohort.id }).where(eq(examSittings.id, sitting.id));
  return res.status(201).json(result);
});

// The roster: who is on this sitting and where each of them is. Used by the
// Administrator now and by the Invigilator console (Block 5).
sittingsRouter.get("/:id/learners", requireAuth, requireRole("administrator", "invigilator", "assessor"), async (req: AuthedRequest, res) => {
  const [sitting] = await db.select().from(examSittings).where(eq(examSittings.id, req.params.id));
  if (!sitting) return res.status(404).json({ error: "Sitting not found." });
  const roles = req.auth!.roles;
  if (!roles.includes("administrator")) {
    const isAssessor = sitting.assignedAssessorId === req.auth!.userId;
    const [inv] = await db.select().from(sittingInvigilators).where(and(eq(sittingInvigilators.sittingId, sitting.id), eq(sittingInvigilators.invigilatorId, req.auth!.userId)));
    if (!isAssessor && !inv) return res.status(403).json({ error: "You are not assigned to this sitting." });
  }
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(10, Number(req.query.pageSize) || 100));
  const where = and(
    eq(learnerSessions.sittingId, sitting.id),
    q ? sql`(${users.name} ILIKE ${"%" + q + "%"} OR ${users.email} ILIKE ${"%" + q + "%"} OR ${users.studentNumber} ILIKE ${"%" + q + "%"})` : undefined
  );
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(learnerSessions).innerJoin(users, eq(users.id, learnerSessions.learnerId)).where(where);
  const rows = await db
    .select({
      sessionId: learnerSessions.id,
      learnerId: users.id,
      name: users.name,
      email: users.email,
      studentNumber: users.studentNumber,
      idNumberLast4: users.idNumberLast4,
      accountStatus: users.status,
      sessionStatus: learnerSessions.status,
      checkInTime: learnerSessions.checkInTime,
      submissionTime: learnerSessions.submissionTime,
    })
    .from(learnerSessions)
    .innerJoin(users, eq(users.id, learnerSessions.learnerId))
    .where(where)
    .orderBy(asc(users.name))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const byStatus = await db
    .select({ status: learnerSessions.status, n: sql<number>`count(*)::int` })
    .from(learnerSessions)
    .where(eq(learnerSessions.sittingId, sitting.id))
    .groupBy(learnerSessions.status);
  return res.json({
    rows: rows.map((r) => ({
      ...r,
      idNumberMasked: r.idNumberLast4 ? `••••••••• ${r.idNumberLast4}` : null,
      idNumberLast4: undefined,
      checkInTime: r.checkInTime?.toISOString() ?? null,
      submissionTime: r.submissionTime?.toISOString() ?? null,
    })),
    total: count,
    page,
    pageSize,
    byStatus: Object.fromEntries(byStatus.map((b) => [b.status, b.n])),
  });
});

sittingsRouter.delete("/:id/learners", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  const parsed = z.object({ learnerIds: z.array(z.string().uuid()).min(1).max(5000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });
  const [sitting] = await db.select().from(examSittings).where(eq(examSittings.id, req.params.id));
  if (!sitting) return res.status(404).json({ error: "Sitting not found." });
  // Only learners who have not started can be taken off a sitting.
  const del = await db
    .delete(learnerSessions)
    .where(and(eq(learnerSessions.sittingId, sitting.id), inArray(learnerSessions.learnerId, parsed.data.learnerIds), eq(learnerSessions.status, "scheduled")))
    .returning({ learnerId: learnerSessions.learnerId });
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "sitting_learners_removed", targetType: "sitting", targetId: sitting.id, reason: `${del.length} removed` });
  return res.json({ removed: del.length, notRemoved: parsed.data.learnerIds.length - del.length });
});

sittingsRouter.get(
  "/",
  requireAuth,
  requireRole("administrator", "assessor"),
  async (_req, res) => {
    const rows = await db
      .select({
        sitting: examSittings,
        qualificationTitle: qualifications.title,
        cohortName: cohorts.name,
        assessorName: users.name,
        learners: sql<number>`(SELECT count(*)::int FROM ${learnerSessions} ls WHERE ls.sitting_id = ${examSittings.id})`,
      })
      .from(examSittings)
      .innerJoin(qualifications, eq(qualifications.id, examSittings.qualificationId))
      .innerJoin(users, eq(users.id, examSittings.assignedAssessorId))
      .leftJoin(cohorts, eq(cohorts.id, examSittings.cohortId))
      .orderBy(desc(examSittings.startTime))
      .limit(2000);
    return res.json(rows.map((r) => ({ ...r.sitting, qualificationTitle: r.qualificationTitle, cohortName: r.cohortName, assessorName: r.assessorName, learners: r.learners })));
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
