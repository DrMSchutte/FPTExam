import { Router } from "express";
import { z } from "zod";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  cohorts,
  cohortMembers,
  users,
  userRoles,
  qualifications,
  examSittings,
  learnerSessions,
  assessmentInstruments,
  auditLog,
} from "../db/schema.js";
import { requireAuth, requireRole, type AuthedRequest } from "../auth/middleware.js";

// Cohorts (build plan Block 2): the working unit for students.
//
//   GET    /cohorts?q=&status=&qualificationId=            list with member / sitting counts
//   POST   /cohorts                                        create
//   GET    /cohorts/:id                                    cohort page (details, counts, sittings)
//   PATCH  /cohorts/:id                                    edit / close / reopen
//   GET    /cohorts/:id/members?q=&page=                   paged members
//   POST   /cohorts/:id/members        { learnerIds }      add students
//   DELETE /cohorts/:id/members        { learnerIds }      remove students
//   POST   /cohorts/:id/members/move   { learnerIds, toCohortId }
//   GET    /cohorts/:id/members/export.csv
//
// Allocating a whole cohort to a sitting lives on the sitting:
//   POST /sittings/:id/assign-cohort { cohortId }  (and a sitting created with a
//   cohortId allocates the cohort's members immediately).

export const cohortsRouter = Router();

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

const cohortFields = {
  name: z.string().trim().min(2).max(120),
  qualificationId: z.string().uuid().nullable().optional(),
  site: z.string().trim().max(80).nullable().optional(),
  intake: z.string().trim().max(60).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  externalRef: z.string().trim().max(80).nullable().optional(),
};

// ---- Shared counts --------------------------------------------------------------------

async function countsFor(cohortIds: string[]) {
  const members = new Map<string, number>();
  const sittings = new Map<string, number>();
  if (!cohortIds.length) return { members, sittings };
  const m = await db
    .select({ cohortId: cohortMembers.cohortId, n: sql<number>`count(*)::int` })
    .from(cohortMembers)
    .where(inArray(cohortMembers.cohortId, cohortIds))
    .groupBy(cohortMembers.cohortId);
  for (const r of m) members.set(r.cohortId, r.n);
  const s = await db
    .select({ cohortId: examSittings.cohortId, n: sql<number>`count(*)::int` })
    .from(examSittings)
    .where(inArray(examSittings.cohortId, cohortIds))
    .groupBy(examSittings.cohortId);
  for (const r of s) if (r.cohortId) sittings.set(r.cohortId, r.n);
  return { members, sittings };
}

function cohortRow(c: typeof cohorts.$inferSelect, qualTitle: string | null, members: number, sittings: number) {
  return {
    id: c.id,
    name: c.name,
    qualificationId: c.qualificationId,
    qualificationTitle: qualTitle,
    site: c.site,
    intake: c.intake,
    notes: c.notes,
    status: c.status,
    externalRef: c.externalRef,
    members,
    sittings,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

async function qualTitles(ids: (string | null)[]) {
  const map = new Map<string, string>();
  const clean = ids.filter((x): x is string => Boolean(x));
  if (!clean.length) return map;
  const rows = await db.select({ id: qualifications.id, title: qualifications.title }).from(qualifications).where(inArray(qualifications.id, clean));
  for (const r of rows) map.set(r.id, r.title);
  return map;
}

// ---- List / create ----------------------------------------------------------------------

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(["active", "closed"]).optional(),
  qualificationId: z.string().uuid().optional(),
});

cohortsRouter.get("/", requireAuth, requireRole("administrator"), async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid query.", detail: parsed.error.message });
  const { q, status, qualificationId } = parsed.data;
  const where = and(
    q ? or(ilike(cohorts.name, `%${q}%`), ilike(cohorts.site, `%${q}%`), ilike(cohorts.intake, `%${q}%`)) : undefined,
    status ? eq(cohorts.status, status) : undefined,
    qualificationId ? eq(cohorts.qualificationId, qualificationId) : undefined
  );
  const rows = await db.select().from(cohorts).where(where).orderBy(asc(cohorts.status), asc(cohorts.name)).limit(2000);
  const { members, sittings } = await countsFor(rows.map((r) => r.id));
  const titles = await qualTitles(rows.map((r) => r.qualificationId));
  return res.json(rows.map((c) => cohortRow(c, c.qualificationId ? titles.get(c.qualificationId) ?? null : null, members.get(c.id) ?? 0, sittings.get(c.id) ?? 0)));
});

