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
  sittingSeries,
  assessorDecisions,
  evidenceBlobs,
  incidentLog,
  recordingSegments,
} from "../db/schema.js";
import { requireAuth, requireRole, type AuthedRequest } from "../auth/middleware.js";
import { issueCodes, codesForPrint, staffResume, staffNote, staffRequestCapture, staffIncident, segmentsFor } from "./sit.js";
import { proctoringOf, submitSession, deadlineFor, recordIncident, captureRequestPending, fullRecordingOn, SEGMENT_SECONDS } from "../proctoring/session.js";
import { MANUAL_INCIDENTS, evidenceTimeline, integrityReportFor } from "../proctoring/integrity.js";
import { checkStaffing, cohortLearners, learnerClashes, assessorLoads, assessorScopeMap, invigilatorClashes, invigilatorsNeeded, DEFAULT_MARKING_CAP } from "../scheduling/staffing.js";

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
  venue: z.string().trim().max(120).optional(),
  capacity: z.number().int().positive().max(5000).optional(),
  // Non-blocking staffing warnings (scope not recorded, cap exceeded) are shown
  // to the Administrator first; the request is repeated with this set.
  acceptWarnings: z.boolean().default(false),
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
      venue,
      capacity,
      acceptWarnings,
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
    if (instrument.retiredAt) {
      return res.status(400).json({ error: "This paper has been retired and cannot be scheduled.", detail: instrument.retireReason ?? undefined });
    }
    if (instrument.supersededById) {
      return res.status(400).json({ error: "A newer version of this paper has been pulled in from Curricula Builder.", detail: "Schedule the current version instead; this one stays only for sittings already written on it." });
    }
    if (instrument.intakeStatus !== "ready" && instrument.intakeStatus !== "override") {
      return res.status(400).json({
        error: instrument.intakeStatus === "checking" ? "This paper is still being checked against the assessment standard." : "This paper does not meet the assessment standard and cannot be scheduled.",
        detail: "Open the paper under Set up an Assessment to see the check, fix and re-upload, or record an override with a reason.",
      });
    }

    // Staffing rules (scheduling/staffing.ts): assessor/invigilator roles and
    // independence, the 1:30 ratio against the cohort, the assessor's scope and
    // marking cap, and invigilator clashes. Blocking problems refuse; warnings
    // refuse unless the Administrator has accepted them (acceptWarnings).
    let expectedLearners = 0;
    if (cohort && allocateCohort) expectedLearners = (await cohortLearners([cohort.id])).ids.length;
    const problems = await checkStaffing({
      qualificationId,
      assessorId: assignedAssessorId,
      invigilatorIds,
      independent: independentInvigilationRequired,
      learners: expectedLearners,
      windows: [{ start: new Date(startTime), end: new Date(endTime) }],
      assessorAddedScripts: expectedLearners,
    });
    const blocking = problems.filter((p) => p.blocking);
    if (blocking.length) return res.status(400).json({ error: blocking[0].message, problems });
    const needAck = problems.filter((p) => p.code !== "scope_unknown");
    if (needAck.length && !acceptWarnings) return res.status(409).json({ error: needAck[0].message, problems, needsAcceptance: true });

    const [created] = await db
      .insert(examSittings)
      .values({
        qualificationId,
        instrumentId,
        cohortId: cohort?.id ?? null,
        name: name || null,
        venue: venue || null,
        capacity: capacity ?? null,
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

    return res.status(201).json({ ...created, allocation, warnings: problems.map((p) => p.message) });
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
      codeIssued: sql<boolean>`${learnerSessions.codeHash} IS NOT NULL`,
      entries: learnerSessions.entries,
      reentryAllowed: learnerSessions.reentryAllowed,
      precheck: learnerSessions.precheck,
      proctoring: learnerSessions.proctoring,
      startedAt: learnerSessions.startedAt,
      extraMinutes: learnerSessions.extraMinutes,
      sealHash: learnerSessions.sealHash,
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
    rows: rows.map((r) => {
      const p = (r.precheck ?? {}) as { consentAt?: string; identityPhotoId?: string; camera?: boolean; microphone?: boolean };
      const pr = proctoringOf(r.proctoring);
      return {
        ...r,
        precheck: undefined,
        proctoring: undefined,
        startedAt: r.startedAt?.toISOString() ?? null,
        sealHash: r.sealHash ? r.sealHash.slice(0, 16) : null,
        locked: Boolean(pr.lockedAt),
        requiresInvigilator: Boolean(pr.requiresInvigilator),
        lockReason: pr.lockReason ?? null,
        locks: pr.locks,
        focusLosses: pr.focusLosses,
        pasteAttempts: pr.pasteAttempts,
        photos: pr.photos,
        screens: pr.screens,
        screenShare: pr.screenShare ?? null,
        idNumberMasked: r.idNumberLast4 ? `••••••••• ${r.idNumberLast4}` : null,
        idNumberLast4: undefined,
        checkInTime: r.checkInTime?.toISOString() ?? null,
        submissionTime: r.submissionTime?.toISOString() ?? null,
        consent: Boolean(p.consentAt),
        identityPhotoId: p.identityPhotoId ?? null,
        camera: p.camera ?? null,
        microphone: p.microphone ?? null,
      };
    }),
    codesIssued: rows.length ? (await db.select({ n: sql<number>`count(*)::int` }).from(learnerSessions).where(and(eq(learnerSessions.sittingId, sitting.id), sql`${learnerSessions.codeHash} IS NOT NULL`)))[0].n : 0,
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
    return res.json(rows.map((r) => ({ ...r.sitting, qualificationTitle: r.qualificationTitle, cohortName: r.cohortName, assessorName: r.assessorName, learners: r.learners, fullRecording: fullRecordingOn(r.sitting.proctoringProfile) })));
  }
);

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

sittingsRouter.get("/:id", requireAuth, async (req: AuthedRequest, res, next) => {
  if (!isUuid(req.params.id)) return next(); // /staffing, /calendar, /workload below
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

// ---- Block 3: staffing lookup, series, calendar, marking workload ------------------------

// Who is available to staff a sitting in a window: assessors with their load,
// cap and scope for the qualification; invigilators with any clash.
sittingsRouter.get("/staffing", requireAuth, requireRole("administrator"), async (req, res) => {
  const q = z.object({ start: z.string().datetime().optional(), end: z.string().datetime().optional(), qualificationId: z.string().uuid().optional() }).safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "Invalid query." });
  const staff = await db
    .select({ id: users.id, name: users.name, status: users.status, employment: users.employmentRelationship, role: userRoles.role })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .where(and(inArray(userRoles.role, ["assessor", "invigilator"]), inArray(users.status, ["active", "invited"])))
    .orderBy(asc(users.name));
  const assessorIds = staff.filter((s) => s.role === "assessor").map((s) => s.id);
  const invigilatorIds = staff.filter((s) => s.role === "invigilator").map((s) => s.id);
  const [loads, scopes] = await Promise.all([assessorLoads(assessorIds), assessorScopeMap(assessorIds)]);
  const win = q.data.start && q.data.end ? { start: new Date(q.data.start), end: new Date(q.data.end) } : null;
  const clashes = win ? await invigilatorClashes(invigilatorIds, win) : new Map();
  return res.json({
    ratio: 30,
    assessors: staff
      .filter((s) => s.role === "assessor")
      .map((s) => {
        const l = loads.get(s.id) ?? { inFlight: 0, waiting: 0, cap: DEFAULT_MARKING_CAP };
        const scope = scopes.get(s.id);
        return { id: s.id, name: s.name, inFlight: l.inFlight, waiting: l.waiting, cap: l.cap, scope: scope ? [...scope] : null, inScope: q.data.qualificationId ? (scope ? scope.has(q.data.qualificationId) : null) : null };
      }),
    invigilators: staff
      .filter((s) => s.role === "invigilator")
      .map((s) => ({ id: s.id, name: s.name, employment: s.employment, busy: (clashes.get(s.id) ?? []).map((c: { name: string | null; startTime: Date }) => ({ name: c.name, startTime: c.startTime.toISOString() })) })),
  });
});

