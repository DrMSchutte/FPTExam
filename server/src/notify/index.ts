import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { notificationLog, users, userRoles, examSittings, sittingInvigilators, learnerSessions, assessorDecisions, qualifications, assessmentInstruments, backgroundJobs, fptstaffResultPushes, recordingSegments } from "../db/schema.js";
import { sendMail, isMailConfigured, assessorScriptsEmail, invigilatorSittingEmail, adminDigestEmail, healthAlertEmail } from "../email/mailer.js";

// Block 8e: the reminders. Nobody should have to remember to look - the system
// tells the people who need to act:
//
//   assessor_scripts_waiting       once a day, while an assessor has scripts to mark
//   assessor_overdue               once a day, when a script has waited longer than the rule allows
//   invigilator_sitting_tomorrow   once per sitting, the afternoon before
//   admin_digest                   once a day: yesterday, today, what is stuck
//   admin_health_alert             when something needs attention now (a job gave up, results not
//                                  reaching FPTStaff, a recording that never arrived)
//
// Every reminder is written to notification_log first, with a dedupe key that
// carries the day or the sitting it is about, so a restart, a second server or
// a hand-run sweep can never send the same thing twice. When SMTP is not
// connected the row is kept as `not_connected` - the Administrator can still
// see exactly what would have gone out, and nothing is lost.

export const OVERDUE_DAYS = 5;
export const remindersOff = () => /^(off|no|false|0)$/i.test(process.env.REMINDERS ?? "");

// Africa/Johannesburg, without pulling in a timezone library: SAST is UTC+2
// all year (no daylight saving).
const SAST_OFFSET_MS = 2 * 3600 * 1000;
export const sastNow = (now = new Date()) => new Date(now.getTime() + SAST_OFFSET_MS);
export const sastDay = (now = new Date()) => sastNow(now).toISOString().slice(0, 10);
export const sastHour = (now = new Date()) => sastNow(now).getUTCHours();

const fmtDay = (d: Date) => d.toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long", timeZone: "Africa/Johannesburg" });
const fmtTime = (d: Date) => d.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" });

export interface Queued { kind: string; dedupeKey: string; toUserId: string | null; toEmail: string; subject: string; body: string }

// Writes the reminder if it has not been written before. Returns the row id, or
// null when it is a duplicate - the unique index is the authority, not a
// look-up, so two servers racing still send once.
async function queue(q: Queued): Promise<string | null> {
  const [row] = await db.insert(notificationLog).values({ kind: q.kind, dedupeKey: q.dedupeKey, toUserId: q.toUserId, toEmail: q.toEmail, subject: q.subject, body: q.body, status: "pending" }).onConflictDoNothing().returning({ id: notificationLog.id });
  return row?.id ?? null;
}

// Sends everything still pending. Called by the job runner's quick lane, so a
// long AI review never delays a reminder.
export async function sendPending(limit = 50): Promise<{ sent: number; notConnected: number; failed: number }> {
  const pending = await db.select().from(notificationLog).where(eq(notificationLog.status, "pending")).orderBy(asc(notificationLog.createdAt)).limit(limit);
  let sent = 0, notConnected = 0, failed = 0;
  for (const p of pending) {
    if (!isMailConfigured()) {
      await db.update(notificationLog).set({ status: "not_connected", detail: "Email is not connected yet (SMTP secrets not set)." }).where(eq(notificationLog.id, p.id));
      notConnected++;
      continue;
    }
    const r = await sendMail({ to: p.toEmail, subject: p.subject, text: p.body });
    if (r.sent) { await db.update(notificationLog).set({ status: "sent", sentAt: new Date() }).where(eq(notificationLog.id, p.id)); sent++; }
    else { await db.update(notificationLog).set({ status: "failed", detail: r.reason ?? "Email failed." }).where(eq(notificationLog.id, p.id)); failed++; }
  }
  return { sent, notConnected, failed };
}

// ---- What is waiting for whom ------------------------------------------------------

export async function assessorWorkload() {
  return (await db
    .select({
      assessorId: examSittings.assignedAssessorId,
      name: users.name,
      email: users.email,
      waiting: sql<number>`count(*) FILTER (WHERE ${learnerSessions.submissionTime} IS NOT NULL AND ${assessorDecisions.signedOffAt} IS NULL)::int`,
      overdue: sql<number>`count(*) FILTER (WHERE ${learnerSessions.submissionTime} < now() - interval '${sql.raw(String(OVERDUE_DAYS))} days' AND ${assessorDecisions.signedOffAt} IS NULL)::int`,
      oldest: sql<Date | null>`min(${learnerSessions.submissionTime}) FILTER (WHERE ${assessorDecisions.signedOffAt} IS NULL)`,
      sittings: sql<number>`count(DISTINCT ${examSittings.id}) FILTER (WHERE ${learnerSessions.submissionTime} IS NOT NULL AND ${assessorDecisions.signedOffAt} IS NULL)::int`,
    })
    .from(learnerSessions)
    .innerJoin(examSittings, eq(examSittings.id, learnerSessions.sittingId))
    .innerJoin(users, eq(users.id, examSittings.assignedAssessorId))
    .leftJoin(assessorDecisions, eq(assessorDecisions.sessionId, learnerSessions.id))
    .where(inArray(users.status, ["active", "invited"]))
    .groupBy(examSittings.assignedAssessorId, users.name, users.email)
    ).filter((r) => r.waiting > 0);
}

