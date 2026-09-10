import { Router } from "express";
import { z } from "zod";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { cohorts, fptstaffResultPushes, backgroundJobs } from "../db/schema.js";
import { requireAuth, requireRole, type AuthedRequest } from "../auth/middleware.js";
import { appBaseUrl } from "../auth/setupLinks.js";
import { fptstaffConnection, probeFptstaff, listSections, FptstaffError, isFptstaffConfigured } from "../integrations/fptstaff/client.js";
import { pullSection, pullStaff, queuePendingResultPushes, queueAllUnpushedLearners, unpushedLearnerCount } from "../integrations/fptstaff/sync.js";

// Block 6: the FPTStaff connection as the Administrator works it.
//
//   GET  /fptstaff/status[?probe=1]        connected / sample / host; with probe a live test
//   GET  /fptstaff/sections                FPTStaff's sections, each with the cohort here that mirrors it
//   POST /fptstaff/pull-sections           { sectionIds[], sendSetupLinks? } -> one cohort per section, learners created / updated / matched
//   POST /fptstaff/pull-staff              { sendSetupLinks? } -> assessors and invigilators
//   POST /fptstaff/push-learners           queue every learner here without an FPTStaff id
//   POST /fptstaff/push-results            { sessionIds? } queue every undelivered result (or the named ones)
//   GET  /fptstaff/pushes                  delivery state of results and people

export const fptstaffRouter = Router();
const admin = [requireAuth, requireRole("administrator")] as const;

fptstaffRouter.get("/status", ...admin, async (req, res) => {
  const conn = fptstaffConnection();
  const pending = (await db.select({ n: sql<number>`count(*)::int` }).from(fptstaffResultPushes).where(sql`${fptstaffResultPushes.status} <> 'sent'`))[0].n;
  const unpushed = await unpushedLearnerCount();
  if (req.query.probe) return res.json({ ...conn, pendingResults: pending, unpushedLearners: unpushed, probe: await probeFptstaff() });
  res.json({ ...conn, pendingResults: pending, unpushedLearners: unpushed });
});

const notConnected = (res: import("express").Response) => res.status(503).json({ error: "FPTStaff is not connected yet.", detail: "Set FPTSTAFF_BASE_URL and FPTSTAFF_API_KEY in the Repl's Secrets (or FPTSTAFF_MOCK=yes to work with the sample)." });

fptstaffRouter.get("/sections", ...admin, async (_req, res) => {
  if (!isFptstaffConfigured()) return notConnected(res);
  try {
    const sections = await listSections();
    const mirrored = await db.select({ id: cohorts.id, name: cohorts.name, sectionId: cohorts.fptstaffSectionId, updatedAt: cohorts.updatedAt, members: sql<number>`(SELECT count(*)::int FROM cohort_members cm WHERE cm.cohort_id = ${cohorts.id})` }).from(cohorts).where(sql`${cohorts.fptstaffSectionId} IS NOT NULL`);
    const byId = new Map(mirrored.map((m) => [m.sectionId!, m]));
    return res.json(sections.map((s) => ({ ...s, cohort: byId.get(s.id) ? { id: byId.get(s.id)!.id, name: byId.get(s.id)!.name, members: byId.get(s.id)!.members, pulledAt: byId.get(s.id)!.updatedAt.toISOString() } : null })));
  } catch (err) {
    if (err instanceof FptstaffError) return res.status(502).json({ error: "FPTStaff could not be read.", detail: err.message });
    throw err;
  }
});

fptstaffRouter.post("/pull-sections", ...admin, async (req: AuthedRequest, res) => {
  const parsed = z.object({ sectionIds: z.array(z.string().min(1)).min(1).max(50), sendSetupLinks: z.boolean().default(true) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose at least one section." });
  if (!isFptstaffConfigured()) return notConnected(res);
  const results = [];
  try {
    for (const id of parsed.data.sectionIds) results.push(await pullSection(id, req.auth!.userId, appBaseUrl(req), parsed.data.sendSetupLinks));
  } catch (err) {
    if (err instanceof FptstaffError) return res.status(502).json({ error: "FPTStaff could not be read.", detail: err.message, done: results });
    throw err;
  }
  return res.json({ sections: results });
});

fptstaffRouter.post("/pull-staff", ...admin, async (req: AuthedRequest, res) => {
  const parsed = z.object({ sendSetupLinks: z.boolean().default(true) }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body." });
  if (!isFptstaffConfigured()) return notConnected(res);
  try {
    return res.json(await pullStaff(req.auth!.userId, appBaseUrl(req), parsed.data.sendSetupLinks));
  } catch (err) {
    if (err instanceof FptstaffError) return res.status(502).json({ error: "FPTStaff could not be read.", detail: err.message });
    throw err;
  }
});

fptstaffRouter.post("/push-learners", ...admin, async (_req, res) => {
  if (!isFptstaffConfigured()) return notConnected(res);
  return res.json({ queued: await queueAllUnpushedLearners() });
});

fptstaffRouter.post("/push-results", ...admin, async (req, res) => {
  const parsed = z.object({ sessionIds: z.array(z.string().uuid()).max(5000).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body." });
  if (!isFptstaffConfigured()) return notConnected(res);
  return res.json({ queued: await queuePendingResultPushes(parsed.data.sessionIds) });
});

fptstaffRouter.get("/pushes", ...admin, async (_req, res) => {
  const results = await db.select({ status: fptstaffResultPushes.status, n: sql<number>`count(*)::int` }).from(fptstaffResultPushes).groupBy(fptstaffResultPushes.status);
  const learnerJobs = await db
    .select({ status: backgroundJobs.status, result: backgroundJobs.result, createdAt: backgroundJobs.createdAt })
    .from(backgroundJobs)
    .where(eq(backgroundJobs.jobType, "fptstaff_learner_push"))
    .orderBy(desc(backgroundJobs.createdAt))
    .limit(20);
  return res.json({ results: Object.fromEntries(results.map((r) => [r.status, r.n])), recentLearnerPushes: learnerJobs });
});