const slotSchema = z.object({
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  venue: z.string().trim().max(120).optional(),
  capacity: z.number().int().positive().max(5000).optional(),
  invigilatorIds: z.array(z.string().uuid()).default([]),
  assessorId: z.string().uuid().optional(), // overrides the series assessor for this slot
});

const seriesSchema = z.object({
  name: z.string().trim().min(2).max(120),
  instrumentId: z.string().uuid(),
  cohortIds: z.array(z.string().uuid()).min(1).max(20),
  assessorId: z.string().uuid(),
  independentInvigilationRequired: z.boolean().default(false),
  proctoringProfile: proctoringProfileSchema.optional(),
  slots: z.array(slotSchema).min(1).max(60),
  acceptWarnings: z.boolean().default(false),
  // Preview only: run every check and the split, create nothing.
  dryRun: z.boolean().default(false),
});

// One paper, one or more cohorts, many sittings: the cohort's students are
// split across the slots by capacity (evenly when no capacities are given),
// every slot is checked against the staffing rules, and everything is created
// together - or nothing is.
sittingsRouter.post("/series", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  const parsed = seriesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });
  const p = parsed.data;

  const [instrument] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, p.instrumentId));
  if (!instrument) return res.status(404).json({ error: "Paper not found." });
  if (instrument.intakeStatus !== "ready" && instrument.intakeStatus !== "override") {
    return res.status(400).json({ error: "This paper does not meet the assessment standard and cannot be scheduled." });
  }
  const cohortRows = await db.select().from(cohorts).where(inArray(cohorts.id, p.cohortIds));
  if (cohortRows.length !== p.cohortIds.length) return res.status(404).json({ error: "One of the cohorts was not found." });
  const closed = cohortRows.find((c) => c.status === "closed");
  if (closed) return res.status(409).json({ error: `${closed.name} is closed. Reopen it to schedule for it.` });

  for (const s of p.slots) if (new Date(s.endTime) <= new Date(s.startTime)) return res.status(400).json({ error: "Every slot's end must be after its start." });
  const slots = [...p.slots].sort((a, b) => a.startTime.localeCompare(b.startTime));

  // Learners and clashes.
  const { ids: learners, skippedInactive } = await cohortLearners(p.cohortIds);
  const seriesWindow = { start: new Date(slots[0].startTime), end: new Date(slots.reduce((m, s) => (s.endTime > m ? s.endTime : m), slots[0].endTime)) };
  const clashing = await learnerClashes(learners, seriesWindow);
  const toPlace = learners.filter((id) => !clashing.has(id));

  // Split by capacity; even split when no capacities were given.
  const total = toPlace.length;
  const anyCap = slots.some((s) => s.capacity);
  const sizes = slots.map((s, i) => (anyCap ? s.capacity ?? 0 : Math.ceil((total - Math.floor(total / slots.length) * i) / (slots.length - i))));
  if (!anyCap) {
    // exact even split
    const base = Math.floor(total / slots.length);
    let rem = total - base * slots.length;
    for (let i = 0; i < slots.length; i++) sizes[i] = base + (rem-- > 0 ? 1 : 0);
  }
  const groups: string[][] = [];
  let cursor = 0;
  for (const size of sizes) {
    groups.push(toPlace.slice(cursor, cursor + size));
    cursor += size;
  }
  const unplaced = toPlace.slice(cursor);

  // Staffing per slot; invigilator double-booking within the series itself.
  const problems: { slot: number; code: string; message: string; blocking: boolean }[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < slots.length; i++) {
    for (const j of slots.slice(0, i).keys()) {
      const a = slots[j], b = slots[i];
      if (new Date(a.startTime) < new Date(b.endTime) && new Date(b.startTime) < new Date(a.endTime)) {
        for (const inv of b.invigilatorIds) if (a.invigilatorIds.includes(inv)) problems.push({ slot: i + 1, code: "invigilator_clash", blocking: true, message: `The same invigilator is on sittings ${j + 1} and ${i + 1}, which overlap.` });
      }
    }
    seen.set(String(i), i);
  }
  const scriptsByAssessor = new Map<string, number>();
  for (let i = 0; i < slots.length; i++) {
    const a = slots[i].assessorId ?? p.assessorId;
    scriptsByAssessor.set(a, (scriptsByAssessor.get(a) ?? 0) + groups[i].length);
  }
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const assessorId = slot.assessorId ?? p.assessorId;
    const ps = await checkStaffing({
      qualificationId: instrument.qualificationId,
      assessorId,
      invigilatorIds: slot.invigilatorIds,
      independent: p.independentInvigilationRequired,
      learners: groups[i].length,
      windows: [{ start: new Date(slot.startTime), end: new Date(slot.endTime) }],
      assessorAddedScripts: scriptsByAssessor.get(assessorId) ?? 0,
    });
    for (const x of ps) if (!(x.code === "cap" && problems.some((y) => y.code === "cap" && y.message === x.message))) problems.push({ slot: i + 1, ...x });
  }
  if (learners.length > 0 && total === 0) problems.push({ slot: 0, code: "nobody_free", blocking: true, message: `None of the ${learners.length} students can be placed: every one is already on a sitting that overlaps this period. Choose other dates, or check the existing sittings on the calendar.` });
  else if (learners.length === 0) problems.push({ slot: 0, code: "no_students", blocking: true, message: "The chosen cohort has no active students to place." });
  if (unplaced.length) problems.push({ slot: 0, code: "capacity", blocking: false, message: `${unplaced.length} student${unplaced.length === 1 ? "" : "s"} do not fit the capacities given (${total} to place, ${sizes.reduce((a, b) => a + b, 0)} seats). Add a sitting or raise a capacity; otherwise they are left off.` });
  if (clashing.size) problems.push({ slot: 0, code: "learner_clash", blocking: false, message: `${clashing.size} student${clashing.size === 1 ? " is" : "s are"} already on another sitting in this period and ${clashing.size === 1 ? "is" : "are"} left off.` });
  if (skippedInactive) problems.push({ slot: 0, code: "inactive", blocking: false, message: `${skippedInactive} suspended or archived student${skippedInactive === 1 ? "" : "s"} left off.` });

  const plan = slots.map((s, i) => ({ slot: i + 1, startTime: s.startTime, endTime: s.endTime, venue: s.venue ?? null, capacity: s.capacity ?? null, learners: groups[i].length, invigilators: s.invigilatorIds.length, invigilatorsNeeded: invigilatorsNeeded(groups[i].length), assessorId: s.assessorId ?? p.assessorId }));
  const blocking = problems.filter((x) => x.blocking);
  if (blocking.length) return res.status(400).json({ error: blocking[0].message, problems, plan, totalLearners: learners.length });
  if (p.dryRun) return res.json({ dryRun: true, plan, problems, totalLearners: learners.length, placed: total - unplaced.length });
  const needAck = problems.filter((x) => x.code !== "scope_unknown");
  if (needAck.length && !p.acceptWarnings) return res.status(409).json({ error: needAck[0].message, problems, plan, needsAcceptance: true, totalLearners: learners.length });

  const created = await db.transaction(async (tx) => {
    const [series] = await tx
      .insert(sittingSeries)
      .values({ name: p.name, qualificationId: instrument.qualificationId, instrumentId: instrument.id, cohortId: p.cohortIds.length === 1 ? p.cohortIds[0] : null, createdBy: req.auth!.userId })
      .returning();
    const out: { id: string; name: string; startTime: string; venue: string | null; learners: number }[] = [];
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const name = `${p.name} · ${i + 1} of ${slots.length}${slot.venue ? ` · ${slot.venue}` : ""}`;
      const [sitting] = await tx
        .insert(examSittings)
        .values({
          qualificationId: instrument.qualificationId,
          instrumentId: instrument.id,
          cohortId: p.cohortIds.length === 1 ? p.cohortIds[0] : null,
          seriesId: series.id,
          name,
          venue: slot.venue ?? null,
          capacity: slot.capacity ?? null,
          startTime: new Date(slot.startTime),
          endTime: new Date(slot.endTime),
          proctoringProfile: proctoringProfileSchema.parse(p.proctoringProfile ?? {}),
          assignedAssessorId: slot.assessorId ?? p.assessorId,
          independentInvigilationRequired: p.independentInvigilationRequired,
          createdBy: req.auth!.userId,
        })
        .returning();
      if (slot.invigilatorIds.length) await tx.insert(sittingInvigilators).values(slot.invigilatorIds.map((invigilatorId) => ({ sittingId: sitting.id, invigilatorId })));
      for (let k = 0; k < groups[i].length; k += 500) {
        await tx.insert(learnerSessions).values(groups[i].slice(k, k + 500).map((learnerId) => ({ sittingId: sitting.id, learnerId, status: "scheduled" as const })));
      }
      out.push({ id: sitting.id, name, startTime: sitting.startTime.toISOString(), venue: sitting.venue, learners: groups[i].length });
    }
    await tx.insert(auditLog).values({
      actorId: req.auth!.userId,
      action: "sitting_series_created",
      targetType: "sitting_series",
      targetId: series.id,
      reason: `${p.name}: ${slots.length} sittings, ${total - unplaced.length} of ${learners.length} students placed from ${cohortRows.map((c) => c.name).join(", ")}`,
    });
    return { seriesId: series.id, sittings: out };
  });

  return res.status(201).json({ ...created, plan, problems, totalLearners: learners.length, placed: total - unplaced.length, unplaced: unplaced.length });
});