cohortsRouter.post("/", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  const parsed = z.object(cohortFields).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });
  const p = parsed.data;
  const [dupe] = await db.select({ id: cohorts.id }).from(cohorts).where(sql`lower(${cohorts.name}) = lower(${p.name})`);
  if (dupe) return res.status(409).json({ error: "A cohort with that name already exists." });
  if (p.qualificationId) {
    const [q] = await db.select({ id: qualifications.id }).from(qualifications).where(eq(qualifications.id, p.qualificationId));
    if (!q) return res.status(404).json({ error: "Qualification not found." });
  }
  const [c] = await db
    .insert(cohorts)
    .values({
      name: p.name,
      qualificationId: p.qualificationId ?? null,
      site: p.site || null,
      intake: p.intake || null,
      notes: p.notes || null,
      externalRef: p.externalRef || null,
      createdBy: req.auth!.userId,
    })
    .returning();
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "cohort_created", targetType: "cohort", targetId: c.id, reason: c.name });
  const titles = await qualTitles([c.qualificationId]);
  return res.status(201).json(cohortRow(c, c.qualificationId ? titles.get(c.qualificationId) ?? null : null, 0, 0));
});

// ---- Detail ------------------------------------------------------------------------------

async function loadCohort(id: string) {
  if (!isUuid(id)) return undefined;
  const [c] = await db.select().from(cohorts).where(eq(cohorts.id, id));
  return c;
}

cohortsRouter.get("/:id", requireAuth, requireRole("administrator"), async (req, res) => {
  const c = await loadCohort(req.params.id);
  if (!c) return res.status(404).json({ error: "Cohort not found." });
  const { members, sittings } = await countsFor([c.id]);
  const titles = await qualTitles([c.qualificationId]);

  const statusCounts = await db
    .select({ status: users.status, n: sql<number>`count(*)::int` })
    .from(cohortMembers)
    .innerJoin(users, eq(users.id, cohortMembers.learnerId))
    .where(eq(cohortMembers.cohortId, c.id))
    .groupBy(users.status);

  // Sittings scheduled for this cohort, with how many of the cohort are on each
  // and how many have a released result.
  const sittingRows = await db
    .select({
      id: examSittings.id,
      name: examSittings.name,
      startTime: examSittings.startTime,
      endTime: examSittings.endTime,
      instrumentId: examSittings.instrumentId,
      version: assessmentInstruments.version,
      qualificationTitle: qualifications.title,
      assessorName: users.name,
      learners: sql<number>`(SELECT count(*)::int FROM ${learnerSessions} ls WHERE ls.sitting_id = ${examSittings.id})`,
      submitted: sql<number>`(SELECT count(*)::int FROM ${learnerSessions} ls WHERE ls.sitting_id = ${examSittings.id} AND ls.status IN ('submitted','sealed'))`,
    })
    .from(examSittings)
    .innerJoin(assessmentInstruments, eq(assessmentInstruments.id, examSittings.instrumentId))
    .innerJoin(qualifications, eq(qualifications.id, examSittings.qualificationId))
    .innerJoin(users, eq(users.id, examSittings.assignedAssessorId))
    .where(eq(examSittings.cohortId, c.id))
    .orderBy(desc(examSittings.startTime));

  const audit = await db
    .select({ action: auditLog.action, reason: auditLog.reason, at: auditLog.occurredAt })
    .from(auditLog)
    .where(and(eq(auditLog.targetType, "cohort"), eq(auditLog.targetId, c.id)))
    .orderBy(desc(auditLog.occurredAt))
    .limit(20);

  return res.json({
    ...cohortRow(c, c.qualificationId ? titles.get(c.qualificationId) ?? null : null, members.get(c.id) ?? 0, sittings.get(c.id) ?? 0),
    memberStatus: Object.fromEntries(statusCounts.map((r) => [r.status, r.n])),
    sittingList: sittingRows.map((s) => ({
      id: s.id,
      name: s.name,
      startTime: s.startTime.toISOString(),
      endTime: s.endTime.toISOString(),
      instrumentId: s.instrumentId,
      paper: `${s.qualificationTitle} — ${s.version}`,
      assessorName: s.assessorName,
      learners: s.learners,
      submitted: s.submitted,
    })),
    audit: audit.map((a) => ({ ...a, at: a.at.toISOString() })),
  });
});

