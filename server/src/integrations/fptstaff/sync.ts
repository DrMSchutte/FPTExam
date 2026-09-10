import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { users, userRoles, cohorts, qualifications, learnerSessions, examSittings, assessmentInstruments, assessorDecisions, fptstaffResultPushes, backgroundJobs, auditLog } from "../../db/schema.js";
import { decryptField } from "../../auth/crypto.js";
import { isFptstaffConfigured, listLearners, listSections, listStaff, pushLearner, pushResult, FptstaffError, type FptstaffSection } from "./client.js";
import { applyImportRows } from "../../routes/people.js";
import { loadStatement, renderStatement } from "../../results/statement.js";
import { integrityReportFor } from "../../proctoring/integrity.js";

// Block 6: the three movements between FPT Exam and FPTStaff.
//   pullSection   FPTStaff section -> FPT Exam cohort (learners created / updated / matched by ID number)
//   pullStaff     FPTStaff assessors and invigilators -> FPT Exam people
//   push          people added on FPT Exam -> FPTStaff (job fptstaff_learner_push)
//                 signed-off results + Statement -> FPTStaff (job fptstaff_push)

export interface PullSummary {
  section: FptstaffSection;
  cohortId: string;
  cohortName: string;
  cohortCreated: boolean;
  pulled: number;
  created: number;
  updated: number;
  unchanged: number;
  addedToCohort: number;
  rejected: { email: string; reasons: string[] }[];
  emailed: number;
  links: { name: string; email: string; setupUrl: string }[];
}

// One FPTStaff section becomes (or refreshes) one cohort here, named after it.
export async function pullSection(sectionId: string, actorId: string, baseUrl: string, sendSetupLinks: boolean): Promise<PullSummary> {
  const sections = await listSections();
  const section = sections.find((s) => s.id === sectionId);
  if (!section) throw new FptstaffError(`FPTStaff has no section ${sectionId}.`);
  const learners = await listLearners(section.id);

  // Cohort: the one already mirroring this section, else create it (with the qualification when known).
  let [cohort] = await db.select().from(cohorts).where(eq(cohorts.fptstaffSectionId, section.id));
  let cohortCreated = false;
  if (!cohort) {
    let qualificationId: string | null = null;
    if (section.saqaQualificationId) {
      const [q] = await db.select({ id: qualifications.id }).from(qualifications).where(eq(qualifications.saqaQualificationId, section.saqaQualificationId));
      qualificationId = q?.id ?? null;
    }
    if (!qualificationId && section.qualificationTitle) {
      const [q] = await db.select({ id: qualifications.id }).from(qualifications).where(eq(qualifications.title, section.qualificationTitle));
      qualificationId = q?.id ?? null;
    }
    [cohort] = await db.insert(cohorts).values({ name: section.name, qualificationId, site: section.site ?? null, intake: section.intake ?? null, fptstaffSectionId: section.id, externalRef: section.id, createdBy: actorId, notes: `Pulled from FPTStaff section ${section.id}` }).returning();
    cohortCreated = true;
    await db.insert(auditLog).values({ actorId, action: "cohort_created", targetType: "cohort", targetId: cohort.id, reason: `FPTStaff section ${section.id}` });
  }

  const active = learners.filter((l) => l.status !== "inactive");
  const rows = active.map((l, i) => ({ line: i + 1, name: l.name, email: l.email, type: "students" as const, studentNumber: l.studentNumber ?? null, idNumber: l.idNumber, registrationNumber: null, employment: null, action: "create" as const }));
  const fptstaffIds = new Map(active.map((l) => [l.email.toLowerCase(), l.fptstaffId]));
  const r = await applyImportRows({ rows, cohortId: cohort.id, sendSetupLinks, actorId, baseUrl, source: "fptstaff", fptstaffIds, reason: `FPTStaff section ${section.id}` });
  await db.update(cohorts).set({ updatedAt: new Date() }).where(eq(cohorts.id, cohort.id));
  return { section, cohortId: cohort.id, cohortName: cohort.name, cohortCreated, pulled: learners.length, created: r.created, updated: r.updated, unchanged: r.unchanged, addedToCohort: r.addedToCohort, rejected: r.rejected.map((x) => ({ email: x.email, reasons: x.reasons })), emailed: r.emailed, links: r.links };
}