// Sittings in a date range, for the calendar.
sittingsRouter.get("/calendar", requireAuth, requireRole("administrator", "assessor", "invigilator"), async (req: AuthedRequest, res) => {
  const q = z.object({ from: z.string().datetime(), to: z.string().datetime() }).safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "Invalid query: from and to (ISO) are required." });
  const rows = await db
    .select({
      id: examSittings.id,
      name: examSittings.name,
      venue: examSittings.venue,
      capacity: examSittings.capacity,
      startTime: examSittings.startTime,
      endTime: examSittings.endTime,
      seriesId: examSittings.seriesId,
      qualificationTitle: qualifications.title,
      cohortName: cohorts.name,
      assessorName: users.name,
      learners: sql<number>`(SELECT count(*)::int FROM ${learnerSessions} ls WHERE ls.sitting_id = ${examSittings.id})`,
      invigilators: sql<number>`(SELECT count(*)::int FROM ${sittingInvigilators} si WHERE si.sitting_id = ${examSittings.id})`,
    })
    .from(examSittings)
    .innerJoin(qualifications, eq(qualifications.id, examSittings.qualificationId))
    .innerJoin(users, eq(users.id, examSittings.assignedAssessorId))
    .leftJoin(cohorts, eq(cohorts.id, examSittings.cohortId))
    .where(and(sql`${examSittings.startTime} < ${new Date(q.data.to)}`, sql`${examSittings.endTime} > ${new Date(q.data.from)}`))
    .orderBy(asc(examSittings.startTime));
  return res.json(rows.map((r) => ({ ...r, startTime: r.startTime.toISOString(), endTime: r.endTime.toISOString(), invigilatorsNeeded: invigilatorsNeeded(r.learners) })));
});

