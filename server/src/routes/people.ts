import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import * as XLSX from "xlsx";
import { randomBytes } from "node:crypto";
import { db } from "../db/index.js";
import {
  users,
  userRoles,
  auditLog,
  learnerSessions,
  examSittings,
  sittingInvigilators,
  assessorDecisions,
  qualifications,
  accountSetupTokens,
  cohorts,
  cohortMembers,
  assessorScopes,
} from "../db/schema.js";
import { requireAuth, requireRole, forgetAccountStatus, type AuthedRequest } from "../auth/middleware.js";
import { hashPassword } from "../auth/password.js";
import { generateMfaSecret } from "../auth/mfa.js";
import { encryptField, decryptField, last4, hashIdentifier } from "../auth/crypto.js";
import { issueSetupLink, appBaseUrl } from "../auth/setupLinks.js";
import type { UserRole } from "../types.js";

// Register People at scale (build plan Block 1).
//
//   GET  /people?type=&q=&status=&page=&pageSize=&sort=   paged, filtered, sorted list
//   GET  /people/:id                                      person page (profile + history)
//   PATCH /people/:id                                     edit details / status
//   POST /people/chase-setup-links?type=                  re-issue every unused set-up link
//   GET  /people/import/template.csv                      import template
//   POST /people/import/preview  (file)                   what would happen, row by row
//   POST /people/import/commit   { rows }                 apply the previewed rows
//   GET  /people/export.csv?type=&q=&status=              the filtered list as CSV
//
// "type" is how the Administrator thinks about people: students | assessors |
// invigilators | administrators. Roles are the underlying model.

export const peopleRouter = Router();

export type PersonType = "students" | "assessors" | "invigilators" | "administrators";
const TYPE_ROLES: Record<PersonType, UserRole[]> = {
  students: ["learner"],
  assessors: ["assessor"],
  invigilators: ["invigilator"],
  administrators: ["administrator"],
};
const typeParam = z.enum(["students", "assessors", "invigilators", "administrators"]);
const statusParam = z.enum(["invited", "active", "suspended", "archived"]);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ---- Shaping -------------------------------------------------------------------

export type CohortRef = { id: string; name: string };

function personRow(u: typeof users.$inferSelect, roles: UserRole[], cohortRefs: CohortRef[] = []) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    roles,
    status: u.status,
    employmentRelationship: u.employmentRelationship,
    source: u.source,
    fptstaffId: u.fptstaffId,
    studentNumber: u.studentNumber,
    idNumberMasked: u.idNumberLast4 ? `••••••••• ${u.idNumberLast4}` : null,
    registrationNumber: u.registrationNumber,
    activatedAt: u.activatedAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
    cohorts: cohortRefs,
  };
}
export type PersonRow = ReturnType<typeof personRow>;

// The ID number is the unique student identifier (decision 1, 9 Sep 2026):
// 13 digits for a South African ID. Stored encrypted; matched by a keyed hash.
export const ID_NUMBER_RE = /^\d{13}$/;
export const cleanId = (v: string) => v.replace(/\s/g, "");

export async function cohortsFor(learnerIds: string[]): Promise<Map<string, CohortRef[]>> {
  const map = new Map<string, CohortRef[]>();
  if (!learnerIds.length) return map;
  const rows = await db
    .select({ learnerId: cohortMembers.learnerId, id: cohorts.id, name: cohorts.name })
    .from(cohortMembers)
    .innerJoin(cohorts, eq(cohorts.id, cohortMembers.cohortId))
    .where(inArray(cohortMembers.learnerId, learnerIds))
    .orderBy(asc(cohorts.name));
  for (const r of rows) map.set(r.learnerId, [...(map.get(r.learnerId) ?? []), { id: r.id, name: r.name }]);
  return map;
}

async function rolesFor(ids: string[]): Promise<Map<string, UserRole[]>> {
  const map = new Map<string, UserRole[]>();
  if (!ids.length) return map;
  const rows = await db.select().from(userRoles).where(inArray(userRoles.userId, ids));
  for (const r of rows) map.set(r.userId, [...(map.get(r.userId) ?? []), r.role as UserRole]);
  return map;
}

