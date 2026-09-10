import { and, eq, inArray, isNull, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { examSittings, learnerSessions, evidenceBlobs, recordingSegments, auditLog, qualifications, captureEvents } from "../db/schema.js";
import { objectStore } from "../storage/index.js";

// Block 8a: the retention rule, in code. The consent the learner accepted says
// captures and recordings are kept for 12 months after the sitting and then
// deleted, unless an appeal or investigation requires them to be held longer.
// This is what does the deleting - nightly, and by hand from the Evidence
// Archive.
//
// What goes: the image bytes of every still, and the video of every recording
// segment. What stays, permanently: every SHA-256 hash (in capture_events and
// on the segment row), the seal, the integrity report, the marks, the
// Statement of Results and the audit trail. So a purged sitting can still be
// shown to have been conducted properly and its record verified - it just no
// longer holds anyone's picture.
//
// A sitting (or one learner's session) can be put on hold, and is then never
// swept however old it is.

export const RETENTION_MONTHS = 12;

export const cutoff = (now = new Date()) => { const d = new Date(now); d.setMonth(d.getMonth() - RETENTION_MONTHS); return d; };

export interface DueSitting { id: string; name: string | null; qualificationTitle: string; endTime: string; stills: number; segments: number; bytes: number; heldSessions: number }

// Sittings whose window closed more than 12 months ago, are not on hold, and
// still hold evidence.
export async function dueForPurge(now = new Date()): Promise<DueSitting[]> {
  const rows = await db.execute(sql`
    SELECT s.id::text AS id, s.name AS name, q.title AS "qualificationTitle", s.end_time AS "endTime",
           count(DISTINCT eb.id)::int AS stills,
           count(DISTINCT rs.id) FILTER (WHERE rs.purged_at IS NULL)::int AS segments,
           (coalesce(sum(DISTINCT length(eb.bytes)), 0) + coalesce((SELECT sum(rs2.bytes) FROM recording_segments rs2 JOIN learner_sessions l2 ON l2.id = rs2.session_id WHERE l2.sitting_id = s.id AND rs2.purged_at IS NULL), 0))::bigint AS bytes,
           count(DISTINCT ls.id) FILTER (WHERE ls.evidence_hold_at IS NOT NULL)::int AS "heldSessions"
      FROM exam_sittings s
      JOIN qualifications q ON q.id = s.qualification_id
      JOIN learner_sessions ls ON ls.sitting_id = s.id
      LEFT JOIN evidence_blobs eb ON eb.session_id = ls.id
      LEFT JOIN recording_segments rs ON rs.session_id = ls.id
     WHERE s.end_time < ${cutoff(now)}
       AND s.evidence_hold_at IS NULL
     GROUP BY s.id, s.name, q.title, s.end_time
    HAVING count(DISTINCT eb.id) > 0 OR count(DISTINCT rs.id) FILTER (WHERE rs.purged_at IS NULL) > 0
     ORDER BY s.end_time`);
  return (rows.rows as (Omit<DueSitting, "bytes" | "endTime"> & { bytes: string | number; endTime: Date })[]).map((r) => ({ ...r, bytes: Number(r.bytes), endTime: new Date(r.endTime).toISOString() }));
}

export interface PurgeResult { sittings: number; stills: number; segments: number; bytesFreed: number; heldSkipped: number; details: { sittingId: string; name: string | null; stills: number; segments: number }[] }

// Deletes the evidence for one sitting, skipping any learner whose own session
// is on hold. Idempotent: running it twice frees nothing the second time.
export async function purgeSitting(sittingId: string, actorId: string | null, reason = "12-month retention rule"): Promise<{ stills: number; segments: number; bytesFreed: number; heldSkipped: number }> {
  const sessions = await db.select({ id: learnerSessions.id, hold: learnerSessions.evidenceHoldAt }).from(learnerSessions).where(eq(learnerSessions.sittingId, sittingId));
  const purgeable = sessions.filter((s) => !s.hold).map((s) => s.id);
  const heldSkipped = sessions.length - purgeable.length;
  if (!purgeable.length) return { stills: 0, segments: 0, bytesFreed: 0, heldSkipped };

  // Stills: the bytes are the row, and the hash lives on the capture event, so
  // the row goes and the evidence trail stays.
  const blobs = await db.select({ id: evidenceBlobs.id, len: sql<number>`length(${evidenceBlobs.bytes})::int` }).from(evidenceBlobs).where(inArray(evidenceBlobs.sessionId, purgeable));
  let bytesFreed = blobs.reduce((t, b) => t + b.len, 0);
  if (blobs.length) await db.delete(evidenceBlobs).where(inArray(evidenceBlobs.id, blobs.map((b) => b.id)));

  // Recording segments: the video is in object storage; the row (hash, length,
  // size, times) stays and is stamped as purged.
  const segs = await db.select().from(recordingSegments).where(and(inArray(recordingSegments.sessionId, purgeable), isNull(recordingSegments.purgedAt)));
  if (segs.length) {
    const store = await objectStore();
    for (const s of segs) {
      try { await store.delete(s.storageKey); } catch (err) { console.error("Could not delete recording segment", s.storageKey, err); }
      bytesFreed += s.bytes;
    }
    await db.update(recordingSegments).set({ purgedAt: new Date() }).where(inArray(recordingSegments.id, segs.map((s) => s.id)));
  }

  await db.update(examSittings).set({ evidencePurgedAt: new Date() }).where(eq(examSittings.id, sittingId));
  await db.insert(auditLog).values({ actorId, action: "sitting_evidence_purged", targetType: "sitting", targetId: sittingId, reason: `${reason}: ${blobs.length} still${blobs.length === 1 ? "" : "s"} and ${segs.length} recording segment${segs.length === 1 ? "" : "s"} deleted, ${Math.round(bytesFreed / 1024)} KB freed${heldSkipped ? `; ${heldSkipped} learner${heldSkipped === 1 ? "" : "s"} on hold left untouched` : ""}` });
  return { stills: blobs.length, segments: segs.length, bytesFreed, heldSkipped };
}

// The nightly sweep. dryRun reports what it would delete and touches nothing.
export async function runRetentionSweep(payload: { dryRun?: boolean } = {}): Promise<PurgeResult & { dryRun: boolean; cutoff: string }> {
  const due = await dueForPurge();
  const out: PurgeResult = { sittings: 0, stills: 0, segments: 0, bytesFreed: 0, heldSkipped: 0, details: [] };
  for (const s of due) {
    if (payload.dryRun) {
      out.sittings++; out.stills += s.stills; out.segments += s.segments; out.bytesFreed += s.bytes; out.heldSkipped += s.heldSessions;
      out.details.push({ sittingId: s.id, name: s.name, stills: s.stills, segments: s.segments });
      continue;
    }
    const r = await purgeSitting(s.id, null);
    out.sittings++; out.stills += r.stills; out.segments += r.segments; out.bytesFreed += r.bytesFreed; out.heldSkipped += r.heldSkipped;
    out.details.push({ sittingId: s.id, name: s.name, stills: r.stills, segments: r.segments });
  }
  if (!payload.dryRun && out.sittings) console.log(`Retention sweep: cleared ${out.stills} stills and ${out.segments} recording segments from ${out.sittings} sitting(s), ${Math.round(out.bytesFreed / 1048576)} MB.`);
  return { ...out, dryRun: Boolean(payload.dryRun), cutoff: cutoff().toISOString() };
}

// What the Evidence Archive shows about retention: what is coming up, what is
// on hold, and what has already gone.
export async function retentionOverview() {
  const [due, held, purged, next] = await Promise.all([
    dueForPurge(),
    db.execute(sql`
      SELECT s.id::text AS id, s.name AS name, q.title AS "qualificationTitle", s.end_time AS "endTime",
             s.evidence_hold_at AS "holdAt", s.evidence_hold_reason AS "holdReason",
             count(DISTINCT ls.id) FILTER (WHERE ls.evidence_hold_at IS NOT NULL)::int AS "heldSessions"
        FROM exam_sittings s JOIN qualifications q ON q.id = s.qualification_id
        LEFT JOIN learner_sessions ls ON ls.sitting_id = s.id
       WHERE s.evidence_hold_at IS NOT NULL OR ls.evidence_hold_at IS NOT NULL
       GROUP BY s.id, s.name, q.title, s.end_time, s.evidence_hold_at, s.evidence_hold_reason
       ORDER BY s.end_time DESC`),
    db.select({ n: sql<number>`count(*)::int` }).from(examSittings).where(isNotNull(examSittings.evidencePurgedAt)),
    db.execute(sql`
      SELECT s.id::text AS id, s.name AS name, s.end_time AS "endTime"
        FROM exam_sittings s
       WHERE s.evidence_hold_at IS NULL AND s.end_time >= ${cutoff()} AND s.end_time < ${new Date(cutoff().getTime() + 31 * 86400000)}
       ORDER BY s.end_time LIMIT 20`),
  ]);
  return {
    retentionMonths: RETENTION_MONTHS,
    cutoff: cutoff().toISOString(),
    due,
    dueBytes: due.reduce((t, d) => t + d.bytes, 0),
    onHold: held.rows as { id: string; name: string | null; qualificationTitle: string; endTime: string; holdAt: string | null; holdReason: string | null; heldSessions: number }[],
    purgedSittings: purged[0]?.n ?? 0,
    dueWithinAMonth: next.rows as { id: string; name: string | null; endTime: string }[],
  };
}

// A purged sitting keeps every hash, so the record can still be verified.
export async function hashesFor(sittingId: string) {
  const rows = await db
    .select({ sessionId: captureEvents.sessionId, type: captureEvents.type, hash: captureEvents.sha256Hash, at: captureEvents.capturedAt })
    .from(captureEvents)
    .innerJoin(learnerSessions, eq(learnerSessions.id, captureEvents.sessionId))
    .where(eq(learnerSessions.sittingId, sittingId));
  return rows;
}