// Marking workload board: what every assessor has waiting, how fast they turn
// scripts round, and what is overdue (waiting longer than OVERDUE_DAYS).
const OVERDUE_DAYS = 5;
sittingsRouter.get("/workload", requireAuth, requireRole("administrator"), async (_req, res) => {
  const assessors = await db
    .select({ id: users.id, name: users.name, status: users.status, cap: users.markingCap })
    .from(users)
    .innerJoin(userRoles, and(eq(userRoles.userId, users.id), eq(userRoles.role, "assessor")))
    .where(inArray(users.status, ["active", "invited", "suspended"]))
    .orderBy(asc(users.name));
  const ids = assessors.map((a) => a.id);
  const loads = await assessorLoads(ids);
  const scopes = await assessorScopeMap(ids);
  const stats = ids.length
    ? await db
        .select({
          assessorId: examSittings.assignedAssessorId,
          overdue: sql<number>`count(*) FILTER (WHERE ${learnerSessions.status} IN ('submitted','sealed') AND ${assessorDecisions.signedOffAt} IS NULL AND ${learnerSessions.submissionTime} < now() - interval '${sql.raw(String(OVERDUE_DAYS))} days')::int`,
          signedOff30d: sql<number>`count(*) FILTER (WHERE ${assessorDecisions.signedOffAt} > now() - interval '30 days')::int`,
          avgTurnaroundHours: sql<number | null>`round(avg(EXTRACT(EPOCH FROM (${assessorDecisions.signedOffAt} - ${learnerSessions.submissionTime})) / 3600) FILTER (WHERE ${assessorDecisions.signedOffAt} IS NOT NULL AND ${learnerSessions.submissionTime} IS NOT NULL)::numeric, 1)::float`,
          upcoming: sql<number>`count(DISTINCT ${examSittings.id}) FILTER (WHERE ${examSittings.startTime} > now())::int`,
        })
        .from(examSittings)
        .leftJoin(learnerSessions, eq(learnerSessions.sittingId, examSittings.id))
        .leftJoin(assessorDecisions, eq(assessorDecisions.sessionId, learnerSessions.id))
        .where(inArray(examSittings.assignedAssessorId, ids))
        .groupBy(examSittings.assignedAssessorId)
    : [];
  const byId = new Map(stats.map((s) => [s.assessorId, s]));
  const qualTitles = new Map((await db.select({ id: qualifications.id, title: qualifications.title }).from(qualifications)).map((q) => [q.id, q.title]));
  return res.json({
    overdueAfterDays: OVERDUE_DAYS,
    assessors: assessors.map((a) => {
      const l = loads.get(a.id) ?? { inFlight: 0, waiting: 0, cap: DEFAULT_MARKING_CAP };
      const s = byId.get(a.id);
      return {
        id: a.id,
        name: a.name,
        status: a.status,
        cap: l.cap,
        inFlight: l.inFlight,
        waiting: l.waiting,
        overdue: s?.overdue ?? 0,
        signedOff30d: s?.signedOff30d ?? 0,
        avgTurnaroundHours: s?.avgTurnaroundHours ?? null,
        upcomingSittings: s?.upcoming ?? 0,
        scope: [...(scopes.get(a.id) ?? [])].map((q) => qualTitles.get(q) ?? q),
      };
    }),
  });
});


// ---- Block 5a: sitting codes and re-entry (staff) --------------------------------------------

async function staffOnSitting(req: AuthedRequest, sittingId: string) {
  const [sitting] = await db.select().from(examSittings).where(eq(examSittings.id, sittingId));
  if (!sitting) return null;
  if (req.auth!.roles.includes("administrator")) return sitting;
  const [inv] = await db.select().from(sittingInvigilators).where(and(eq(sittingInvigilators.sittingId, sitting.id), eq(sittingInvigilators.invigilatorId, req.auth!.userId)));
  return inv ? sitting : null;
}

// Issue codes for everyone on the roster without one (or re-issue for the
// learners named). Codes are shown once here and on the print-out.
sittingsRouter.post("/:id/codes", requireAuth, requireRole("administrator", "invigilator"), async (req: AuthedRequest, res) => {
  const parsed = z.object({ learnerIds: z.array(z.string().uuid()).max(5000).optional(), reissue: z.boolean().default(false) }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body." });
  const sitting = await staffOnSitting(req, req.params.id);
  if (!sitting) return res.status(404).json({ error: "Sitting not found." });
  const r = await issueCodes(sitting.id, req.auth!.userId, parsed.data.learnerIds, parsed.data.reissue);
  return res.json(r);
});

// The print-out: every learner on the roster with their code. Audited.
sittingsRouter.get("/:id/codes", requireAuth, requireRole("administrator", "invigilator"), async (req: AuthedRequest, res) => {
  const sitting = await staffOnSitting(req, req.params.id);
  if (!sitting) return res.status(404).json({ error: "Sitting not found." });
  const rows = await codesForPrint(sitting.id);
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "sitting_codes_viewed", targetType: "sitting", targetId: sitting.id, reason: `${rows.length} learners` });
  const [q] = await db.select({ title: qualifications.title }).from(qualifications).where(eq(qualifications.id, sitting.qualificationId));
  return res.json({ sitting: { id: sitting.id, name: sitting.name, venue: sitting.venue, startTime: sitting.startTime.toISOString(), endTime: sitting.endTime.toISOString(), qualificationTitle: q?.title ?? "" }, rows });
});

// A learner whose code has been used (browser crash, wrong machine) is let
// back in once by the invigilator; the next entry consumes it again.
sittingsRouter.post("/:id/learners/:learnerId/allow-reentry", requireAuth, requireRole("administrator", "invigilator"), async (req: AuthedRequest, res) => {
  const sitting = await staffOnSitting(req, req.params.id);
  if (!sitting) return res.status(404).json({ error: "Sitting not found." });
  const [row] = await db.update(learnerSessions).set({ reentryAllowed: true }).where(and(eq(learnerSessions.sittingId, sitting.id), eq(learnerSessions.learnerId, req.params.learnerId))).returning({ id: learnerSessions.id });
  if (!row) return res.status(404).json({ error: "That learner is not on this sitting." });
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "sitting_reentry_allowed", targetType: "session", targetId: row.id });
  return res.json({ ok: true });
});


// ---- Block 5b: staff actions on a live paper ------------------------------------------------

async function sessionOnSitting(req: AuthedRequest, sittingId: string, learnerId: string) {
  const sitting = await staffOnSitting(req, sittingId);
  if (!sitting) return null;
  const [session] = await db.select().from(learnerSessions).where(and(eq(learnerSessions.sittingId, sitting.id), eq(learnerSessions.learnerId, learnerId)));
  return session ? { sitting, session } : null;
}

// Put a locked paper back for the learner.
sittingsRouter.post("/:id/learners/:learnerId/resume", requireAuth, requireRole("administrator", "invigilator"), async (req: AuthedRequest, res) => {
  const found = await sessionOnSitting(req, req.params.id, req.params.learnerId);
  if (!found) return res.status(404).json({ error: "That learner is not on this sitting." });
  const p = await staffResume(found.session.id, req.auth!.userId);
  return res.json({ ok: true, locks: p?.locks ?? 0 });
});

// Extra time for one learner (an accommodation, or lost minutes after a fault).
sittingsRouter.post("/:id/learners/:learnerId/extra-time", requireAuth, requireRole("administrator", "invigilator"), async (req: AuthedRequest, res) => {
  const parsed = z.object({ minutes: z.number().int().min(1).max(180), reason: z.string().trim().min(3).max(300) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Give the minutes (1-180) and a reason." });
  const found = await sessionOnSitting(req, req.params.id, req.params.learnerId);
  if (!found) return res.status(404).json({ error: "That learner is not on this sitting." });
  if (found.session.status === "submitted" || found.session.status === "sealed") return res.status(409).json({ error: "This paper has already been submitted." });
  const [u] = await db.update(learnerSessions).set({ extraMinutes: found.session.extraMinutes + parsed.data.minutes }).where(eq(learnerSessions.id, found.session.id)).returning();
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "session_extra_time", targetType: "session", targetId: found.session.id, reason: `+${parsed.data.minutes} min: ${parsed.data.reason}` });
  const [inst] = await db.select({ minutes: assessmentInstruments.timeAllocationMinutes }).from(assessmentInstruments).where(eq(assessmentInstruments.id, found.sitting.instrumentId));
  return res.json({ ok: true, extraMinutes: u.extraMinutes, deadline: deadlineFor(u.startedAt, inst?.minutes ?? 0, u.extraMinutes, found.sitting.endTime).toISOString() });
});