// Users having any of the given roles.
const withRole = (roles: UserRole[]) =>
  sql`${users.id} IN (SELECT ${userRoles.userId} FROM ${userRoles} WHERE ${userRoles.role} IN (${sql.join(roles.map((r) => sql`${r}`), sql`, `)}))`;

const inCohort = (cohortId: string) =>
  sql`${users.id} IN (SELECT ${cohortMembers.learnerId} FROM ${cohortMembers} WHERE ${cohortMembers.cohortId} = ${cohortId})`;

function searchClause(q: string): SQL {
  const term = `%${q.trim()}%`;
  const parts: SQL[] = [ilike(users.name, term), ilike(users.email, term), ilike(users.studentNumber, term)];
  // A run of digits (an ID number, or just its last four) also matches the ID's last four.
  const digits = q.replace(/\s/g, "");
  if (/^\d{4,13}$/.test(digits)) parts.push(eq(users.idNumberLast4, digits.slice(-4)));
  return or(...parts)!;
}

// ---- List -------------------------------------------------------------------------

const listQuery = z.object({
  type: typeParam.default("students"),
  q: z.string().trim().max(120).optional(),
  status: statusParam.optional(),
  cohortId: z.string().uuid().optional(),
  // "students not in cohort X" - used by the cohort page's add-students search.
  notInCohortId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50),
  sort: z.enum(["name", "-name", "created", "-created", "status", "studentNumber"]).default("name"),
});

peopleRouter.get("/", requireAuth, requireRole("administrator"), async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid query.", detail: parsed.error.message });
  const { type, q, status, cohortId, notInCohortId, page, pageSize, sort } = parsed.data;

  const where = and(
    withRole(TYPE_ROLES[type]),
    q ? searchClause(q) : undefined,
    status ? eq(users.status, status) : undefined,
    cohortId ? inCohort(cohortId) : undefined,
    notInCohortId ? sql`NOT ${inCohort(notInCohortId)}` : undefined
  );
  const order =
    sort === "-name" ? desc(users.name)
    : sort === "created" ? asc(users.createdAt)
    : sort === "-created" ? desc(users.createdAt)
    : sort === "status" ? asc(users.status)
    : sort === "studentNumber" ? asc(users.studentNumber)
    : asc(users.name);

  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(users).where(where);
  const rows = await db.select().from(users).where(where).orderBy(order, asc(users.id)).limit(pageSize).offset((page - 1) * pageSize);
  const roles = await rolesFor(rows.map((r) => r.id));
  const cohortRefs = type === "students" ? await cohortsFor(rows.map((r) => r.id)) : new Map<string, CohortRef[]>();

  // Status counts for the tab header (same type + search, all statuses).
  const countsWhere = and(withRole(TYPE_ROLES[type]), q ? searchClause(q) : undefined, cohortId ? inCohort(cohortId) : undefined);
  const counts = await db.select({ status: users.status, n: sql<number>`count(*)::int` }).from(users).where(countsWhere).groupBy(users.status);

  return res.json({
    rows: rows.map((u) => personRow(u, roles.get(u.id) ?? [], cohortRefs.get(u.id) ?? [])),
    total: count,
    page,
    pageSize,
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
  });
});

// Tab totals for the People page header, one query.
peopleRouter.get("/summary", requireAuth, requireRole("administrator"), async (_req, res) => {
  const rows = await db
    .select({ role: userRoles.role, status: users.status, n: sql<number>`count(*)::int` })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .groupBy(userRoles.role, users.status);
  const out: Record<string, { total: number; invited: number }> = {};
  for (const r of rows) {
    const t = (Object.keys(TYPE_ROLES) as PersonType[]).find((k) => TYPE_ROLES[k].includes(r.role as UserRole));
    if (!t) continue;
    out[t] ??= { total: 0, invited: 0 };
    out[t].total += r.n;
    if (r.status === "invited") out[t].invited += r.n;
  }
  return res.json(out);
});

// ---- Export -------------------------------------------------------------------------------

