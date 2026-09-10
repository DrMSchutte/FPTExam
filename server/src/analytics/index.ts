import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { aiResponseReviews, assessmentInstruments, assessorDecisions, learnerSessions } from "../db/schema.js";
import { eq, and, isNotNull, inArray } from "drizzle-orm";
import type { Question, QuestionMark, AiQuestionSuggestion, InstrumentQualityReview } from "../types.js";

// Block 8d: analytics. Every figure here is computed from the same sealed
// record the reports are rendered from - there is no separate reporting
// database to fall out of step. Everything is filtered by a date window over
// the SITTING's start time (not the sign-off), so "this year's exams" means
// the exams written this year, and optionally by qualification.
//
// Deliberately not here: anything that ranks or scores a learner beyond their
// own result, and anything that would let a pass rate be mistaken for a
// target. The point is to see whether the papers, the assessors and the rooms
// are doing their job.

export interface Window { from: Date; to: Date; qualificationId?: string }

const rows = async <T>(q: ReturnType<typeof sql>): Promise<T[]> => (await db.execute(q)).rows as T[];
const win = (w: Window) => sql`s.start_time >= ${w.from} AND s.start_time <= ${w.to}${w.qualificationId ? sql` AND s.qualification_id = ${w.qualificationId}` : sql``}`;

// The shared FROM: every learner session in the window, with its sitting, its
// result if signed off, and its integrity call if one was computed.
const base = (w: Window) => sql`
  FROM learner_sessions ls
  JOIN exam_sittings s ON s.id = ls.sitting_id
  LEFT JOIN assessor_decisions d ON d.session_id = ls.id AND d.signed_off_at IS NOT NULL
  LEFT JOIN ai_integrity_reports ig ON ig.session_id = ls.id
  WHERE ${win(w)}`;

const MEASURES = sql`
  count(*)::int                                                                              AS registered,
  count(*) FILTER (WHERE ls.check_in_time IS NOT NULL OR ls.started_at IS NOT NULL OR ls.submission_time IS NOT NULL)::int AS checked_in,
  count(*) FILTER (WHERE ls.started_at IS NOT NULL OR ls.submission_time IS NOT NULL)::int    AS opened,
  count(*) FILTER (WHERE ls.submission_time IS NOT NULL)::int                                AS submitted,
  count(*) FILTER (WHERE d.signed_off_at IS NOT NULL)::int                                   AS released,
  count(*) FILTER (WHERE d.outcome = 'competent')::int                                       AS competent,
  round(avg(d.total_mark::numeric * 100 / NULLIF(d.total_max, 0)) FILTER (WHERE d.signed_off_at IS NOT NULL), 1)::float AS avg_percentage,
  round(avg(EXTRACT(EPOCH FROM (d.signed_off_at - ls.submission_time)) / 3600) FILTER (WHERE d.signed_off_at IS NOT NULL AND ls.submission_time IS NOT NULL), 1)::float AS avg_mark_hours,
  round(avg(EXTRACT(EPOCH FROM (ls.submission_time - ls.started_at)) / 60) FILTER (WHERE ls.submission_time IS NOT NULL AND ls.started_at IS NOT NULL), 0)::int AS avg_minutes_written,
  count(*) FILTER (WHERE ig.overall_recommendation = 'clear')::int                            AS integrity_clear,
  count(*) FILTER (WHERE ig.overall_recommendation = 'review')::int                           AS integrity_review,
  count(*) FILTER (WHERE ig.overall_recommendation = 'investigate')::int                       AS integrity_investigate`;

export interface Measures {
  registered: number; checked_in: number; opened: number; submitted: number; released: number; competent: number;
  avg_percentage: number | null; avg_mark_hours: number | null; avg_minutes_written: number | null;
  integrity_clear: number; integrity_review: number; integrity_investigate: number;
}