// Submit the paper as it stands on the learner's behalf (learner gone, or
// terminated for an integrity reason - recorded).
sittingsRouter.post("/:id/learners/:learnerId/submit", requireAuth, requireRole("administrator", "invigilator"), async (req: AuthedRequest, res) => {
  const parsed = z.object({ reason: z.string().trim().min(3).max(300) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Give a reason." });
  const found = await sessionOnSitting(req, req.params.id, req.params.learnerId);
  if (!found) return res.status(404).json({ error: "That learner is not on this sitting." });
  if (found.session.status !== "in_progress") return res.status(409).json({ error: `The paper is ${found.session.status.replace("_", " ")}, not in progress.` });
  await recordIncident(found.session.id, "ended_by_invigilator", { actionTaken: parsed.data.reason }, req.auth!.userId);
  const updated = await submitSession(found.session.id, new Date(), "invigilator", req.auth!.userId);
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "session_terminated", targetType: "session", targetId: found.session.id, reason: parsed.data.reason });
  return res.json({ ok: true, status: updated?.status ?? "submitted", sealHash: updated?.sealHash ?? null });
});


// ---- Block 5c: the invigilator console --------------------------------------------------------
//
//   GET  /sittings/mine                                  the caller's sittings (invigilator / assessor / admin: all)
//   GET  /sittings/:id/live                              everything the console shows, polled every few seconds
//   POST /sittings/:id/learners/:learnerId/note          a message shown once on the learner's screen
//   POST /sittings/:id/learners/:learnerId/request-capture
//   POST /sittings/:id/learners/:learnerId/incident      an observation by the invigilator (+ optional warning note)
//   GET  /sittings/:id/learners/:learnerId/evidence      the evidence timeline (also the assessor of record)

const NO_SIGNAL_S = 60; // an open paper silent this long is shown as "no signal"

sittingsRouter.get("/mine", requireAuth, requireRole("administrator", "invigilator", "assessor"), async (req: AuthedRequest, res) => {
  const me = req.auth!.userId;
  const admin = req.auth!.roles.includes("administrator");
  const since = new Date(Date.now() - 36 * 3600000); // yesterday's sittings stay listed for a day
  const rows = await db
    .select({
      sitting: examSittings,
      qualificationTitle: qualifications.title,
      paper: assessmentInstruments.version,
      minutes: assessmentInstruments.timeAllocationMinutes,
      learners: sql<number>`(SELECT count(*)::int FROM ${learnerSessions} ls WHERE ls.sitting_id = ${examSittings.id})`,
      checkedIn: sql<number>`(SELECT count(*)::int FROM ${learnerSessions} ls WHERE ls.sitting_id = ${examSittings.id} AND ls.status = 'checked_in')`,
      writing: sql<number>`(SELECT count(*)::int FROM ${learnerSessions} ls WHERE ls.sitting_id = ${examSittings.id} AND ls.status = 'in_progress')`,
      locked: sql<number>`(SELECT count(*)::int FROM ${learnerSessions} ls WHERE ls.sitting_id = ${examSittings.id} AND ls.status = 'in_progress' AND (ls.proctoring->>'lockedAt') IS NOT NULL)`,
      submitted: sql<number>`(SELECT count(*)::int FROM ${learnerSessions} ls WHERE ls.sitting_id = ${examSittings.id} AND ls.status IN ('submitted','sealed'))`,
      invigilators: sql<number>`(SELECT count(*)::int FROM ${sittingInvigilators} si WHERE si.sitting_id = ${examSittings.id})`,
      mine: admin ? sql<boolean>`true` : sql<boolean>`(${examSittings.assignedAssessorId} = ${me} OR EXISTS (SELECT 1 FROM ${sittingInvigilators} si WHERE si.sitting_id = ${examSittings.id} AND si.invigilator_id = ${me}))`,
    })
    .from(examSittings)
    .innerJoin(qualifications, eq(qualifications.id, examSittings.qualificationId))
    .innerJoin(assessmentInstruments, eq(assessmentInstruments.id, examSittings.instrumentId))
    .where(admin ? sql`${examSittings.endTime} > ${since}` : sql`${examSittings.endTime} > ${since} AND (${examSittings.assignedAssessorId} = ${me} OR EXISTS (SELECT 1 FROM ${sittingInvigilators} si WHERE si.sitting_id = ${examSittings.id} AND si.invigilator_id = ${me}))`)
    .orderBy(asc(examSittings.startTime))
    .limit(500);
  const now = Date.now();
  return res.json(
    rows.map((r) => ({
      id: r.sitting.id,
      name: r.sitting.name ?? `${r.qualificationTitle} · ${r.paper}`,
      qualificationTitle: r.qualificationTitle,
      paper: r.paper,
      minutes: r.minutes,
      venue: r.sitting.venue,
      startTime: r.sitting.startTime.toISOString(),
      endTime: r.sitting.endTime.toISOString(),
      phase: now < r.sitting.startTime.getTime() - 45 * 60000 ? "upcoming" : now < r.sitting.startTime.getTime() ? "check_in" : now < r.sitting.endTime.getTime() ? "live" : "ended",
      learners: r.learners,
      checkedIn: r.checkedIn,
      writing: r.writing,
      locked: r.locked,
      submitted: r.submitted,
      invigilators: r.invigilators,
      role: admin ? "administrator" : r.sitting.assignedAssessorId === me ? "assessor" : "invigilator",
    }))
  );
});

async function staffOrAssessorOnSitting(req: AuthedRequest, sittingId: string) {
  const sitting = await staffOnSitting(req, sittingId);
  if (sitting) return sitting;
  const [s] = await db.select().from(examSittings).where(eq(examSittings.id, sittingId));
  return s && s.assignedAssessorId === req.auth!.userId ? s : null;
}

