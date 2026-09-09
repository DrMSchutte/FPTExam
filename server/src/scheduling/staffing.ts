import { and, eq, inArray, isNull, lt, gt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, userRoles, examSittings, sittingInvigilators, learnerSessions, assessorDecisions, assessorScopes, cohortMembers } from "../db/schema.js";

// Scheduling rules (build plan Block 3, decisions of 9 Sep 2026):
//   - one invigilator for every 30 learners in a sitting (INVIGILATOR_RATIO);
//   - an assessor may have at most 60 scripts in flight (their own cap if set);
//   - an assessor is allocated only within their registered scope, once a scope
//     has been recorded for them;
//   - an invigilator cannot be in two sittings at the same time;
//   - the assessor of record is never one of the sitting's invigilators;
//   - a learner is never on two sittings that overlap.

export const INVIGILATOR_RATIO = 30;
export const DEFAULT_MARKING_CAP = 60;
export const invigilatorsNeeded = (learners: number) => Math.max(1, Math.ceil(learners / INVIGILATOR_RATIO));

export interface Window { start: Date; end: Date }
const overlaps = (a: Window, b: Window) => a.start < b.end && b.start < a.end;

// Scripts an assessor still has to mark or will have to mark: every learner
// session on a sitting assigned to them whose decision is not signed off.
export async function assessorLoads(assessorIds: string[]): Promise<Map<string, { inFlight: number; waiting: number; cap: number }>> {
  const out = new Map<string, { inFlight: number; waiting: number; cap: number }>();
  if (!assessorIds.length) return out;
  const caps = await db.select({ id: users.id, cap: users.markingCap }).from(users).where(inArray(users.id, assessorIds));
  for (const c of caps) out.set(c.id, { inFlight: 0, waiting: 0, cap: c.cap ?? DEFAULT_MARKING_CAP });
  const rows = await db
    .select({
      assessorId: examSittings.assignedAssessorId,
      inFlight: sql<number>`count(*)::int`,
      waiting: sql<number>`count(*) FILTER (WHERE ${learnerSessions.status} IN ('submitted','sealed'))::int`,
    })
    .from(learnerSessions)
    .innerJoin(examSittings, eq(examSittings.id, learnerSessions.sittingId))
    .leftJoin(assessorDecisions, eq(assessorDecisions.sessionId, learnerSessions.id))
    .where(and(inArray(examSittings.assignedAssessorId, assessorIds), isNull(assessorDecisions.signedOffAt)))
    .groupBy(examSittings.assignedAssessorId);
  for (const r of rows) {
    const cur = out.get(r.assessorId) ?? { inFlight: 0, waiting: 0, cap: DEFAULT_MARKING_CAP };
    out.set(r.assessorId, { ...cur, inFlight: r.inFlight, waiting: r.waiting });
  }
  return out;
}

// Registered scope per assessor. Missing key = no scope recorded.
export async function assessorScopeMap(assessorIds: string[]): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  if (!assessorIds.length) return map;
  const rows = await db.select().from(assessorScopes).where(inArray(assessorScopes.userId, assessorIds));
  for (const r of rows) map.set(r.userId, new Set([...(map.get(r.userId) ?? []), r.qualificationId]));
  return map;
}

// Sittings each invigilator is already on that overlap a window. Optionally
// ignore one sitting (when editing it).
export async function invigilatorClashes(invigilatorIds: string[], win: Window, ignoreSittingId?: string) {
  const out = new Map<string, { sittingId: string; name: string | null; startTime: Date; endTime: Date }[]>();
  if (!invigilatorIds.length) return out;
  const rows = await db
    .select({ invigilatorId: sittingInvigilators.invigilatorId, sittingId: examSittings.id, name: examSittings.name, startTime: examSittings.startTime, endTime: examSittings.endTime })
    .from(sittingInvigilators)
    .innerJoin(examSittings, eq(examSittings.id, sittingInvigilators.sittingId))
    .where(and(inArray(sittingInvigilators.invigilatorId, invigilatorIds), lt(examSittings.startTime, win.end), gt(examSittings.endTime, win.start)));
  for (const r of rows) {
    if (ignoreSittingId && r.sittingId === ignoreSittingId) continue;
    out.set(r.invigilatorId, [...(out.get(r.invigilatorId) ?? []), r]);
  }
  return out;
}

// Learners already on a sitting overlapping the window.
export async function learnerClashes(learnerIds: string[], win: Window): Promise<Set<string>> {
  if (!learnerIds.length) return new Set();
  const rows = await db
    .select({ learnerId: learnerSessions.learnerId })
    .from(learnerSessions)
    .innerJoin(examSittings, eq(examSittings.id, learnerSessions.sittingId))
    .where(and(inArray(learnerSessions.learnerId, learnerIds), lt(examSittings.startTime, win.end), gt(examSittings.endTime, win.start)));
  return new Set(rows.map((r) => r.learnerId));
}