peopleRouter.get("/export.csv", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  const parsed = listQuery.safeParse({ ...req.query, page: 1, pageSize: 200 });
  if (!parsed.success) return res.status(400).json({ error: "Invalid query." });
  const { type, q, status, cohortId } = parsed.data;
  const where = and(withRole(TYPE_ROLES[type]), q ? searchClause(q) : undefined, status ? eq(users.status, status) : undefined, cohortId ? inCohort(cohortId) : undefined);
  const rows = await db.select().from(users).where(where).orderBy(asc(users.name)).limit(50000);
  const roles = await rolesFor(rows.map((r) => r.id));
  const cohortRefs = type === "students" ? await cohortsFor(rows.map((r) => r.id)) : new Map<string, CohortRef[]>();
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["name", "email", "roles", "status", "id_number_last4", "student_number", "cohorts", "registration_number", "employment", "source", "registered_on"];
  const lines = [header.join(",")];
  for (const u of rows) {
    lines.push(
      [u.name, u.email, (roles.get(u.id) ?? []).join("|"), u.status, u.idNumberLast4, u.studentNumber, (cohortRefs.get(u.id) ?? []).map((c) => c.name).join("|"), u.registrationNumber, u.employmentRelationship, u.source, u.createdAt.toISOString().slice(0, 10)]
        .map(esc)
        .join(",")
    );
  }
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "user_list_exported", targetType: "user", targetId: null, reason: `${type}${q ? ` q=${q}` : ""}${status ? ` status=${status}` : ""}: ${rows.length} rows` });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="fpt-exam-${type}${status ? "-" + status : ""}.csv"`);
  res.send(lines.join("\n") + "\n");
});

// ---- Person page --------------------------------------------------------------------

const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

peopleRouter.get("/:id", requireAuth, requireRole("administrator"), async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: "Not found." });
  const [u] = await db.select().from(users).where(eq(users.id, req.params.id));
  if (!u) return res.status(404).json({ error: "Person not found." });
  const roles = (await rolesFor([u.id])).get(u.id) ?? [];

  const [liveLink] = await db
    .select({ expiresAt: accountSetupTokens.expiresAt, createdAt: accountSetupTokens.createdAt })
    .from(accountSetupTokens)
    .where(and(eq(accountSetupTokens.userId, u.id), isNull(accountSetupTokens.usedAt), sql`${accountSetupTokens.expiresAt} > now()`))
    .orderBy(desc(accountSetupTokens.createdAt))
    .limit(1);

  // Learner history: every sitting they are in, with result if released.
  const sittings = roles.includes("learner")
    ? await db
        .select({
          sessionId: learnerSessions.id,
          sittingId: examSittings.id,
          startTime: examSittings.startTime,
          endTime: examSittings.endTime,
          qualificationTitle: qualifications.title,
          sessionStatus: learnerSessions.status,
          outcome: assessorDecisions.outcome,
          totalMark: assessorDecisions.totalMark,
          totalMax: assessorDecisions.totalMax,
          signedOffAt: assessorDecisions.signedOffAt,
        })
        .from(learnerSessions)
        .innerJoin(examSittings, eq(learnerSessions.sittingId, examSittings.id))
        .innerJoin(qualifications, eq(examSittings.qualificationId, qualifications.id))
        .leftJoin(assessorDecisions, eq(assessorDecisions.sessionId, learnerSessions.id))
        .where(eq(learnerSessions.learnerId, u.id))
        .orderBy(desc(examSittings.startTime))
        .limit(100)
    : [];

  // Assessor history: sittings assigned, scripts signed off.
  const assessing = roles.includes("assessor")
    ? await db
        .select({
          sittingId: examSittings.id,
          startTime: examSittings.startTime,
          qualificationTitle: qualifications.title,
          scripts: sql<number>`(SELECT count(*)::int FROM ${learnerSessions} ls WHERE ls.sitting_id = ${examSittings.id})`,
          signedOff: sql<number>`(SELECT count(*)::int FROM ${assessorDecisions} ad JOIN ${learnerSessions} ls ON ls.id = ad.session_id WHERE ls.sitting_id = ${examSittings.id} AND ad.signed_off_at IS NOT NULL)`,
        })
        .from(examSittings)
        .innerJoin(qualifications, eq(examSittings.qualificationId, qualifications.id))
        .where(eq(examSittings.assignedAssessorId, u.id))
        .orderBy(desc(examSittings.startTime))
        .limit(100)
    : [];

  const invigilating = roles.includes("invigilator")
    ? await db
        .select({ sittingId: examSittings.id, startTime: examSittings.startTime, endTime: examSittings.endTime, qualificationTitle: qualifications.title })
        .from(sittingInvigilators)
        .innerJoin(examSittings, eq(sittingInvigilators.sittingId, examSittings.id))
        .innerJoin(qualifications, eq(examSittings.qualificationId, qualifications.id))
        .where(eq(sittingInvigilators.invigilatorId, u.id))
        .orderBy(desc(examSittings.startTime))
        .limit(100)
    : [];

  const audit = await db
    .select({ action: auditLog.action, reason: auditLog.reason, at: auditLog.occurredAt })
    .from(auditLog)
    .where(and(eq(auditLog.targetType, "user"), eq(auditLog.targetId, u.id)))
    .orderBy(desc(auditLog.occurredAt))
    .limit(20);

  const scopeRows = roles.includes("assessor")
    ? await db.select({ id: qualifications.id, title: qualifications.title }).from(assessorScopes).innerJoin(qualifications, eq(qualifications.id, assessorScopes.qualificationId)).where(eq(assessorScopes.userId, u.id))
    : [];
  return res.json({
    ...personRow(u, roles, (await cohortsFor([u.id])).get(u.id) ?? []),
    markingCap: u.markingCap,
    scope: scopeRows,
    setup: { liveLinkExpiresAt: liveLink?.expiresAt?.toISOString() ?? null, activatedAt: u.activatedAt?.toISOString() ?? null, hasAuthenticator: Boolean(u.mfaSecret) },
    sittings,
    assessing,
    invigilating,
    audit,
  });
});

// ---- Edit ---------------------------------------------------------------------------

const patchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  email: z.string().trim().email().optional(),
  studentNumber: z.string().trim().max(40).nullable().optional(),
  idNumber: z.string().trim().max(32).nullable().optional(), // null clears
  registrationNumber: z.string().trim().max(60).nullable().optional(),
  employmentRelationship: z.enum(["internal", "external"]).nullable().optional(),
  status: statusParam.optional(),
  reason: z.string().trim().max(500).optional(),
  // Assessors: scripts in flight allowed (null = default 60) and the
  // qualifications they are registered to assess.
  markingCap: z.number().int().min(1).max(1000).nullable().optional(),
  scopeQualificationIds: z.array(z.string().uuid()).max(200).optional(),
});

peopleRouter.patch("/:id", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });
  const [u] = await db.select().from(users).where(eq(users.id, req.params.id));
  if (!u) return res.status(404).json({ error: "Person not found." });
  const p = parsed.data;
  if (p.status && (p.status === "suspended" || p.status === "archived") && u.id === req.auth!.userId) {
    return res.status(400).json({ error: "You cannot suspend or archive your own account." });
  }
  if (p.email && p.email !== u.email) {
    const [dupe] = await db.select({ id: users.id }).from(users).where(eq(users.email, p.email));
    if (dupe) return res.status(409).json({ error: "Another person already has that email." });
  }
  if (p.studentNumber && p.studentNumber !== u.studentNumber) {
    const [dupe] = await db.select({ id: users.id }).from(users).where(eq(users.studentNumber, p.studentNumber));
    if (dupe) return res.status(409).json({ error: "Another person already has that student number." });
  }
  if (p.idNumber) {
    const idn = cleanId(p.idNumber);
    if (!ID_NUMBER_RE.test(idn)) return res.status(400).json({ error: "The ID number must be 13 digits." });
    const h = hashIdentifier(idn);
    if (h !== u.idNumberHash) {
      const [dupe] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.idNumberHash, h));
      if (dupe) return res.status(409).json({ error: `That ID number is already registered to ${dupe.name}.` });
    }
  }
  if (p.scopeQualificationIds !== undefined) {
    await db.delete(assessorScopes).where(eq(assessorScopes.userId, u.id));
    if (p.scopeQualificationIds.length) await db.insert(assessorScopes).values(p.scopeQualificationIds.map((qualificationId) => ({ userId: u.id, qualificationId }))).onConflictDoNothing();
    await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "assessor_scope_set", targetType: "user", targetId: u.id, reason: `${p.scopeQualificationIds.length} qualification(s)` });
  }
  const set: Partial<typeof users.$inferInsert> = {};
  if (p.markingCap !== undefined) set.markingCap = p.markingCap;
  if (p.name !== undefined) set.name = p.name;
  if (p.email !== undefined) set.email = p.email;
  if (p.studentNumber !== undefined) set.studentNumber = p.studentNumber || null;
  if (p.registrationNumber !== undefined) set.registrationNumber = p.registrationNumber || null;
  if (p.employmentRelationship !== undefined) set.employmentRelationship = p.employmentRelationship;
  if (p.idNumber !== undefined) {
    const idn = p.idNumber ? cleanId(p.idNumber) : "";
    set.idNumberEnc = idn ? encryptField(idn) : null;
    set.idNumberLast4 = idn ? last4(idn) : null;
    set.idNumberHash = idn ? hashIdentifier(idn) : null;
  }
  if (p.status !== undefined) set.status = p.status;
  const [updated] = Object.keys(set).length ? await db.update(users).set(set).where(eq(users.id, u.id)).returning() : [u];
  forgetAccountStatus(u.id);
  await db.insert(auditLog).values({
    actorId: req.auth!.userId,
    action: p.status && p.status !== u.status ? `user_status_${p.status}` : "user_edited",
    targetType: "user",
    targetId: u.id,
    reason: p.reason ?? Object.keys(set).filter((k) => k !== "idNumberEnc").join(", "),
  });
  const roles = (await rolesFor([u.id])).get(u.id) ?? [];
  return res.json(personRow(updated, roles));
});

// The ID number in full - only on explicit request, audited. (The Statement of
// Results is the intended consumer; the screen shows it masked.)
peopleRouter.get("/:id/id-number", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  const [u] = await db.select().from(users).where(eq(users.id, req.params.id));
  if (!u) return res.status(404).json({ error: "Person not found." });
  if (!u.idNumberEnc) return res.json({ idNumber: null });
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "user_id_number_viewed", targetType: "user", targetId: u.id });
  return res.json({ idNumber: decryptField(u.idNumberEnc) });
});

// ---- Chase set-up links ---------------------------------------------------------------

peopleRouter.post("/chase-setup-links", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  const type = typeParam.safeParse(req.query.type);
  const where = and(eq(users.status, "invited"), type.success ? withRole(TYPE_ROLES[type.data]) : undefined);
  const invited = await db.select().from(users).where(where).limit(500);
  const roles = await rolesFor(invited.map((u) => u.id));
  let emailed = 0;
  const links: { id: string; name: string; email: string; setupUrl: string }[] = [];
  for (const u of invited) {
    const setup = await issueSetupLink({ userId: u.id, name: u.name, email: u.email, roles: roles.get(u.id) ?? [], createdBy: req.auth!.userId, baseUrl: appBaseUrl(req) });
    if (setup.emailSent) emailed++;
    else links.push({ id: u.id, name: u.name, email: u.email, setupUrl: setup.setupUrl });
  }
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "user_setup_links_chased", targetType: "user", targetId: null, reason: `${invited.length} invited people; ${emailed} emailed` });
  return res.json({ total: invited.length, emailed, links });
});

// ---- Import -----------------------------------------------------------------------------

const TEMPLATE_COLUMNS = ["name", "email", "type", "id_number", "student_number", "registration_number", "employment"] as const;

peopleRouter.get("/import/template.csv", requireAuth, requireRole("administrator"), (_req, res) => {
  const lines = [
    TEMPLATE_COLUMNS.join(","),
    "Thandi Mokoena,thandi@example.com,student,,9001015800089,,",
    "Sipho Dlamini,sipho@example.com,assessor,,,ASR-4471,internal",
    "Naledi Khumalo,naledi@example.com,invigilator,,,,external",
  ];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="fpt-exam-people-template.csv"');
  res.send(lines.join("\n") + "\n");
});

interface ImportRow {
  line: number;
  name: string;
  email: string;
  type: PersonType | null;
  studentNumber: string | null;
  idNumber: string | null;
  registrationNumber: string | null;
  employment: "internal" | "external" | null;
}
type ImportAction = "create" | "update" | "skip" | "reject";
interface ImportPreviewRow extends ImportRow {
  action: ImportAction;
  reasons: string[];
  existingId?: string;
}

const norm = (v: unknown) => String(v ?? "").trim();
const typeWord = (v: string): PersonType | null => {
  const t = v.toLowerCase();
  if (/^(student|learner)s?$/.test(t)) return "students";
  if (/^(assessor|moderator)s?$/.test(t)) return "assessors";
  if (/^invigilators?$/.test(t)) return "invigilators";
  if (/^(admin|administrator)s?$/.test(t)) return "administrators";
  return null;
};

function parseSheet(buffer: Buffer, filename: string): ImportRow[] {
  const wb = XLSX.read(buffer, { type: "buffer", raw: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error(`No sheet found in ${filename}.`);
  const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  const key = (rec: Record<string, unknown>, ...names: string[]) => {
    for (const k of Object.keys(rec)) {
      const nk = k.toLowerCase().replace(/[\s_-]+/g, "");
      if (names.some((n) => nk === n.replace(/[\s_-]+/g, ""))) return norm(rec[k]);
    }
    return "";
  };
  return records.map((rec, i) => ({
    line: i + 2,
    name: key(rec, "name", "full name", "fullname", "learner name"),
    email: key(rec, "email", "email address"),
    type: typeWord(key(rec, "type", "role", "person type")) ,
    studentNumber: key(rec, "student_number", "student number", "studentno", "student no") || null,
    idNumber: key(rec, "id_number", "id number", "idno", "identity number").replace(/\s/g, "") || null,
    registrationNumber: key(rec, "registration_number", "registration number", "reg no", "assessor number") || null,
    employment: ((): "internal" | "external" | null => {
      const e = key(rec, "employment", "employment relationship").toLowerCase();
      return e.startsWith("int") ? "internal" : e.startsWith("ext") ? "external" : null;
    })(),
  }));
}

async function previewRows(rows: ImportRow[], defaultType: PersonType | null): Promise<ImportPreviewRow[]> {
  const emails = rows.map((r) => r.email.toLowerCase()).filter(Boolean);
  const studentNumbers = rows.map((r) => r.studentNumber).filter((x): x is string => Boolean(x));
  const idHashes = rows.map((r) => (r.idNumber && ID_NUMBER_RE.test(r.idNumber) ? hashIdentifier(r.idNumber) : null)).filter((x): x is string => Boolean(x));
  const existingByEmail = new Map<string, typeof users.$inferSelect>();
  const existingByStudentNo = new Map<string, typeof users.$inferSelect>();
  const existingByIdHash = new Map<string, typeof users.$inferSelect>();
  if (idHashes.length) {
    const found = await db.select().from(users).where(inArray(users.idNumberHash, idHashes));
    for (const u of found) if (u.idNumberHash) existingByIdHash.set(u.idNumberHash, u);
  }
  if (emails.length) {
    const found = await db.select().from(users).where(sql`lower(${users.email}) IN (${sql.join(emails.map((e) => sql`${e}`), sql`, `)})`);
    for (const u of found) existingByEmail.set(u.email.toLowerCase(), u);
  }
  if (studentNumbers.length) {
    const found = await db.select().from(users).where(inArray(users.studentNumber, studentNumbers));
    for (const u of found) if (u.studentNumber) existingByStudentNo.set(u.studentNumber, u);
  }
  const seenEmail = new Set<string>();
  const seenStudentNo = new Set<string>();
  const seenId = new Set<string>();
  return rows.map((r) => {
    const reasons: string[] = [];
    const type = r.type ?? defaultType;
    if (!r.name) reasons.push("name missing");
    if (!r.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) reasons.push("email missing or invalid");
    if (!type) reasons.push("type missing (student / assessor / invigilator / administrator)");
    const emailKey = r.email.toLowerCase();
    const idHash = r.idNumber && ID_NUMBER_RE.test(r.idNumber) ? hashIdentifier(r.idNumber) : null;
    const byId = idHash ? existingByIdHash.get(idHash) : undefined;
    const existing = existingByEmail.get(emailKey) ?? byId;
    if (r.idNumber && !ID_NUMBER_RE.test(r.idNumber)) reasons.push("ID number must be 13 digits");
    else if (type === "students" && !r.idNumber && !existing) reasons.push("ID number missing (it is the student identifier)");
    if (emailKey && seenEmail.has(emailKey)) reasons.push("duplicate email within the file");
    if (idHash && seenId.has(idHash)) reasons.push("duplicate ID number within the file");
    if (r.studentNumber && seenStudentNo.has(r.studentNumber)) reasons.push("duplicate student number within the file");
    seenEmail.add(emailKey);
    if (idHash) seenId.add(idHash);
    if (r.studentNumber) seenStudentNo.add(r.studentNumber);
    if (reasons.length) return { ...r, type, action: "reject", reasons };

    if (existing) {
      if (byId && byId.id !== existing.id) return { ...r, type, action: "reject", reasons: [`ID number belongs to another person (${byId.name})`], existingId: existing.id };
      const byNo = r.studentNumber ? existingByStudentNo.get(r.studentNumber) : undefined;
      if (byNo && byNo.id !== existing.id) return { ...r, type, action: "reject", reasons: ["student number belongs to another person"], existingId: existing.id };
      const changes: string[] = [];
      if (existing.email.toLowerCase() !== emailKey) changes.push("email");
      if (r.name && r.name !== existing.name) changes.push("name");
      if (r.studentNumber && r.studentNumber !== existing.studentNumber) changes.push("student number");
      if (idHash && idHash !== existing.idNumberHash) changes.push("ID number");
      if (r.registrationNumber && r.registrationNumber !== existing.registrationNumber) changes.push("registration number");
      if (r.employment && r.employment !== existing.employmentRelationship) changes.push("employment");
      return changes.length
        ? { ...r, type, action: "update", reasons: [`updates ${changes.join(", ")}`], existingId: existing.id }
        : { ...r, type, action: "skip", reasons: ["already registered, nothing to change"], existingId: existing.id };
    }
    if (r.studentNumber && existingByStudentNo.has(r.studentNumber)) {
      return { ...r, type, action: "reject", reasons: ["student number already belongs to another person (different email)"] };
    }
    return { ...r, type, action: "create", reasons: [] };
  });
}

peopleRouter.post("/import/preview", requireAuth, requireRole("administrator"), upload.single("file"), async (req: AuthedRequest, res) => {
  if (!req.file) return res.status(400).json({ error: "Upload a CSV or Excel file (form field 'file')." });
  const defaultType = typeParam.safeParse(req.body?.type);
  let rows: ImportRow[];
  try {
    rows = parseSheet(req.file.buffer, req.file.originalname);
  } catch (err) {
    return res.status(400).json({ error: "Could not read the file.", detail: err instanceof Error ? err.message : String(err) });
  }
  if (rows.length === 0) return res.status(400).json({ error: "The file has no rows under its header." });
  if (rows.length > 5000) return res.status(400).json({ error: "Import at most 5 000 rows at a time." });
  const preview = await previewRows(rows, defaultType.success ? defaultType.data : null);
  const summary = { create: 0, update: 0, skip: 0, reject: 0 };
  for (const r of preview) summary[r.action]++;
  return res.json({ filename: req.file.originalname, rows: preview, summary });
});

const commitSchema = z.object({
  rows: z
    .array(
      z.object({
        line: z.number(),
        name: z.string().trim().min(1),
        email: z.string().trim().email(),
        type: typeParam,
        studentNumber: z.string().trim().nullable(),
        idNumber: z.string().trim().nullable(),
        registrationNumber: z.string().trim().nullable(),
        employment: z.enum(["internal", "external"]).nullable(),
        action: z.enum(["create", "update"]),
        existingId: z.string().uuid().optional(),
      })
    )
    .min(1)
    .max(5000),
  sendSetupLinks: z.boolean().default(true),
  // Block 2: put every created / updated student into this cohort.
  cohortId: z.string().uuid().optional(),
});

peopleRouter.post("/import/commit", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  const parsed = commitSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid import rows.", detail: parsed.error.message });
  // Re-validate against the database - the preview may be minutes old.
  const again = await previewRows(parsed.data.rows.map((r) => ({ ...r, type: r.type })), null);
  let cohort: typeof cohorts.$inferSelect | undefined;
  if (parsed.data.cohortId) {
    [cohort] = await db.select().from(cohorts).where(eq(cohorts.id, parsed.data.cohortId));
    if (!cohort) return res.status(404).json({ error: "Cohort not found." });
  }
  const created: string[] = [];
  const studentIds: string[] = [];
  const updated: string[] = [];
  const rejected: { line: number; email: string; reasons: string[] }[] = [];
  let emailed = 0;
  const links: { name: string; email: string; setupUrl: string }[] = [];
  const baseUrl = appBaseUrl(req);
  // Invited people cannot sign in until they set their own password, so the
  // placeholder only has to be unguessable - one random hash for the whole
  // batch rather than a slow bcrypt per row.
  const invitedHash = await hashPassword(randomBytes(32).toString("base64url"));

  for (const r of again) {
    if (r.action === "reject") {
      rejected.push({ line: r.line, email: r.email, reasons: r.reasons });
      continue;
    }
    if (r.action === "skip") continue;
    const roles = TYPE_ROLES[r.type!];
    if (r.action === "create") {
      const supervisory = r.type !== "students";
      const [u] = await db
        .insert(users)
        .values({
          name: r.name,
          email: r.email,
          passwordHash: invitedHash,
          mfaSecret: supervisory ? generateMfaSecret() : null,
          employmentRelationship: r.employment,
          source: "manual",
          studentNumber: r.studentNumber,
          idNumberEnc: r.idNumber ? encryptField(r.idNumber) : null,
          idNumberLast4: r.idNumber ? last4(r.idNumber) : null,
          idNumberHash: r.idNumber ? hashIdentifier(r.idNumber) : null,
          registrationNumber: r.registrationNumber,
          status: "invited",
        })
        .returning();
      await db.insert(userRoles).values(roles.map((role) => ({ userId: u.id, role })));
      if (r.type === "students") studentIds.push(u.id);
      await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "user_created", targetType: "user", targetId: u.id, reason: "bulk import" });
      created.push(u.id);
      if (parsed.data.sendSetupLinks) {
        const setup = await issueSetupLink({ userId: u.id, name: u.name, email: u.email, roles, createdBy: req.auth!.userId, baseUrl });
        if (setup.emailSent) emailed++;
        else links.push({ name: u.name, email: u.email, setupUrl: setup.setupUrl });
      }
    } else if (r.existingId) {
      const set: Partial<typeof users.$inferInsert> = { name: r.name, email: r.email };
      if (r.studentNumber) set.studentNumber = r.studentNumber;
      if (r.idNumber) {
        set.idNumberEnc = encryptField(r.idNumber);
        set.idNumberLast4 = last4(r.idNumber);
        set.idNumberHash = hashIdentifier(r.idNumber);
      }
      if (r.type === "students") studentIds.push(r.existingId);
      if (r.registrationNumber) set.registrationNumber = r.registrationNumber;
      if (r.employment) set.employmentRelationship = r.employment;
      await db.update(users).set(set).where(eq(users.id, r.existingId));
      await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "user_edited", targetType: "user", targetId: r.existingId, reason: "bulk import: " + r.reasons.join("; ") });
      updated.push(r.existingId);
    }
  }
  let addedToCohort = 0;
  if (cohort && studentIds.length) {
    const ins = await db
      .insert(cohortMembers)
      .values(studentIds.map((learnerId) => ({ cohortId: cohort!.id, learnerId, addedBy: req.auth!.userId })))
      .onConflictDoNothing()
      .returning({ learnerId: cohortMembers.learnerId });
    addedToCohort = ins.length;
    await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "cohort_members_added", targetType: "cohort", targetId: cohort.id, reason: `${addedToCohort} from import` });
  }
  await db.insert(auditLog).values({
    actorId: req.auth!.userId,
    action: "user_bulk_import",
    targetType: "user",
    targetId: null,
    reason: `${created.length} created, ${updated.length} updated, ${rejected.length} rejected`,
  });
  return res.json({ created: created.length, updated: updated.length, rejected, emailed, links, addedToCohort, cohortName: cohort?.name ?? null });
});