sittingsRouter.get("/:id/live", requireAuth, requireRole("administrator", "invigilator", "assessor"), async (req: AuthedRequest, res) => {
  const sitting = await staffOrAssessorOnSitting(req, req.params.id);
  if (!sitting) return res.status(404).json({ error: "Sitting not found." });
  const [meta] = await db
    .select({ qualificationTitle: qualifications.title, paper: assessmentInstruments.version, minutes: assessmentInstruments.timeAllocationMinutes, questions: assessmentInstruments.questions })
    .from(examSittings)
    .innerJoin(qualifications, eq(qualifications.id, examSittings.qualificationId))
    .innerJoin(assessmentInstruments, eq(assessmentInstruments.id, examSittings.instrumentId))
    .where(eq(examSittings.id, sitting.id));
  const questionCount = Array.isArray(meta?.questions) ? (meta!.questions as unknown[]).length : 0;
  const rows = await db
    .select({ session: learnerSessions, name: users.name, studentNumber: users.studentNumber, idNumberLast4: users.idNumberLast4 })
    .from(learnerSessions)
    .innerJoin(users, eq(users.id, learnerSessions.learnerId))
    .where(eq(learnerSessions.sittingId, sitting.id))
    .orderBy(asc(users.name))
    .limit(1000);
  const ids = rows.map((r) => r.session.id);
  // Latest photo and screen per session, in one query.
  const latest = ids.length
    ? await db
        .selectDistinctOn([evidenceBlobs.sessionId, evidenceBlobs.kind], { sessionId: evidenceBlobs.sessionId, kind: evidenceBlobs.kind, id: evidenceBlobs.id })
        .from(evidenceBlobs)
        .where(and(inArray(evidenceBlobs.sessionId, ids), inArray(evidenceBlobs.kind, ["photo", "screen"])))
        .orderBy(evidenceBlobs.sessionId, evidenceBlobs.kind, desc(evidenceBlobs.createdAt))
    : [];
  const latestMap = new Map<string, { photo?: string; screen?: string }>();
  for (const l of latest) {
    const m = latestMap.get(l.sessionId) ?? {};
    if (l.kind === "photo") m.photo = l.id; else m.screen = l.id;
    latestMap.set(l.sessionId, m);
  }
  // Incidents: counts per session and the latest 40 for the alerts strip.
  const incidentRows = ids.length
    ? await db.select({ i: incidentLog, byName: users.name }).from(incidentLog).leftJoin(users, eq(users.id, incidentLog.raisedByUserId)).where(inArray(incidentLog.sessionId, ids)).orderBy(desc(incidentLog.occurredAt)).limit(400)
    : [];
  const incidentCount = new Map<string, number>();
  for (const { i } of incidentRows) incidentCount.set(i.sessionId, (incidentCount.get(i.sessionId) ?? 0) + 1);
  const nameOf = new Map(rows.map((r) => [r.session.id, r.name]));
  const learnerOf = new Map(rows.map((r) => [r.session.id, r.session.learnerId]));
  const now = Date.now();
  const recordingOn = fullRecordingOn(sitting.proctoringProfile);
  // Latest camera/screen segment per session for the console's near-live video.
  const latestSeg = ids.length && recordingOn
    ? await db
        .selectDistinctOn([recordingSegments.sessionId, recordingSegments.kind], { sessionId: recordingSegments.sessionId, kind: recordingSegments.kind, id: recordingSegments.id, startedAt: recordingSegments.startedAt, durationMs: recordingSegments.durationMs })
        .from(recordingSegments)
        .where(inArray(recordingSegments.sessionId, ids))
        .orderBy(recordingSegments.sessionId, recordingSegments.kind, desc(recordingSegments.seq))
    : [];
  const latestSegMap = new Map<string, { camera?: { id: string; startedAt: string; durationMs: number }; screen?: { id: string; startedAt: string; durationMs: number } }>();
  for (const l of latestSeg) {
    const m = latestSegMap.get(l.sessionId) ?? {};
    m[l.kind as "camera" | "screen"] = { id: l.id, startedAt: l.startedAt.toISOString(), durationMs: l.durationMs };
    latestSegMap.set(l.sessionId, m);
  }
  const learners = rows.map((r) => {
    const s = r.session;
    const p = proctoringOf(s.proctoring);
    const pre = (s.precheck ?? {}) as { identityPhotoId?: string; camera?: boolean };
    const deadline = deadlineFor(s.startedAt, meta?.minutes ?? 0, s.extraMinutes, sitting.endTime);
    const lastSeen = p.lastSeenAt ? new Date(p.lastSeenAt).getTime() : null;
    const noSignal = s.status === "in_progress" && (!lastSeen || now - lastSeen > NO_SIGNAL_S * 1000);
    const answered = s.answers && typeof s.answers === "object" ? Object.values(s.answers as Record<string, unknown>).filter((v) => typeof v === "string" && v.trim() !== "").length : 0;
    // Attention: red = needs the invigilator now; amber = worth a look; none otherwise.
    let attention: "red" | "amber" | null = null;
    const reasons: string[] = [];
    if (s.status === "in_progress") {
      if (p.requiresInvigilator) { attention = "red"; reasons.push("locked — needs you"); }
      else if (p.lockedAt) { attention = attention ?? "amber"; reasons.push("locked"); }
      if (noSignal) { attention = "red"; reasons.push("no signal"); }
      if (p.screenShare && p.screenShare !== "monitor") { attention = attention ?? "amber"; reasons.push(p.screenShare === "none" || p.screenShare === "unsupported" ? "screen not shared" : `sharing a ${p.screenShare}`); }
      if (p.pasteAttempts) { attention = attention ?? "amber"; reasons.push(`${p.pasteAttempts} paste`); }
      if (p.focusLosses + p.fullscreenExits >= 2) { attention = attention ?? "amber"; reasons.push(`left window ${p.focusLosses + p.fullscreenExits}×`); }
      if ((p.cameraLost ?? 0) > 0) { attention = attention ?? "amber"; reasons.push("camera dropped"); }
      if (recordingOn) {
        const rec = p.recording;
        const sinceStart = s.startedAt ? (now - s.startedAt.getTime()) / 1000 : 0;
        if (sinceStart > SEGMENT_SECONDS * 2.5 && (!rec || !rec.lastAt || now - new Date(rec.lastAt).getTime() > SEGMENT_SECONDS * 2.5 * 1000)) { attention = attention ?? "amber"; reasons.push("recording not arriving"); }
        else if ((rec?.pending ?? 0) >= 3) { attention = attention ?? "amber"; reasons.push(`uploads behind (${rec!.pending})`); }
      }
    }
    return {
      sessionId: s.id,
      learnerId: s.learnerId,
      name: r.name,
      studentNumber: r.studentNumber,
      idNumberMasked: r.idNumberLast4 ? `••••••••• ${r.idNumberLast4}` : null,
      status: s.status,
      checkInTime: s.checkInTime?.toISOString() ?? null,
      startedAt: s.startedAt?.toISOString() ?? null,
      submissionTime: s.submissionTime?.toISOString() ?? null,
      deadline: s.status === "in_progress" ? deadline.toISOString() : null,
      extraMinutes: s.extraMinutes,
      entries: s.entries,
      reentryAllowed: s.reentryAllowed,
      codeIssued: Boolean(s.codeHash),
      locked: Boolean(p.lockedAt),
      lockReason: p.lockReason ?? null,
      requiresInvigilator: Boolean(p.requiresInvigilator),
      locks: p.locks,
      focusLosses: p.focusLosses,
      fullscreenExits: p.fullscreenExits,
      pasteAttempts: p.pasteAttempts,
      photos: p.photos,
      screens: p.screens,
      screenShare: p.screenShare ?? null,
      cameraLost: p.cameraLost ?? 0,
      identityPhotoId: pre.identityPhotoId ?? null,
      camera: pre.camera ?? null,
      latestPhotoId: latestMap.get(s.id)?.photo ?? null,
      latestScreenId: latestMap.get(s.id)?.screen ?? null,
      lastPhotoAt: p.lastPhotoAt ?? null,
      lastScreenAt: p.lastScreenAt ?? null,
      lastSeenAt: p.lastSeenAt ?? null,
      noSignal,
      captureRequested: captureRequestPending(p),
      notesUnseen: (p.notes ?? []).filter((n) => !n.seenAt).length,
      incidents: incidentCount.get(s.id) ?? 0,
      answered,
      questionCount,
      sealHash: s.sealHash ? s.sealHash.slice(0, 16) : null,
      attention,
      attentionReasons: reasons,
      recording: recordingOn ? { camera: p.recording?.camera ?? 0, screen: p.recording?.screen ?? 0, pending: p.recording?.pending ?? 0, lastAt: p.recording?.lastAt ?? null, bytes: p.recording?.bytes ?? 0, latestCamera: latestSegMap.get(s.id)?.camera ?? null, latestScreen: latestSegMap.get(s.id)?.screen ?? null } : null,
    };
  });
  const alerts = incidentRows
    .slice(0, 40)
    .map(({ i, byName }) => ({ id: i.id, sessionId: i.sessionId, learnerId: learnerOf.get(i.sessionId) ?? null, learnerName: nameOf.get(i.sessionId) ?? "", type: i.type, at: i.occurredAt.toISOString(), detail: i.actionTaken, by: i.raisedBy === "invigilator" ? byName ?? "invigilator" : "system" }));
  const invigilators = await db.select({ id: users.id, name: users.name }).from(sittingInvigilators).innerJoin(users, eq(users.id, sittingInvigilators.invigilatorId)).where(eq(sittingInvigilators.sittingId, sitting.id));
  return res.json({
    sitting: { id: sitting.id, name: sitting.name ?? `${meta?.qualificationTitle ?? ""} · ${meta?.paper ?? ""}`, qualificationTitle: meta?.qualificationTitle ?? "", paper: meta?.paper ?? "", minutes: meta?.minutes ?? 0, venue: sitting.venue, startTime: sitting.startTime.toISOString(), endTime: sitting.endTime.toISOString(), invigilators, fullRecording: recordingOn, segmentSeconds: SEGMENT_SECONDS },
    serverTime: new Date(now).toISOString(),
    counts: {
      total: learners.length,
      scheduled: learners.filter((l) => l.status === "scheduled").length,
      checkedIn: learners.filter((l) => l.status === "checked_in").length,
      writing: learners.filter((l) => l.status === "in_progress").length,
      locked: learners.filter((l) => l.locked).length,
      needsYou: learners.filter((l) => l.attention === "red").length,
      submitted: learners.filter((l) => l.status === "submitted" || l.status === "sealed").length,
    },
    manualIncidentTypes: Object.entries(MANUAL_INCIDENTS).map(([code, m]) => ({ code, title: m.title, severity: m.severity })),
    learners,
    alerts,
  });
});