export async function pullStaff(actorId: string, baseUrl: string, sendSetupLinks: boolean) {
  const staff = (await listStaff()).filter((s) => s.status !== "inactive");
  // One row per person per role type (the import model is one type per row);
  // a person with both roles gets the second role added afterwards.
  const primary = staff.map((s, i) => ({ line: i + 1, name: s.name, email: s.email, type: (s.roles.includes("assessor") ? "assessors" : "invigilators") as "assessors" | "invigilators", studentNumber: null, idNumber: null, registrationNumber: s.registrationNumber ?? null, employment: s.employmentRelationship ?? null, action: "create" as const }));
  const fptstaffIds = new Map(staff.map((s) => [s.email.toLowerCase(), s.fptstaffId]));
  const r = await applyImportRows({ rows: primary, sendSetupLinks, actorId, baseUrl, source: "fptstaff", fptstaffIds, reason: "FPTStaff staff pull" });
  // Second roles
  let rolesAdded = 0;
  const both = staff.filter((s) => s.roles.includes("assessor") && s.roles.includes("invigilator"));
  if (both.length) {
    const found = await db.select({ id: users.id, email: users.email }).from(users).where(inArray(sql`lower(${users.email})`, both.map((s) => s.email.toLowerCase())));
    for (const u of found) {
      const ins = await db.insert(userRoles).values({ userId: u.id, role: "invigilator" }).onConflictDoNothing().returning();
      rolesAdded += ins.length;
    }
  }
  return { pulled: staff.length, created: r.created, updated: r.updated, unchanged: r.unchanged, rejected: r.rejected.map((x) => ({ email: x.email, reasons: x.reasons })), emailed: r.emailed, links: r.links, rolesAdded };
}

// ---- Push: people added here ------------------------------------------------------------------

export async function queueLearnerPushes(userIds: string[]) {
  if (!isFptstaffConfigured() || !userIds.length) return 0;
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .where(and(inArray(users.id, userIds), eq(userRoles.role, "learner"), sql`${users.fptstaffId} IS NULL`));
  if (!rows.length) return 0;
  await db.insert(backgroundJobs).values(rows.map((r) => ({ jobType: "fptstaff_learner_push", payload: { userId: r.id }, status: "pending" as const })));
  return rows.length;
}

export async function runLearnerPush(payload: { userId: string }) {
  if (!isFptstaffConfigured()) return { deferred: true, reason: "FPTStaff is not connected." };
  const [u] = await db.select().from(users).where(eq(users.id, payload.userId));
  if (!u) return { skipped: true, reason: "User not found." };
  if (u.fptstaffId) return { skipped: true, reason: "Already on FPTStaff.", fptstaffId: u.fptstaffId };
  let idNumber: string | null = null;
  if (u.idNumberEnc) { try { idNumber = decryptField(u.idNumberEnc); } catch { idNumber = null; } }
  const r = await pushLearner({ examRef: u.id, name: u.name, email: u.email, idNumber, studentNumber: u.studentNumber });
  await db.update(users).set({ fptstaffId: r.fptstaffId, fptstaffSyncedAt: new Date() }).where(eq(users.id, u.id));
  await db.insert(auditLog).values({ actorId: null, action: "fptstaff_learner_pushed", targetType: "user", targetId: u.id, reason: `${r.outcome} ${r.fptstaffId}` });
  return { fptstaffId: r.fptstaffId, outcome: r.outcome };
}

// How many learners here have no FPTStaff id yet (shown on the panel).
export const unpushedLearnerCount = async () =>
  (await db.select({ n: sql<number>`count(*)::int` }).from(users).innerJoin(userRoles, eq(userRoles.userId, users.id)).where(and(eq(userRoles.role, "learner"), sql`${users.fptstaffId} IS NULL`)))[0].n;

export async function queueAllUnpushedLearners() {
  const rows = await db.select({ id: users.id }).from(users).innerJoin(userRoles, eq(userRoles.userId, users.id)).where(and(eq(userRoles.role, "learner"), sql`${users.fptstaffId} IS NULL`)).limit(5000);
  return queueLearnerPushes(rows.map((r) => r.id));
}

// ---- Push: signed-off results --------------------------------------------------------------------

