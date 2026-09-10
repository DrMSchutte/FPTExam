import { Router } from "express";
import { z } from "zod";
import { and, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { auditLog, users, notificationLog } from "../db/schema.js";
import { requireAuth, requireRole, type AuthedRequest } from "../auth/middleware.js";
import { healthSnapshot, recentNotifications, runReminderSweep, sendPending, remindersOff, OVERDUE_DAYS } from "../notify/index.js";
import { retentionOverview, runRetentionSweep, purgeSitting } from "../retention/index.js";
import { csv } from "../results/portfolio.js";
import { labelFor } from "../results/evidencePack.js";

// Blocks 8e and 8a: the Administrator's operational screens - what the system
// is telling people, what needs attention, what the retention rule is about to
// delete, and the audit trail.

export const adminRouter = Router();
const admin = [requireAuth, requireRole("administrator")] as const;

// ---- 8e: reminders and health -------------------------------------------------

adminRouter.get("/health", ...admin, async (_req: AuthedRequest, res) => {
  return res.json({ ...(await healthSnapshot()), remindersOff: remindersOff(), overdueDays: OVERDUE_DAYS });
});

adminRouter.get("/notifications", ...admin, async (req: AuthedRequest, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60));
  const rows = await recentNotifications(limit);
  const [counts] = await db.select({
    sent: sql<number>`count(*) FILTER (WHERE ${notificationLog.status} = 'sent')::int`,
    notConnected: sql<number>`count(*) FILTER (WHERE ${notificationLog.status} = 'not_connected')::int`,
    failed: sql<number>`count(*) FILTER (WHERE ${notificationLog.status} = 'failed')::int`,
    pending: sql<number>`count(*) FILTER (WHERE ${notificationLog.status} = 'pending')::int`,
  }).from(notificationLog);
  return res.json({
    remindersOff: remindersOff(),
    counts,
    rows: rows.map((r) => ({ id: r.id, kind: r.kind, toEmail: r.toEmail, subject: r.subject, body: r.body, status: r.status, detail: r.detail, createdAt: r.createdAt.toISOString(), sentAt: r.sentAt?.toISOString() ?? null })),
  });
});

// "Run the reminders now": works out what is due today whatever the hour, then
// sends whatever is waiting. Safe to press twice - each reminder is once-only.
adminRouter.post("/notifications/run-now", ...admin, async (req: AuthedRequest, res) => {
  const sweep = await runReminderSweep({ force: true });
  const sent = await sendPending();
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "reminders_run_by_hand", targetType: "system", reason: `${sweep.queued} queued, ${sent.sent} sent, ${sent.notConnected} held back (email not connected), ${sent.failed} failed` });
  return res.json({ sweep, sent });
});

// ---- 8a: retention ------------------------------------------------------------

adminRouter.get("/retention", ...admin, async (_req: AuthedRequest, res) => {
  return res.json(await retentionOverview());
});

adminRouter.post("/retention/sweep", ...admin, async (req: AuthedRequest, res) => {
  const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
  const r = await runRetentionSweep({ dryRun });
  if (!dryRun) await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "retention_sweep_by_hand", targetType: "system", reason: `${r.sittings} sitting(s), ${r.stills} stills and ${r.segments} recording segments deleted` });
  return res.json(r);
});

adminRouter.post("/retention/purge/:sittingId", ...admin, async (req: AuthedRequest, res) => {
  const parsed = z.object({ reason: z.string().trim().min(4).max(300) }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Say why this sitting's evidence is being deleted now." });
  const r = await purgeSitting(req.params.sittingId, req.auth!.userId, parsed.data.reason);
  return res.json(r);
});

// ---- 8a: the audit trail ------------------------------------------------------
//
// Everything the system recorded, newest first, filterable, exportable. The
// trail itself is never editable or deletable through the application.

const auditQuery = z.object({
  q: z.string().trim().max(120).optional(),
  action: z.string().trim().max(80).optional(),
  actorId: z.string().uuid().optional(),
  targetId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

async function auditRows(p: z.infer<typeof auditQuery>, limit: number, offset: number) {
  const conds = [];
  if (p.action) conds.push(ilike(auditLog.action, `%${p.action}%`));
  if (p.actorId) conds.push(eq(auditLog.actorId, p.actorId));
  if (p.targetId) conds.push(eq(auditLog.targetId, p.targetId));
  if (p.from) conds.push(gte(auditLog.occurredAt, new Date(p.from)));
  if (p.to) conds.push(lte(auditLog.occurredAt, new Date(p.to)));
  if (p.q) conds.push(or(ilike(auditLog.action, `%${p.q}%`), ilike(auditLog.reason, `%${p.q}%`), ilike(users.name, `%${p.q}%`), ilike(auditLog.targetType, `%${p.q}%`))!);
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db
    .select({ a: auditLog, actorName: users.name, actorEmail: users.email })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(where)
    .orderBy(desc(auditLog.occurredAt))
    .limit(limit)
    .offset(offset);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLog).leftJoin(users, eq(users.id, auditLog.actorId)).where(where);
  return { rows, total: n };
}

adminRouter.get("/audit", ...admin, async (req: AuthedRequest, res) => {
  const parsed = auditQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid filter.", detail: parsed.error.message });
  const limit = parsed.data.limit ?? 100, offset = parsed.data.offset ?? 0;
  const { rows, total } = await auditRows(parsed.data, limit, offset);
  const actions = await db.select({ action: auditLog.action, n: sql<number>`count(*)::int` }).from(auditLog).groupBy(auditLog.action).orderBy(desc(sql`count(*)`)).limit(60);
  return res.json({
    total, limit, offset,
    actions: actions.map((a) => ({ action: a.action, label: labelFor(a.action), n: a.n })),
    rows: rows.map(({ a, actorName, actorEmail }) => ({
      id: a.id, at: a.occurredAt.toISOString(), action: a.action, label: labelFor(a.action),
      actor: actorName ?? (a.actorId ? "(deleted account)" : "the system"), actorEmail: actorEmail ?? null,
      targetType: a.targetType, targetId: a.targetId, reason: a.reason,
    })),
  });
});

adminRouter.get("/audit.csv", ...admin, async (req: AuthedRequest, res) => {
  const parsed = auditQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Invalid filter." });
  const { rows } = await auditRows(parsed.data, 20000, 0);
  const body = csv(["When", "Actor", "Email", "Action", "Description", "Target type", "Target id", "Detail"], rows.map(({ a, actorName, actorEmail }) => [a.occurredAt.toISOString(), actorName ?? "the system", actorEmail ?? "", a.action, labelFor(a.action), a.targetType, a.targetId, a.reason]));
  await db.insert(auditLog).values({ actorId: req.auth!.userId, action: "audit_trail_exported", targetType: "system", reason: `${rows.length} entries` });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="FPT-Exam-audit-trail-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader("Cache-Control", "private, no-store");
  return res.send(body);
});