const shape = (m: Measures) => ({
  registered: m.registered, checkedIn: m.checked_in, opened: m.opened, submitted: m.submitted, released: m.released, competent: m.competent,
  notYetCompetent: m.released - m.competent,
  passRate: m.released ? Math.round((m.competent / m.released) * 1000) / 10 : null,
  avgPercentage: m.avg_percentage, avgMarkHours: m.avg_mark_hours, avgMinutesWritten: m.avg_minutes_written,
  noShows: Math.max(0, m.registered - m.checked_in),
  didNotOpen: Math.max(0, m.checked_in - m.opened),
  didNotFinish: Math.max(0, m.opened - m.submitted),
  awaitingMarking: Math.max(0, m.submitted - m.released),
  integrity: { clear: m.integrity_clear, review: m.integrity_review, investigate: m.integrity_investigate },
  flagRate: m.integrity_clear + m.integrity_review + m.integrity_investigate ? Math.round(((m.integrity_review + m.integrity_investigate) / (m.integrity_clear + m.integrity_review + m.integrity_investigate)) * 1000) / 10 : null,
});
export type Shaped = ReturnType<typeof shape>;

export async function headline(w: Window) {
  const [m] = await rows<Measures>(sql`SELECT ${MEASURES} ${base(w)}`);
  const [extra] = await rows<{ sittings: number; venues: number; papers: number; recorded: number }>(sql`
    SELECT count(DISTINCT s.id)::int AS sittings, count(DISTINCT s.venue)::int AS venues, count(DISTINCT s.instrument_id)::int AS papers,
           count(DISTINCT s.id) FILTER (WHERE s.proctoring_profile->>'fullRecordingEnabled' = 'true')::int AS recorded
    FROM exam_sittings s WHERE ${win(w)}`);
  return { ...shape(m), sittings: extra.sittings, venues: extra.venues, papers: extra.papers, recordedSittings: extra.recorded };
}

// Each cut runs over the same rows with the naming tables joined in.
const JOINS = sql`
  LEFT JOIN qualifications q ON q.id = s.qualification_id
  LEFT JOIN cohorts c        ON c.id = s.cohort_id
  LEFT JOIN assessment_instruments i ON i.id = s.instrument_id`;

async function cut(w: Window, keyExpr: ReturnType<typeof sql>, labelExpr: ReturnType<typeof sql>, order = sql`2 NULLS LAST`) {
  const r = await rows<Measures & { key: string | null; label: string | null }>(sql`
    SELECT ${keyExpr} AS key, ${labelExpr} AS label, ${MEASURES}
    FROM learner_sessions ls
    JOIN exam_sittings s ON s.id = ls.sitting_id
    LEFT JOIN assessor_decisions d ON d.session_id = ls.id AND d.signed_off_at IS NOT NULL
    LEFT JOIN ai_integrity_reports ig ON ig.session_id = ls.id
    ${JOINS}
    WHERE ${win(w)}
    GROUP BY 1, 2 ORDER BY ${order}`);
  return r.map((x) => ({ key: x.key, label: x.label ?? "—", ...shape(x) }));
}

export interface AnalyticsOverview {
  window: { from: string; to: string; qualificationId: string | null };
  headline: Awaited<ReturnType<typeof headline>>;
  byQualification: Shaped2[]; byCohort: Shaped2[]; byPaper: Shaped2[]; byVenue: Shaped2[]; bySitting: Shaped2[]; byMonth: Shaped2[];
  assessors: AssessorConsistency[];
  findings: { code: string; title: string; severity: string; sessions: number }[];
  papers: { id: string; version: string; qualificationTitle: string; sat: number }[];
}
export type Shaped2 = { key: string | null; label: string } & Shaped;

export async function overview(w: Window): Promise<AnalyticsOverview> {
  const [h, q, c, p, v, s, m, a, f, papers] = await Promise.all([
    headline(w),
    cut(w, sql`q.id::text`, sql`q.title`),
    cut(w, sql`c.id::text`, sql`coalesce(c.name, 'Not linked to a cohort')`),
    cut(w, sql`i.id::text`, sql`q.title || ' · ' || i.version`),
    cut(w, sql`coalesce(s.venue, 'Not recorded')`, sql`coalesce(s.venue, 'Not recorded')`),
    cut(w, sql`s.id::text`, sql`coalesce(s.name, q.title || ' · ' || to_char(s.start_time, 'DD Mon YYYY'))`, sql`min(s.start_time) DESC`),
    cut(w, sql`to_char(s.start_time, 'YYYY-MM')`, sql`to_char(s.start_time, 'Mon YYYY')`, sql`1`),
    assessorConsistency(w),
    findingFrequency(w),
    papersInWindow(w),
  ]);
  return { window: { from: w.from.toISOString(), to: w.to.toISOString(), qualificationId: w.qualificationId ?? null }, headline: h, byQualification: q, byCohort: c, byPaper: p, byVenue: v, bySitting: s, byMonth: m, assessors: a, findings: f, papers };
}