sittingsRouter.post("/:id/learners/:learnerId/note", requireAuth, requireRole("administrator", "invigilator"), async (req: AuthedRequest, res) => {
  const parsed = z.object({ text: z.string().trim().min(2).max(300) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Type the message (2-300 characters)." });
  const found = await sessionOnSitting(req, req.params.id, req.params.learnerId);
  if (!found) return res.status(404).json({ error: "That learner is not on this sitting." });
  if (found.session.status !== "in_progress" && found.session.status !== "checked_in") return res.status(409).json({ error: "The learner is not in the room." });
  const note = await staffNote(found.session.id, req.auth!.userId, parsed.data.text);
  return res.json({ ok: true, note });
});

sittingsRouter.post("/:id/learners/:learnerId/request-capture", requireAuth, requireRole("administrator", "invigilator"), async (req: AuthedRequest, res) => {
  const found = await sessionOnSitting(req, req.params.id, req.params.learnerId);
  if (!found) return res.status(404).json({ error: "That learner is not on this sitting." });
  if (found.session.status !== "in_progress") return res.status(409).json({ error: "The paper is not open." });
  await staffRequestCapture(found.session.id, req.auth!.userId);
  return res.json({ ok: true });
});

sittingsRouter.post("/:id/learners/:learnerId/incident", requireAuth, requireRole("administrator", "invigilator"), async (req: AuthedRequest, res) => {
  const parsed = z.object({ type: z.enum(Object.keys(MANUAL_INCIDENTS) as [string, ...string[]]), note: z.string().trim().max(300).optional(), warnLearner: z.string().trim().min(2).max(300).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose what you observed." });
  const found = await sessionOnSitting(req, req.params.id, req.params.learnerId);
  if (!found) return res.status(404).json({ error: "That learner is not on this sitting." });
  if (found.session.status !== "in_progress" && found.session.status !== "checked_in") return res.status(409).json({ error: "The learner is not in the room." });
  await staffIncident(found.session.id, req.auth!.userId, parsed.data.type, parsed.data.note);
  if (parsed.data.warnLearner) await staffNote(found.session.id, req.auth!.userId, parsed.data.warnLearner);
  return res.json({ ok: true });
});

sittingsRouter.get("/:id/learners/:learnerId/evidence", requireAuth, requireRole("administrator", "invigilator", "assessor"), async (req: AuthedRequest, res) => {
  const sitting = await staffOrAssessorOnSitting(req, req.params.id);
  if (!sitting) return res.status(404).json({ error: "Sitting not found." });
  const [session] = await db.select().from(learnerSessions).where(and(eq(learnerSessions.sittingId, sitting.id), eq(learnerSessions.learnerId, req.params.learnerId)));
  if (!session) return res.status(404).json({ error: "That learner is not on this sitting." });
  const [timeline, integrity] = await Promise.all([evidenceTimeline(session.id), integrityReportFor(session.id)]);
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "session_evidence_viewed", targetType: "session", targetId: session.id });
  return res.json({ sessionId: session.id, timeline, integrity, blobs: await db.select({ n: sql<number>`count(*)::int` }).from(evidenceBlobs).where(eq(evidenceBlobs.sessionId, session.id)).then((r) => r[0].n) });
});

// Block 8b: the recording of one learner's sitting - every segment, both streams.
sittingsRouter.get("/:id/learners/:learnerId/recording", requireAuth, requireRole("administrator", "invigilator", "assessor"), async (req: AuthedRequest, res) => {
  const sitting = await staffOrAssessorOnSitting(req, req.params.id);
  if (!sitting) return res.status(404).json({ error: "Sitting not found." });
  const [session] = await db.select().from(learnerSessions).where(and(eq(learnerSessions.sittingId, sitting.id), eq(learnerSessions.learnerId, req.params.learnerId)));
  if (!session) return res.status(404).json({ error: "That learner is not on this sitting." });
  const segments = await segmentsFor(session.id);
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "session_recording_viewed", targetType: "session", targetId: session.id });
  return res.json({ sessionId: session.id, fullRecording: fullRecordingOn(sitting.proctoringProfile), segmentSeconds: SEGMENT_SECONDS, startedAt: session.startedAt?.toISOString() ?? null, submittedAt: session.submissionTime?.toISOString() ?? null, segments, totalBytes: segments.reduce((n, x) => n + x.bytes, 0) });
});