const patchSchema = z.object({
  name: cohortFields.name.optional(),
  qualificationId: cohortFields.qualificationId,
  site: cohortFields.site,
  intake: cohortFields.intake,
  notes: cohortFields.notes,
  externalRef: cohortFields.externalRef,
  status: z.enum(["active", "closed"]).optional(),
});

cohortsRouter.patch("/:id", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  const c = await loadCohort(req.params.id);
  if (!c) return res.status(404).json({ error: "Cohort not found." });
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });
  const p = parsed.data;
  if (p.name && p.name.toLowerCase() !== c.name.toLowerCase()) {
    const [dupe] = await db.select({ id: cohorts.id }).from(cohorts).where(sql`lower(${cohorts.name}) = lower(${p.name})`);
    if (dupe) return res.status(409).json({ error: "A cohort with that name already exists." });
  }
  const set: Partial<typeof cohorts.$inferInsert> = { updatedAt: new Date() };
  if (p.name !== undefined) set.name = p.name;
  if (p.qualificationId !== undefined) set.qualificationId = p.qualificationId;
  if (p.site !== undefined) set.site = p.site || null;
  if (p.intake !== undefined) set.intake = p.intake || null;
  if (p.notes !== undefined) set.notes = p.notes || null;
  if (p.externalRef !== undefined) set.externalRef = p.externalRef || null;
  if (p.status !== undefined) set.status = p.status;
  const [updated] = await db.update(cohorts).set(set).where(eq(cohorts.id, c.id)).returning();
  await db.insert(auditLog).values({
    actorId: req.auth!.userId,
    action: p.status && p.status !== c.status ? (p.status === "closed" ? "cohort_closed" : "cohort_reopened") : "cohort_edited",
    targetType: "cohort",
    targetId: c.id,
    reason: Object.keys(set).filter((k) => k !== "updatedAt").join(", "),
  });
  const { members, sittings } = await countsFor([c.id]);
  const titles = await qualTitles([updated.qualificationId]);
  return res.json(cohortRow(updated, updated.qualificationId ? titles.get(updated.qualificationId) ?? null : null, members.get(c.id) ?? 0, sittings.get(c.id) ?? 0));
});

// ---- Members ----------------------------------------------------------------------------

const membersQuery = z.object({
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(500).default(50),
});

cohortsRouter.get("/:id/members", requireAuth, requireRole("administrator"), async (req, res) => {
  const c = await loadCohort(req.params.id);
  if (!c) return res.status(404).json({ error: "Cohort not found." });
  const parsed = membersQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid query." });
  const { q, page, pageSize } = parsed.data;
  const term = q ? `%${q}%` : null;
  const digits = q?.replace(/\s/g, "") ?? "";
  const where = and(
    eq(cohortMembers.cohortId, c.id),
    term
      ? or(ilike(users.name, term), ilike(users.email, term), ilike(users.studentNumber, term), /^\d{4,13}$/.test(digits) ? eq(users.idNumberLast4, digits.slice(-4)) : undefined)
      : undefined
  );
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(cohortMembers).innerJoin(users, eq(users.id, cohortMembers.learnerId)).where(where);
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      status: users.status,
      studentNumber: users.studentNumber,
      idNumberLast4: users.idNumberLast4,
      addedAt: cohortMembers.addedAt,
    })
    .from(cohortMembers)
    .innerJoin(users, eq(users.id, cohortMembers.learnerId))
    .where(where)
    .orderBy(asc(users.name), asc(users.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return res.json({
    rows: rows.map((r) => ({ ...r, idNumberMasked: r.idNumberLast4 ? `••••••••• ${r.idNumberLast4}` : null, idNumberLast4: undefined, addedAt: r.addedAt.toISOString() })),
    total: count,
    page,
    pageSize,
  });
});