// Which integrity findings actually come up, and how often - so the rules that
// never fire (or fire on everyone) can be seen and questioned.
export async function findingFrequency(w: Window) {
  const r = await rows<{ code: string; title: string; severity: string; sessions: number }>(sql`
    SELECT f->>'code' AS code, min(f->>'title') AS title, min(f->>'severity') AS severity, count(DISTINCT ls.id)::int AS sessions
    FROM learner_sessions ls
    JOIN exam_sittings s ON s.id = ls.sitting_id
    JOIN ai_integrity_reports ig ON ig.session_id = ls.id
    CROSS JOIN LATERAL jsonb_array_elements(ig.findings->'findings') f
    WHERE ${win(w)}
    GROUP BY 1 ORDER BY 4 DESC`);
  return r;
}

export async function papersInWindow(w: Window) {
  return rows<{ id: string; version: string; qualificationTitle: string; sat: number }>(sql`
    SELECT i.id::text AS id, i.version AS version, q.title AS "qualificationTitle", count(*) FILTER (WHERE ls.submission_time IS NOT NULL)::int AS sat
    FROM learner_sessions ls
    JOIN exam_sittings s ON s.id = ls.sitting_id
    JOIN assessment_instruments i ON i.id = s.instrument_id
    JOIN qualifications q ON q.id = s.qualification_id
    WHERE ${win(w)}
    GROUP BY 1, 2, 3 HAVING count(*) FILTER (WHERE ls.submission_time IS NOT NULL) > 0
    ORDER BY 4 DESC`);
}

// ---- Assessor consistency against the AI suggestion --------------------------------
//
// Not a score for the assessor: the assessor's mark is the mark. This measures
// how far the AI's suggestion sat from it, so a paper whose rubric the AI reads
// badly can be spotted, and so an assessor who accepts every suggestion
// unchanged (or overrides every one) is visible to the administrator.

export interface AssessorConsistency {
  assessorId: string; name: string;
  signedOff: number; avgTurnaroundHours: number | null; avgPercentage: number | null; passRate: number | null;
  questionsCompared: number; acceptedUnchanged: number | null; meanAbsDiffMarks: number | null; meanAbsDiffPct: number | null;
  markedAbove: number; markedBelow: number; outcomeDiffered: number; overrides: number;
}