export async function sittingsStartingBetween(from: Date, to: Date) {
  const rows = await db
    .select({ sitting: examSittings, qualificationTitle: qualifications.title, paper: assessmentInstruments.version, minutes: assessmentInstruments.timeAllocationMinutes, assessorName: users.name, assessorEmail: users.email })
    .from(examSittings)
    .innerJoin(qualifications, eq(qualifications.id, examSittings.qualificationId))
    .innerJoin(assessmentInstruments, eq(assessmentInstruments.id, examSittings.instrumentId))
    .innerJoin(users, eq(users.id, examSittings.assignedAssessorId))
    .where(and(gte(examSittings.startTime, from), lt(examSittings.startTime, to)))
    .orderBy(asc(examSittings.startTime));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.sitting.id);
  const invs = await db.select({ sittingId: sittingInvigilators.sittingId, name: users.name, email: users.email }).from(sittingInvigilators).innerJoin(users, eq(users.id, sittingInvigilators.invigilatorId)).where(inArray(sittingInvigilators.sittingId, ids));
  const counts = await db.select({ sittingId: learnerSessions.sittingId, n: sql<number>`count(*)::int` }).from(learnerSessions).where(inArray(learnerSessions.sittingId, ids)).groupBy(learnerSessions.sittingId);
  const codes = await db.select({ sittingId: learnerSessions.sittingId, n: sql<number>`count(*) FILTER (WHERE ${learnerSessions.codeHash} IS NOT NULL)::int` }).from(learnerSessions).where(inArray(learnerSessions.sittingId, ids)).groupBy(learnerSessions.sittingId);
  const cMap = new Map(counts.map((c) => [c.sittingId, c.n])), kMap = new Map(codes.map((c) => [c.sittingId, c.n]));
  return rows.map((r) => ({ ...r, invigilators: invs.filter((i) => i.sittingId === r.sitting.id), learners: cMap.get(r.sitting.id) ?? 0, codesIssued: kMap.get(r.sitting.id) ?? 0 }));
}

// ---- Is anything wrong? -------------------------------------------------------------

export interface Health {
  at: string;
  failedJobs: { jobType: string; n: number; detail: string | null }[];
  resultPushesFailed: number;
  resultPushesPending: number;
  papersBlocked: number;
  sittingsWithoutCodes: number;
  scriptsOverdue: number;
  emailConnected: boolean;
  recordingGaps: { sittingName: string | null; learnerName: string; expected: number; got: number }[];
  problems: string[];
}