cohortsRouter.get("/:id/members/export.csv", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  const c = await loadCohort(req.params.id);
  if (!c) return res.status(404).json({ error: "Cohort not found." });
  const rows = await db
    .select({ name: users.name, email: users.email, status: users.status, studentNumber: users.studentNumber, idNumberLast4: users.idNumberLast4, addedAt: cohortMembers.addedAt })
    .from(cohortMembers)
    .innerJoin(users, eq(users.id, cohortMembers.learnerId))
    .where(eq(cohortMembers.cohortId, c.id))
    .orderBy(asc(users.name));
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [["cohort", "name", "email", "status", "id_number_last4", "student_number", "added_on"].join(",")];
  for (const r of rows) lines.push([c.name, r.name, r.email, r.status, r.idNumberLast4, r.studentNumber, r.addedAt.toISOString().slice(0, 10)].map(esc).join(","));
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "cohort_members_exported", targetType: "cohort", targetId: c.id, reason: `${rows.length} rows` });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${c.name.replace(/[^\w.-]+/g, "_")}-students.csv"`);
  res.send(lines.join("\n") + "\n");
});

const idsSchema = z.object({ learnerIds: z.array(z.string().uuid()).min(1).max(5000) });

// Only students (learner role) who are not archived can join a cohort.
async function eligibleLearners(ids: string[]) {
  const rows = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .innerJoin(userRoles, and(eq(userRoles.userId, users.id), eq(userRoles.role, "learner")))
    .where(inArray(users.id, ids));
  const ok = rows.filter((r) => r.status !== "archived").map((r) => r.id);
  return { ok, notStudents: ids.length - rows.length, archived: rows.length - ok.length };
}

cohortsRouter.post("/:id/members", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  const c = await loadCohort(req.params.id);
  if (!c) return res.status(404).json({ error: "Cohort not found." });
  if (c.status === "closed") return res.status(409).json({ error: "This cohort is closed. Reopen it to add students." });
  const parsed = idsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });
  const { ok, notStudents, archived } = await eligibleLearners([...new Set(parsed.data.learnerIds)]);
  let added = 0;
  if (ok.length) {
    const ins = await db
      .insert(cohortMembers)
      .values(ok.map((learnerId) => ({ cohortId: c.id, learnerId, addedBy: req.auth!.userId })))
      .onConflictDoNothing()
      .returning({ learnerId: cohortMembers.learnerId });
    added = ins.length;
  }
  if (added) await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "cohort_members_added", targetType: "cohort", targetId: c.id, reason: `${added} added` });
  return res.json({ added, alreadyMembers: ok.length - added, notStudents, archived });
});

cohortsRouter.delete("/:id/members", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  const c = await loadCohort(req.params.id);
  if (!c) return res.status(404).json({ error: "Cohort not found." });
  const parsed = idsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });
  const del = await db
    .delete(cohortMembers)
    .where(and(eq(cohortMembers.cohortId, c.id), inArray(cohortMembers.learnerId, parsed.data.learnerIds)))
    .returning({ learnerId: cohortMembers.learnerId });
  if (del.length) await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "cohort_members_removed", targetType: "cohort", targetId: c.id, reason: `${del.length} removed` });
  return res.json({ removed: del.length });
});

cohortsRouter.post("/:id/members/move", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  const from = await loadCohort(req.params.id);
  if (!from) return res.status(404).json({ error: "Cohort not found." });
  const parsed = idsSchema.extend({ toCohortId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });
  const to = await loadCohort(parsed.data.toCohortId);
  if (!to) return res.status(404).json({ error: "Destination cohort not found." });
  if (to.id === from.id) return res.status(400).json({ error: "Choose a different cohort to move to." });
  if (to.status === "closed") return res.status(409).json({ error: `${to.name} is closed. Reopen it first.` });
  const moved = await db.transaction(async (tx) => {
    const del = await tx
      .delete(cohortMembers)
      .where(and(eq(cohortMembers.cohortId, from.id), inArray(cohortMembers.learnerId, parsed.data.learnerIds)))
      .returning({ learnerId: cohortMembers.learnerId });
    if (!del.length) return 0;
    await tx
      .insert(cohortMembers)
      .values(del.map((d) => ({ cohortId: to.id, learnerId: d.learnerId, addedBy: req.auth!.userId })))
      .onConflictDoNothing();
    return del.length;
  });
  if (moved) {
    await db.insert(auditLog).values([
      { actorId: req.auth!.userId, action: "cohort_members_moved_out", targetType: "cohort", targetId: from.id, reason: `${moved} moved to ${to.name}` },
      { actorId: req.auth!.userId, action: "cohort_members_moved_in", targetType: "cohort", targetId: to.id, reason: `${moved} moved from ${from.name}` },
    ]);
  }
  return res.json({ moved, toCohortName: to.name });
});