export async function assessorConsistency(w: Window): Promise<AssessorConsistency[]> {
  const r = await rows<{ assessorId: string; name: string; signedOff: number; hours: number | null; pct: number | null; competent: number; sessionIds: string[] }>(sql`
    SELECT d.assessor_id::text AS "assessorId", u.name AS name, count(*)::int AS "signedOff",
           round(avg(EXTRACT(EPOCH FROM (d.signed_off_at - ls.submission_time)) / 3600), 1)::float AS hours,
           round(avg(d.total_mark::numeric * 100 / NULLIF(d.total_max, 0)), 1)::float AS pct,
           count(*) FILTER (WHERE d.outcome = 'competent')::int AS competent,
           array_agg(ls.id::text) AS "sessionIds"
    FROM learner_sessions ls
    JOIN exam_sittings s ON s.id = ls.sitting_id
    JOIN assessor_decisions d ON d.session_id = ls.id AND d.signed_off_at IS NOT NULL
    JOIN users u ON u.id = d.assessor_id
    WHERE ${win(w)}
    GROUP BY 1, 2 ORDER BY 2`);
  if (!r.length) return [];

  const allIds = r.flatMap((x) => x.sessionIds);
  const marks = await db.select({ sessionId: assessorDecisions.sessionId, perCriterionMarks: assessorDecisions.perCriterionMarks, review: assessorDecisions.aiSuggestionsReview, outcome: assessorDecisions.outcome }).from(assessorDecisions).where(inArray(assessorDecisions.sessionId, allIds));
  const ai = (await db
    .select({ sessionId: aiResponseReviews.sessionId, suggestions: aiResponseReviews.perQuestionSuggestions, suggestedOutcome: aiResponseReviews.suggestedOutcome })
    .from(aiResponseReviews)
    .where(inArray(aiResponseReviews.sessionId, allIds))) as { sessionId: string; suggestions: AiQuestionSuggestion[]; suggestedOutcome: string | null }[];
  const aiBy = new Map(ai.map((x) => [x.sessionId, x]));
  const markBy = new Map(marks.map((x) => [x.sessionId, x]));

  return r.map((x) => {
    let compared = 0, unchanged = 0, absDiff = 0, absDiffPct = 0, above = 0, below = 0, outcomeDiffered = 0, overrides = 0;
    for (const sid of x.sessionIds) {
      const mine = markBy.get(sid);
      const theirs = aiBy.get(sid);
      if (!mine) continue;
      const review = (mine.review as { questionId: string; decision?: string }[] | null) ?? [];
      overrides += review.filter((v) => v.decision === "overridden").length;
      if (!theirs) continue;
      if (theirs.suggestedOutcome && mine.outcome && theirs.suggestedOutcome !== mine.outcome) outcomeDiffered++;
      const sug = new Map((theirs.suggestions ?? []).map((s) => [s.questionId, s]));
      for (const qm of (mine.perCriterionMarks as QuestionMark[]) ?? []) {
        const s = sug.get(qm.questionId);
        if (!s) continue;
        compared++;
        const diff = qm.mark - s.suggestedMark;
        if (diff === 0) unchanged++;
        else if (diff > 0) above++;
        else below++;
        absDiff += Math.abs(diff);
        if (s.maxMark > 0) absDiffPct += (Math.abs(diff) / s.maxMark) * 100;
      }
    }
    return {
      assessorId: x.assessorId, name: x.name, signedOff: x.signedOff, avgTurnaroundHours: x.hours, avgPercentage: x.pct,
      passRate: x.signedOff ? Math.round((x.competent / x.signedOff) * 1000) / 10 : null,
      questionsCompared: compared,
      acceptedUnchanged: compared ? Math.round((unchanged / compared) * 1000) / 10 : null,
      meanAbsDiffMarks: compared ? Math.round((absDiff / compared) * 100) / 100 : null,
      meanAbsDiffPct: compared ? Math.round((absDiffPct / compared) * 10) / 10 : null,
      markedAbove: above, markedBelow: below, outcomeDiffered, overrides,
    };
  });
}

// ---- Item analysis: is each question doing its job? -------------------------------
//
// Facility: the share of the marks available that learners actually earned -
// above 90% the question separates nobody, below 30% it may be unfair or
// badly worded. Discrimination: facility among the strongest third of the
// cohort minus the weakest third; at or below zero the question is telling us
// the opposite of everything else in the paper, and should be looked at.

export interface ItemRow {
  questionId: string; index: number; type: string; bloomLevel: string | null; eloRef: string | null; acRef: string | null;
  prompt: string; maxMark: number;
  answered: number; avgMark: number | null; facility: number | null; zeroes: number; fullMarks: number; blank: number;
  discrimination: number | null; flags: string[];
}
export interface ItemAnalysis {
  instrument: { id: string; version: string; qualificationTitle: string; questions: number; totalMarks: number; verdict: string | null };
  learners: number; avgPercentage: number | null; passRate: number | null;
  items: ItemRow[];
  note: string;
}