// Eligible members of one or more cohorts, deduplicated, in a stable order.
export async function cohortLearners(cohortIds: string[]): Promise<{ ids: string[]; skippedInactive: number }> {
  if (!cohortIds.length) return { ids: [], skippedInactive: 0 };
  const rows = await db
    .select({ id: users.id, status: users.status, name: users.name })
    .from(cohortMembers)
    .innerJoin(users, eq(users.id, cohortMembers.learnerId))
    .where(inArray(cohortMembers.cohortId, cohortIds))
    .orderBy(users.name, users.id);
  const seen = new Set<string>();
  const ids: string[] = [];
  let skippedInactive = 0;
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (r.status === "active" || r.status === "invited") ids.push(r.id);
    else skippedInactive++;
  }
  return { ids, skippedInactive };
}

export async function rolesOf(userIds: string[]) {
  const map = new Map<string, string[]>();
  if (!userIds.length) return map;
  const rows = await db.select().from(userRoles).where(inArray(userRoles.userId, userIds));
  for (const r of rows) map.set(r.userId, [...(map.get(r.userId) ?? []), r.role]);
  return map;
}

export interface StaffingProblem { code: string; message: string; blocking: boolean }

// The checks shared by a single sitting and a series slot. `learners` is the
// number that will be on the sitting; `assessorExtra` the scripts this
// allocation adds to the assessor over and above what is already counted.
export async function checkStaffing(opts: {
  qualificationId: string;
  assessorId: string;
  invigilatorIds: string[];
  independent: boolean;
  learners: number;
  windows: Window[];
  assessorAddedScripts: number;
  ignoreSittingId?: string;
}): Promise<StaffingProblem[]> {
  const problems: StaffingProblem[] = [];
  const { assessorId, invigilatorIds } = opts;
  if (invigilatorIds.includes(assessorId)) {
    problems.push({ code: "assessor_is_invigilator", blocking: true, message: "The assessor of record cannot also invigilate this sitting." });
  }
  const people = [...new Set([assessorId, ...invigilatorIds])];
  const roles = await rolesOf(people);
  const rows = await db.select({ id: users.id, name: users.name, status: users.status, employment: users.employmentRelationship }).from(users).where(inArray(users.id, people));
  const byId = new Map(rows.map((r) => [r.id, r]));

  if (!(roles.get(assessorId) ?? []).includes("assessor")) problems.push({ code: "assessor_role", blocking: true, message: "The chosen assessor does not hold the Assessor role." });
  for (const id of invigilatorIds) {
    const u = byId.get(id);
    if (!(roles.get(id) ?? []).includes("invigilator")) problems.push({ code: "invigilator_role", blocking: true, message: `${u?.name ?? id} does not hold the Invigilator role.` });
    else if (u && (u.status === "suspended" || u.status === "archived")) problems.push({ code: "invigilator_inactive", blocking: true, message: `${u.name} is ${u.status} and cannot invigilate.` });
    else if (opts.independent && u?.employment !== "external") problems.push({ code: "not_independent", blocking: true, message: `${u?.name} is not an external invigilator, but this sitting requires independent invigilation.` });
  }

  // Ratio.
  const need = invigilatorsNeeded(opts.learners);
  if (opts.learners > 0 && invigilatorIds.length < need) {
    problems.push({ code: "ratio", blocking: true, message: `${opts.learners} learners need at least ${need} invigilator${need === 1 ? "" : "s"} (1 to ${INVIGILATOR_RATIO}); ${invigilatorIds.length} chosen.` });
  }

  // Scope.
  const scopes = await assessorScopeMap([assessorId]);
  const scope = scopes.get(assessorId);
  const a = byId.get(assessorId);
  if (scope && !scope.has(opts.qualificationId)) {
    problems.push({ code: "scope", blocking: true, message: `${a?.name ?? "This assessor"} is not registered to assess this qualification.` });
  } else if (!scope) {
    problems.push({ code: "scope_unknown", blocking: false, message: `${a?.name ?? "This assessor"} has no registration scope recorded yet - record it on their person page.` });
  }

  // Marking cap.
  const loads = await assessorLoads([assessorId]);
  const load = loads.get(assessorId) ?? { inFlight: 0, waiting: 0, cap: DEFAULT_MARKING_CAP };
  if (load.inFlight + opts.assessorAddedScripts > load.cap) {
    problems.push({ code: "cap", blocking: false, message: `${a?.name ?? "This assessor"} would have ${load.inFlight + opts.assessorAddedScripts} scripts in flight against a cap of ${load.cap} (${load.inFlight} already).` });
  }

  // Clashes.
  for (const w of opts.windows) {
    const clashes = await invigilatorClashes(invigilatorIds, w, opts.ignoreSittingId);
    for (const [id, list] of clashes) {
      const u = byId.get(id);
      problems.push({ code: "invigilator_clash", blocking: true, message: `${u?.name ?? id} is already invigilating ${list[0].name ?? "another sitting"} at ${list[0].startTime.toISOString().slice(0, 16).replace("T", " ")}.` });
    }
  }
  return problems;
}
