import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { auditLog } from "../db/schema.js";
import { requireAuth, requireRole, type AuthedRequest } from "../auth/middleware.js";
import { overview, itemAnalysis, type Window, type Shaped2 } from "../analytics/index.js";
import { csv } from "../results/portfolio.js";

// Block 8d: the analytics endpoints. Administrator only - these figures are
// about the papers, the assessors and the rooms, not about individual
// learners, and an assessor should not be reading a comparison of assessors.
//
//   GET /analytics/overview?from=&to=&qualificationId=
//   GET /analytics/items/:instrumentId?from=&to=
//   GET /analytics/export/:cut.csv?from=&to=&qualificationId=   (cut: qualification|cohort|paper|venue|sitting|month|assessors|findings)
//   GET /analytics/items/:instrumentId/export.csv

export const analyticsRouter = Router();

const parseWindow = (q: Record<string, unknown>): Window => {
  const parsed = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional(), qualificationId: z.string().uuid().optional() }).safeParse(q);
  const now = new Date();
  const yearAgo = new Date(now.getFullYear() - 1, now.getMonth(), 1);
  if (!parsed.success) return { from: yearAgo, to: now };
  return {
    from: parsed.data.from ? new Date(parsed.data.from) : yearAgo,
    to: parsed.data.to ? new Date(parsed.data.to) : now,
    qualificationId: parsed.data.qualificationId,
  };
};

analyticsRouter.get("/overview", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  return res.json(await overview(parseWindow(req.query as Record<string, unknown>)));
});

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

analyticsRouter.get("/items/:instrumentId", requireAuth, requireRole("administrator", "assessor"), async (req: AuthedRequest, res) => {
  if (!isUuid(req.params.instrumentId)) return res.status(404).json({ error: "Paper not found." });
  const a = await itemAnalysis(req.params.instrumentId);
  if (!a) return res.status(404).json({ error: "Paper not found." });
  return res.json(a);
});

const SHAPED_HEAD = ["Registered", "Checked in", "Opened the paper", "Submitted", "Awaiting marking", "Results released", "Competent", "Not yet competent", "Pass rate %", "Average %", "Average hours to mark", "Average minutes written", "No-shows", "Checked in, did not open", "Opened, did not submit", "Integrity clear", "Integrity review", "Integrity investigate", "Flag rate %"];
const shapedRow = (r: Shaped2) => [r.registered, r.checkedIn, r.opened, r.submitted, r.awaitingMarking, r.released, r.competent, r.notYetCompetent, r.passRate, r.avgPercentage, r.avgMarkHours, r.avgMinutesWritten, r.noShows, r.didNotOpen, r.didNotFinish, r.integrity.clear, r.integrity.review, r.integrity.investigate, r.flagRate];

const CUTS: Record<string, { label: string; pick: (o: Awaited<ReturnType<typeof overview>>) => Shaped2[] }> = {
  qualification: { label: "Qualification", pick: (o) => o.byQualification },
  cohort: { label: "Cohort", pick: (o) => o.byCohort },
  paper: { label: "Paper", pick: (o) => o.byPaper },
  venue: { label: "Venue", pick: (o) => o.byVenue },
  sitting: { label: "Sitting", pick: (o) => o.bySitting },
  month: { label: "Month", pick: (o) => o.byMonth },
};

analyticsRouter.get("/export/:cut.csv", requireAuth, requireRole("administrator"), async (req: AuthedRequest, res) => {
  const w = parseWindow(req.query as Record<string, unknown>);
  const cut = req.params.cut;
  const o = await overview(w);
  let body: string;
  if (CUTS[cut]) body = csv([CUTS[cut].label, ...SHAPED_HEAD], CUTS[cut].pick(o).map((r) => [r.label, ...shapedRow(r)]));
  else if (cut === "assessors") body = csv(["Assessor", "Scripts signed off", "Average hours to mark", "Average % awarded", "Pass rate %", "Questions compared with the AI", "Accepted unchanged %", "Mean difference (marks)", "Mean difference (% of the question)", "Marked above the AI", "Marked below the AI", "Outcome differed from the AI", "Suggestions overridden"], o.assessors.map((a) => [a.name, a.signedOff, a.avgTurnaroundHours, a.avgPercentage, a.passRate, a.questionsCompared, a.acceptedUnchanged, a.meanAbsDiffMarks, a.meanAbsDiffPct, a.markedAbove, a.markedBelow, a.outcomeDiffered, a.overrides]));
  else if (cut === "findings") body = csv(["Finding", "Code", "Severity", "Sittings affected"], o.findings.map((f) => [f.title, f.code, f.severity, f.sessions]));
  else if (cut === "headline") body = csv(["Measure", "Value"], [["Window from", o.window.from], ["Window to", o.window.to], ["Sittings", o.headline.sittings], ["Venues", o.headline.venues], ["Papers used", o.headline.papers], ["Fully recorded sittings", o.headline.recordedSittings], ...SHAPED_HEAD.map((h, i) => [h, shapedRow(o.headline as unknown as Shaped2)[i]])]);
  else return res.status(404).json({ error: "Unknown export." });
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "analytics_exported", targetType: "analytics", reason: `${cut} ${o.window.from.slice(0, 10)}..${o.window.to.slice(0, 10)}` });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="FPT-Exam-${cut}-${o.window.from.slice(0, 10)}-to-${o.window.to.slice(0, 10)}.csv"`);
  res.setHeader("Cache-Control", "private, no-store");
  return res.send(body);
});

analyticsRouter.get("/items/:instrumentId/export.csv", requireAuth, requireRole("administrator", "assessor"), async (req: AuthedRequest, res) => {
  if (!isUuid(req.params.instrumentId)) return res.status(404).json({ error: "Paper not found." });
  const a = await itemAnalysis(req.params.instrumentId);
  if (!a) return res.status(404).json({ error: "Paper not found." });
  const body = csv(
    ["#", "Question id", "Type", "Bloom's", "Outcome", "Criterion", "Marks", "Answered", "Average mark", "Facility %", "Discrimination", "Zero marks", "Full marks", "Left blank", "Flags", "Question"],
    a.items.map((i) => [i.index, i.questionId, i.type, i.bloomLevel, i.eloRef, i.acRef, i.maxMark, i.answered, i.avgMark, i.facility, i.discrimination, i.zeroes, i.fullMarks, i.blank, i.flags.join("; "), i.prompt])
  );
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "analytics_exported", targetType: "instrument", targetId: req.params.instrumentId, reason: "item analysis" });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="Item-analysis-${a.instrument.version.replace(/[^\w.-]/g, "-")}.csv"`);
  res.setHeader("Cache-Control", "private, no-store");
  return res.send(body);
});