// ---- Block 8c: the evidence archive ---------------------------------------------------------
//
//   GET /sittings/archive                                   completed sittings and what the record holds (administrator)
//   GET /sittings/:id/register                              the sitting register as data (admin / invigilator on it / assessor of record)
//   GET /sittings/:id/register.pdf                          the sitting register (PDF)
//   GET /sittings/:id/portfolio.zip?video=1                 the Portfolio of Evidence for the governing body (administrator)
//   GET /sittings/:id/learners/:learnerId/evidence-pack.pdf one learner's evidence pack
//   GET /sittings/:id/learners/:learnerId/evidence-pack.zip?video=1   ...with the files (captures, statement, recording)
//
// Every download is written to the audit trail with who took it.

sittingsRouter.get("/archive", requireAuth, requireRole("administrator"), async (_req: AuthedRequest, res) => {
  const { archiveRows } = await import("../results/portfolio.js");
  return res.json(await archiveRows());
});

const registerJson = (d: Awaited<ReturnType<typeof import("../results/portfolio.js")["loadSittingRegister"]>>) => {
  if (!d) return null;
  return {
    sitting: { id: d.sitting.id, name: d.sitting.name, venue: d.sitting.venue, startTime: d.sitting.startTime.toISOString(), endTime: d.sitting.endTime.toISOString(), fullRecording: d.fullRecording, instrumentId: d.instrument.id, paper: d.instrument.version, qualificationTitle: d.qualification.title, assessor: d.assessor?.name ?? null, invigilators: d.invigilators.map((i) => i.name), cohort: d.cohort?.name ?? null, retentionUntil: d.retentionUntil.toISOString() },
    learners: d.learners.map((l) => ({ sessionId: l.sessionId, learnerId: l.learnerId, name: l.name, idNumberMasked: l.idNumber ? l.idNumber.slice(0, 6) + "•••••••" : null, studentNumber: l.studentNumber, status: l.status, checkInTime: l.checkInTime?.toISOString() ?? null, startedAt: l.startedAt?.toISOString() ?? null, submittedAt: l.submittedAt?.toISOString() ?? null, extraMinutes: l.extraMinutes, integrity: l.integrity, result: l.result ? { ...l.result, signedOffAt: l.result.signedOffAt.toISOString() } : null, marking: l.marking, stills: l.stills, recording: l.recording, packNumber: l.packNumber })),
  };
};

sittingsRouter.get("/:id/register", requireAuth, requireRole("administrator", "invigilator", "assessor"), async (req: AuthedRequest, res) => {
  const sitting = await staffOrAssessorOnSitting(req, req.params.id);
  if (!sitting) return res.status(404).json({ error: "Sitting not found." });
  const { loadSittingRegister } = await import("../results/portfolio.js");
  return res.json(registerJson(await loadSittingRegister(sitting.id)));
});

sittingsRouter.get("/:id/register.pdf", requireAuth, requireRole("administrator", "invigilator", "assessor"), async (req: AuthedRequest, res) => {
  const sitting = await staffOrAssessorOnSitting(req, req.params.id);
  if (!sitting) return res.status(404).json({ error: "Sitting not found." });
  const { loadSittingRegister, renderRegister } = await import("../results/portfolio.js");
  const d = await loadSittingRegister(sitting.id);
  if (!d) return res.status(404).json({ error: "Sitting not found." });
  const pdf = await renderRegister(d);
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "sitting_register_downloaded", targetType: "sitting", targetId: sitting.id });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="Sitting-Register-${d.sitting.startTime.toISOString().slice(0, 10)}.pdf"`);
  res.setHeader("Cache-Control", "private, no-store");
  return res.send(pdf);
});

sittingsRouter.get("/:id/portfolio.zip", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  const [sitting] = await db.select().from(examSittings).where(eq(examSittings.id, req.params.id));
  if (!sitting) return res.status(404).json({ error: "Sitting not found." });
  const { loadSittingRegister, streamPortfolio } = await import("../results/portfolio.js");
  const d = await loadSittingRegister(sitting.id);
  if (!d) return res.status(404).json({ error: "Sitting not found." });
  const video = req.query.video === "1" || req.query.video === "true";
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "sitting_portfolio_downloaded", targetType: "sitting", targetId: sitting.id, reason: video ? "with video" : "documents and captures" });
  try {
    await streamPortfolio(res, d, { video });
  } catch (err) {
    console.error("portfolio failed", sitting.id, err);
    if (!res.headersSent) return res.status(500).json({ error: "The portfolio could not be assembled." });
    res.end();
  }
});

async function learnerSessionOn(req: AuthedRequest, sittingId: string, learnerId: string) {
  const sitting = await staffOrAssessorOnSitting(req, sittingId);
  if (!sitting) return null;
  const [session] = await db.select().from(learnerSessions).where(and(eq(learnerSessions.sittingId, sitting.id), eq(learnerSessions.learnerId, learnerId)));
  return session ? { sitting, session } : null;
}

sittingsRouter.get("/:id/learners/:learnerId/evidence-pack.pdf", requireAuth, requireRole("administrator", "invigilator", "assessor"), async (req: AuthedRequest, res) => {
  const found = await learnerSessionOn(req, req.params.id, req.params.learnerId);
  if (!found) return res.status(404).json({ error: "That learner is not on this sitting." });
  const { loadEvidencePack, renderEvidencePack, loadBlobs } = await import("../results/evidencePack.js");
  const d = await loadEvidencePack(found.session.id);
  if (!d) return res.status(404).json({ error: "Not found." });
  const pdf = await renderEvidencePack(d, await loadBlobs(found.session.id));
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "session_evidence_pack_downloaded", targetType: "session", targetId: found.session.id, reason: d.packNumber });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="Evidence-Pack-${d.packNumber}.pdf"`);
  res.setHeader("Cache-Control", "private, no-store");
  return res.send(pdf);
});

sittingsRouter.get("/:id/learners/:learnerId/evidence-pack.zip", requireAuth, requireRole("administrator", "invigilator", "assessor"), async (req: AuthedRequest, res) => {
  const found = await learnerSessionOn(req, req.params.id, req.params.learnerId);
  if (!found) return res.status(404).json({ error: "That learner is not on this sitting." });
  const video = req.query.video === "1" || req.query.video === "true";
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "session_evidence_pack_downloaded", targetType: "session", targetId: found.session.id, reason: video ? "zip with video" : "zip" });
  const { streamLearnerZip } = await import("../results/portfolio.js");
  try {
    const ok = await streamLearnerZip(res, found.session.id, { video });
    if (!ok && !res.headersSent) return res.status(404).json({ error: "Not found." });
  } catch (err) {
    console.error("evidence zip failed", found.session.id, err);
    if (!res.headersSent) return res.status(500).json({ error: "The evidence could not be assembled." });
    res.end();
  }
});