export async function runResultPush(payload: { pushId: string }) {
  const [push] = await db.select().from(fptstaffResultPushes).where(eq(fptstaffResultPushes.id, payload.pushId));
  if (!push) return { skipped: true, reason: "Push row not found." };
  if (push.status === "sent") return { skipped: true, reason: "Already sent." };
  if (!isFptstaffConfigured()) return { deferred: true, reason: "FPTStaff is not connected; the result stays queued and is sent with Push now once it is." };

  const [row] = await db
    .select({ session: learnerSessions, sitting: examSittings, instrument: assessmentInstruments, decision: assessorDecisions, learner: users })
    .from(learnerSessions)
    .innerJoin(examSittings, eq(examSittings.id, learnerSessions.sittingId))
    .innerJoin(assessmentInstruments, eq(assessmentInstruments.id, examSittings.instrumentId))
    .innerJoin(assessorDecisions, eq(assessorDecisions.sessionId, learnerSessions.id))
    .innerJoin(users, eq(users.id, learnerSessions.learnerId))
    .where(eq(learnerSessions.id, push.sessionId));
  if (!row || !row.decision.signedOffAt) throw new Error("Result is not signed off.");
  const [qualification] = await db.select().from(qualifications).where(eq(qualifications.id, row.sitting.qualificationId));
  const [assessor] = await db.select({ name: users.name, fptstaffId: users.fptstaffId }).from(users).where(eq(users.id, row.decision.assessorId));
  const statement = await loadStatement(row.session.id);
  if (!statement) throw new Error("Statement could not be built.");
  const pdf = await renderStatement(statement);
  const integrity = await integrityReportFor(row.session.id);
  let idNumber: string | null = null;
  if (row.learner.idNumberEnc) { try { idNumber = decryptField(row.learner.idNumberEnc); } catch { idNumber = null; } }

  await db.update(fptstaffResultPushes).set({ attempts: push.attempts + 1 }).where(eq(fptstaffResultPushes.id, push.id));
  try {
    const ack = await pushResult({
      examRef: row.session.id,
      learner: { fptstaffId: row.learner.fptstaffId, name: row.learner.name, email: row.learner.email, idNumber, studentNumber: row.learner.studentNumber },
      qualification: { title: qualification.title, type: qualification.qctoRegistrationType, saqaQualificationId: qualification.saqaQualificationId },
      paper: { version: row.instrument.version, source: row.instrument.source, externalRef: row.instrument.externalRef },
      sitting: { id: row.sitting.id, startTime: row.sitting.startTime.toISOString(), venue: row.sitting.venue },
      result: { outcome: row.decision.outcome ?? "not_yet_competent", totalMark: row.decision.totalMark ?? 0, totalMax: row.decision.totalMax ?? 0, percentage: statement.result.percentage, signedOffAt: row.decision.signedOffAt.toISOString(), assessor: { name: assessor?.name ?? "", fptstaffId: assessor?.fptstaffId ?? null } },
      integrity: integrity ? { recommendation: integrity.recommendation, headline: integrity.headline } : null,
      statement: { number: statement.statementNumber, filename: `Statement-of-Results-${statement.statementNumber}.pdf`, pdfBase64: pdf.toString("base64") },
    });
    await db.update(fptstaffResultPushes).set({ status: "sent", sentAt: new Date(), fptstaffAck: ack }).where(eq(fptstaffResultPushes.id, push.id));
    await db.insert(auditLog).values({ actorId: null, action: "fptstaff_result_pushed", targetType: "learner_session", targetId: row.session.id, reason: `${ack.fptstaffResultId}${ack.duplicate ? " (already there)" : ""}` });
    return { sent: true, fptstaffResultId: ack.fptstaffResultId };
  } catch (err) {
    await db.update(fptstaffResultPushes).set({ status: "failed", fptstaffAck: { error: err instanceof Error ? err.message : String(err), at: new Date().toISOString() } }).where(eq(fptstaffResultPushes.id, push.id));
    throw err;
  }
}

// Queue (again) every result not yet delivered - after connecting, or after a failure.
export async function queuePendingResultPushes(sessionIds?: string[]) {
  const rows = await db
    .select({ id: fptstaffResultPushes.id, sessionId: fptstaffResultPushes.sessionId })
    .from(fptstaffResultPushes)
    .where(and(sql`${fptstaffResultPushes.status} <> 'sent'`, sessionIds?.length ? inArray(fptstaffResultPushes.sessionId, sessionIds) : undefined));
  if (!rows.length) return 0;
  await db.update(fptstaffResultPushes).set({ status: "pending" }).where(inArray(fptstaffResultPushes.id, rows.map((r) => r.id)));
  await db.insert(backgroundJobs).values(rows.map((r) => ({ jobType: "fptstaff_push", payload: { pushId: r.id }, status: "pending" as const })));
  return rows.length;
}