export async function healthSnapshot(): Promise<Health> {
  const failed = await db.select({ jobType: backgroundJobs.jobType, n: sql<number>`count(*)::int`, detail: sql<string | null>`max(${backgroundJobs.result}->>'detail')` }).from(backgroundJobs).where(and(eq(backgroundJobs.status, "failed"), gte(backgroundJobs.createdAt, new Date(Date.now() - 7 * 86400000)))).groupBy(backgroundJobs.jobType);
  const [pushes] = await db.select({ failed: sql<number>`count(*) FILTER (WHERE ${fptstaffResultPushes.status} = 'failed')::int`, pending: sql<number>`count(*) FILTER (WHERE ${fptstaffResultPushes.status} = 'pending')::int` }).from(fptstaffResultPushes);
  const [blocked] = await db.select({ n: sql<number>`count(*)::int` }).from(assessmentInstruments).where(and(eq(assessmentInstruments.intakeStatus, "blocked"), isNull(assessmentInstruments.retiredAt)));
  const [noCodes] = await db.select({ n: sql<number>`count(DISTINCT ${examSittings.id})::int` }).from(examSittings).innerJoin(learnerSessions, eq(learnerSessions.sittingId, examSittings.id)).where(and(gte(examSittings.startTime, new Date()), lte(examSittings.startTime, new Date(Date.now() + 3 * 86400000)), isNull(learnerSessions.codeHash)));
  const [overdue] = await db.select({ n: sql<number>`count(*)::int` }).from(learnerSessions).leftJoin(assessorDecisions, eq(assessorDecisions.sessionId, learnerSessions.id)).where(and(sql`${learnerSessions.submissionTime} < now() - interval '${sql.raw(String(OVERDUE_DAYS))} days'`, isNull(assessorDecisions.signedOffAt)));

  // A fully recorded sitting that finished with far fewer minutes of video than
  // the learner wrote: the browser's uploads did not all arrive.
  const gaps = await db.execute(sql`
    SELECT s.name AS "sittingName", u.name AS "learnerName",
           GREATEST(1, (EXTRACT(EPOCH FROM (ls.submission_time - ls.started_at)) / 60)::int) AS expected,
           count(rs.id) FILTER (WHERE rs.kind = 'camera')::int AS got
      FROM learner_sessions ls
      JOIN exam_sittings s ON s.id = ls.sitting_id
      JOIN users u ON u.id = ls.learner_id
      LEFT JOIN recording_segments rs ON rs.session_id = ls.id
     WHERE s.proctoring_profile->>'fullRecordingEnabled' = 'true'
       AND ls.submission_time IS NOT NULL AND ls.started_at IS NOT NULL
       AND ls.submission_time > now() - interval '7 days'
     GROUP BY 1, 2, 3
    HAVING count(rs.id) FILTER (WHERE rs.kind = 'camera') < GREATEST(1, (EXTRACT(EPOCH FROM (ls.submission_time - ls.started_at)) / 60)::int) * 0.6
     ORDER BY 3 DESC LIMIT 20`);

  const recordingGaps = (gaps.rows as { sittingName: string | null; learnerName: string; expected: number; got: number }[]) ?? [];
  const problems: string[] = [];
  for (const f of failed) problems.push(`${f.n} ${f.jobType.replace(/_/g, " ")} job${f.n === 1 ? "" : "s"} gave up${f.detail ? ` (${f.detail})` : ""}`);
  if (pushes.failed) problems.push(`${pushes.failed} result${pushes.failed === 1 ? "" : "s"} could not be delivered to FPTStaff`);
  if (blocked.n) problems.push(`${blocked.n} paper${blocked.n === 1 ? " is" : "s are"} blocked by the standard check`);
  if (noCodes.n) problems.push(`${noCodes.n} sitting${noCodes.n === 1 ? "" : "s"} in the next three days ${noCodes.n === 1 ? "has" : "have"} learners without a sitting code`);
  if (overdue.n) problems.push(`${overdue.n} script${overdue.n === 1 ? " has" : "s have"} been waiting longer than ${OVERDUE_DAYS} days to be marked`);
  if (recordingGaps.length) problems.push(`${recordingGaps.length} recorded sitting${recordingGaps.length === 1 ? "" : "s"} ${recordingGaps.length === 1 ? "is" : "are"} missing much of the video that should have arrived`);
  if (!isMailConfigured()) problems.push("Email is not connected, so nobody is being told anything automatically (set the SMTP secrets)");

  return { at: new Date().toISOString(), failedJobs: failed, resultPushesFailed: pushes.failed, resultPushesPending: pushes.pending, papersBlocked: blocked.n, sittingsWithoutCodes: noCodes.n, scriptsOverdue: overdue.n, emailConnected: isMailConfigured(), recordingGaps, problems };
}

// ---- The sweep ----------------------------------------------------------------------

export interface SweepResult { queued: number; kinds: Record<string, number>; skipped: string[] }