export async function itemAnalysis(instrumentId: string, w?: Window): Promise<ItemAnalysis | null> {
  const [instrument] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, instrumentId));
  if (!instrument) return null;
  const [meta] = await rows<{ qualificationTitle: string }>(sql`SELECT q.title AS "qualificationTitle" FROM qualifications q WHERE q.id = ${instrument.qualificationId}`);
  const questions = (instrument.questions as Question[]) ?? [];
  const totalMarks = questions.reduce((t, q) => t + q.maxMark, 0);

  const conds = [eq(learnerSessions.status, "submitted"), isNotNull(assessorDecisions.signedOffAt)];
  const scripts = await db
    .select({ sessionId: learnerSessions.id, marks: assessorDecisions.perCriterionMarks, answers: learnerSessions.answers, total: assessorDecisions.totalMark, max: assessorDecisions.totalMax })
    .from(learnerSessions)
    .innerJoin(assessorDecisions, and(eq(assessorDecisions.sessionId, learnerSessions.id), isNotNull(assessorDecisions.signedOffAt)))
    .innerJoin(assessmentInstruments, eq(assessmentInstruments.id, instrumentId))
    .where(and(sql`${learnerSessions.sittingId} IN (SELECT id FROM exam_sittings WHERE instrument_id = ${instrumentId}${w ? sql` AND start_time >= ${w.from} AND start_time <= ${w.to}` : sql``})`, isNotNull(learnerSessions.submissionTime)));

  const scored = scripts.map((s) => {
    const byQ = new Map(((s.marks as QuestionMark[]) ?? []).map((m) => [m.questionId, m.mark]));
    const answers = (s.answers ?? {}) as Record<string, unknown>;
    return { byQ, answers, pct: s.max ? (s.total ?? 0) / s.max : 0, total: s.total ?? 0 };
  });
  const ranked = [...scored].sort((a, b) => b.pct - a.pct);
  const third = Math.floor(ranked.length / 3);
  const top = third >= 2 ? ranked.slice(0, third) : [];
  const bottom = third >= 2 ? ranked.slice(-third) : [];
  const facilityOf = (group: typeof scored, q: Question) => {
    const vals = group.map((s) => s.byQ.get(q.id)).filter((v): v is number => typeof v === "number");
    if (!vals.length || q.maxMark === 0) return null;
    return (vals.reduce((a, b) => a + b, 0) / (vals.length * q.maxMark)) * 100;
  };

  const items: ItemRow[] = questions.map((q, i) => {
    const vals = scored.map((s) => s.byQ.get(q.id)).filter((v): v is number => typeof v === "number");
    const fac = facilityOf(scored, q);
    const tf = facilityOf(top, q), bf = facilityOf(bottom, q);
    const disc = tf !== null && bf !== null ? Math.round((tf - bf) * 10) / 10 : null;
    const blank = scored.filter((s) => { const a = s.answers[q.id]; return a === undefined || a === null || String(a).trim() === ""; }).length;
    const flags: string[] = [];
    if (vals.length >= 5) {
      if (fac !== null && fac >= 90) flags.push("almost everyone got it - separates nobody");
      if (fac !== null && fac <= 30) flags.push("very few earned the marks - check the wording and the memo");
      if (disc !== null && disc <= 0) flags.push("the strongest learners did no better than the weakest - review this question");
      if (blank >= Math.max(2, Math.round(scored.length * 0.2))) flags.push(`${blank} learners left it blank`);
    }
    return {
      questionId: q.id, index: i + 1, type: q.type, bloomLevel: q.bloomLevel ?? null, eloRef: q.eloRef ?? null, acRef: q.acRef ?? null,
      prompt: q.prompt.length > 180 ? q.prompt.slice(0, 177) + "…" : q.prompt, maxMark: q.maxMark,
      answered: vals.length,
      avgMark: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null,
      facility: fac === null ? null : Math.round(fac * 10) / 10,
      zeroes: vals.filter((v) => v === 0).length,
      fullMarks: vals.filter((v) => v === q.maxMark).length,
      blank,
      discrimination: disc,
      flags,
    };
  });

  const review = instrument.qualityReview as InstrumentQualityReview | null;
  const marks = scored.map((s) => s.pct * 100);
  return {
    instrument: { id: instrument.id, version: instrument.version, qualificationTitle: meta?.qualificationTitle ?? "", questions: questions.length, totalMarks, verdict: review?.verdict ?? null },
    learners: scored.length,
    avgPercentage: marks.length ? Math.round((marks.reduce((a, b) => a + b, 0) / marks.length) * 10) / 10 : null,
    passRate: null,
    items,
    note: scored.length < 5
      ? `Only ${scored.length} marked script${scored.length === 1 ? "" : "s"} on this paper so far. Item analysis needs about ten before the figures mean anything; nothing is flagged below five.`
      : `From ${scored.length} marked scripts. Facility is the share of available marks earned. Discrimination compares the strongest third with the weakest third of these learners.`,
  };
}