// Runs on the hour. Each reminder decides for itself whether this is its hour,
// so the sweep is safe to run by hand at any time (the Administrator's "Run the
// reminders now" button) - it will simply queue whatever is due today.
export async function runReminderSweep(opts: { force?: boolean; now?: Date } = {}): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  const hour = sastHour(now);
  const day = sastDay(now);
  const kinds: Record<string, number> = {};
  const skipped: string[] = [];
  const bump = (k: string) => { kinds[k] = (kinds[k] ?? 0) + 1; };

  if (remindersOff()) return { queued: 0, kinds, skipped: ["Reminders are switched off (REMINDERS=off)."] };

  const appBase = (process.env.APP_BASE_URL ?? "").replace(/\/+$/, "");

  // 07:00 SAST - the assessors who have scripts waiting.
  if (opts.force || hour === 7) {
    for (const a of await assessorWorkload()) {
      const mail = assessorScriptsEmail({ name: a.name, waiting: a.waiting, overdue: a.overdue, sittings: a.sittings, oldest: a.oldest ? new Date(a.oldest) : null, overdueDays: OVERDUE_DAYS, queueUrl: `${appBase}/assessor` });
      if (await queue({ kind: a.overdue > 0 ? "assessor_overdue" : "assessor_scripts_waiting", dedupeKey: `${a.assessorId}:${day}`, toUserId: a.assessorId, toEmail: a.email, subject: mail.subject, body: mail.text })) bump(a.overdue > 0 ? "assessor_overdue" : "assessor_scripts_waiting");
    }
  } else skipped.push("assessor reminders go out at 07:00");

  // 16:00 SAST - everyone working tomorrow's sittings.
  if (opts.force || hour === 16) {
    const startOfTomorrow = new Date(now.getTime() + SAST_OFFSET_MS);
    startOfTomorrow.setUTCHours(0, 0, 0, 0);
    const from = new Date(startOfTomorrow.getTime() + 24 * 3600000 - SAST_OFFSET_MS);
    const to = new Date(from.getTime() + 24 * 3600000);
    for (const s of await sittingsStartingBetween(from, to)) {
      const people = [...s.invigilators.map((i) => ({ id: null as string | null, name: i.name, email: i.email, role: "invigilator" as const })), { id: null, name: s.assessorName, email: s.assessorEmail, role: "assessor" as const }];
      for (const p of people) {
        const mail = invigilatorSittingEmail({
          name: p.name, role: p.role, sittingName: s.sitting.name ?? `${s.qualificationTitle} · ${s.paper}`,
          qualificationTitle: s.qualificationTitle, day: fmtDay(s.sitting.startTime), from: fmtTime(s.sitting.startTime), to: fmtTime(s.sitting.endTime),
          venue: s.sitting.venue, learners: s.learners, codesIssued: s.codesIssued, minutes: s.minutes,
          fullRecording: Boolean((s.sitting.proctoringProfile as { fullRecordingEnabled?: boolean } | null)?.fullRecordingEnabled),
          consoleUrl: `${appBase}/invigilator`,
        });
        if (await queue({ kind: "invigilator_sitting_tomorrow", dedupeKey: `${s.sitting.id}:${p.email}`, toUserId: p.id, toEmail: p.email, subject: mail.subject, body: mail.text })) bump("invigilator_sitting_tomorrow");
      }
    }
  } else skipped.push("tomorrow's sittings are announced at 16:00");

  // 07:00 SAST - the Administrator's digest, and an alert at any hour when
  // something needs attention now.
  const admins = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).innerJoin(userRoles, and(eq(userRoles.userId, users.id), eq(userRoles.role, "administrator"))).where(eq(users.status, "active"));
  const health = await healthSnapshot();
  if (opts.force || hour === 7) {
    const yesterdayFrom = new Date(now.getTime() - 24 * 3600000);
    const [y] = await db.select({
      submitted: sql<number>`count(*) FILTER (WHERE ${learnerSessions.submissionTime} >= ${yesterdayFrom})::int`,
      released: sql<number>`count(*) FILTER (WHERE ${assessorDecisions.signedOffAt} >= ${yesterdayFrom})::int`,
    }).from(learnerSessions).leftJoin(assessorDecisions, eq(assessorDecisions.sessionId, learnerSessions.id));
    const today = await sittingsStartingBetween(now, new Date(now.getTime() + 24 * 3600000));
    for (const a of admins) {
      const mail = adminDigestEmail({
        name: a.name, submitted: y.submitted, released: y.released,
        today: today.map((s) => ({ name: s.sitting.name ?? `${s.qualificationTitle} · ${s.paper}`, at: fmtTime(s.sitting.startTime), venue: s.sitting.venue, learners: s.learners })),
        problems: health.problems, overdueDays: OVERDUE_DAYS, url: `${appBase}/admin`,
      });
      if (await queue({ kind: "admin_digest", dedupeKey: `${a.id}:${day}`, toUserId: a.id, toEmail: a.email, subject: mail.subject, body: mail.text })) bump("admin_digest");
    }
  } else skipped.push("the daily digest goes out at 07:00");

  // Anything urgent, at most once per administrator per day per problem set.
  const urgent = health.problems.filter((p) => !/^Email is not connected/.test(p));
  if (urgent.length) {
    const key = Buffer.from(urgent.join("|")).toString("base64url").slice(0, 60);
    for (const a of admins) {
      const mail = healthAlertEmail({ name: a.name, problems: urgent, url: `${appBase}/admin` });
      if (await queue({ kind: "admin_health_alert", dedupeKey: `${a.id}:${day}:${key}`, toUserId: a.id, toEmail: a.email, subject: mail.subject, body: mail.text })) bump("admin_health_alert");
    }
  }

  const queued = Object.values(kinds).reduce((t, n) => t + n, 0);
  return { queued, kinds, skipped };
}

export async function recentNotifications(limit = 60) {
  return db.select().from(notificationLog).orderBy(desc(notificationLog.createdAt)).limit(limit);
}
