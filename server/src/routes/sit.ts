import { Router } from "express";
import { z } from "zod";
import { createHash, randomInt } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { learnerSessions, examSittings, users, qualifications, assessmentInstruments, consentRecords, evidenceBlobs, captureEvents, auditLog, sittingInvigilators } from "../db/schema.js";
import { requireAuth, requireRole, type AuthedRequest } from "../auth/middleware.js";
import { issueSessionToken } from "../auth/jwt.js";
import { encryptField, decryptField, hashIdentifier } from "../auth/crypto.js";
import { proctoringOf, recordIncident, submitSession, deadlineFor, captureRequestPending, fullRecordingOn, SEGMENT_SECONDS, SEGMENT_MAX_BYTES, SELF_RESUME_LIMIT, MIN_GAP, PHOTO_EVERY_S, SCREEN_EVERY_S, type ProctoringState } from "../proctoring/session.js";
import { recordingSegments } from "../db/schema.js";
import { objectStore } from "../storage/index.js";
import express from "express";
import { sittingEntryLimiter } from "../security/index.js";

// Block 5a - the learner's way into a proctored sitting.
//
//   POST /sit/enter { code, idNumber }           sitting code + ID number -> scoped session cookie
//   GET  /sit/:id/state                          where the learner is in the check-in
//   POST /sit/:id/consent { version }            accept the recording / retention terms
//   POST /sit/:id/device { camera, microphone, screen, userAgent }
//   POST /sit/:id/identity-photo { image }       webcam still (JPEG data URL), stored as evidence
//   POST /sit/:id/check-in                       consent + photo done -> checked_in (waiting room)
//
// Administrator / invigilator side (mounted under /sittings in sittings.ts):
//   POST /sittings/:id/codes { learnerIds? }     issue (or re-issue) codes; returns them once
//   GET  /sittings/:id/codes                     the codes for the print-out (audited)
//   POST /sittings/:id/learners/:learnerId/allow-reentry

export const sitRouter = Router();

export const CONSENT_VERSION = "2026-09-09";
export const CONSENT_TEXT = [
  "This is a proctored FPT Academy examination sat to the QCTO requirement.",
  "Your identity is checked against the ID number you registered with, and an identity photograph is taken before you start.",
  "While you write, your camera and your screen are captured at intervals, and leaving the exam window is recorded. An invigilator may watch you live throughout the sitting.",
  "Your answers are sealed with a tamper-evident hash when you submit. Your marks and feedback are released only once a registered assessor has signed them off.",
  "Recordings and captures are kept for 12 months after the sitting and then deleted, unless an appeal or investigation requires them to be held longer. You may ask to see your own recordings. They are never shared outside FPT Academy and its quality-assurance partners.",
  "By continuing you confirm that you are the registered learner, that you are alone with no unauthorised materials, and that you accept these conditions.",
];

// Codes: 3 groups of 4 from an alphabet without look-alikes (no 0/O, 1/I/L).
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function newSittingCode(): string {
  const g = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${g()}-${g()}-${g()}`;
}
export const normaliseCode = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(.{4})(?=.)/g, "$1-");
export const hashCode = (code: string) => createHash("sha256").update(`fpt-exam-sitting-code:${normaliseCode(code)}`).digest("hex");

// How early a learner may enter the waiting room.
const ENTRY_LEAD_MINUTES = 45;

type Precheck = {
  consentAt?: string;
  consentVersion?: string;
  deviceAt?: string;
  camera?: boolean;
  microphone?: boolean;
  screen?: boolean;
  userAgent?: string;
  identityPhotoId?: string;
  checkedInAt?: string;
};

async function loadSitting(sessionId: string) {
  const [row] = await db
    .select({ session: learnerSessions, sitting: examSittings, learner: users, qualificationTitle: qualifications.title, instrumentVersion: assessmentInstruments.version, minutes: assessmentInstruments.timeAllocationMinutes, permitted: assessmentInstruments.permittedMaterials })
    .from(learnerSessions)
    .innerJoin(examSittings, eq(examSittings.id, learnerSessions.sittingId))
    .innerJoin(users, eq(users.id, learnerSessions.learnerId))
    .innerJoin(qualifications, eq(qualifications.id, examSittings.qualificationId))
    .innerJoin(assessmentInstruments, eq(assessmentInstruments.id, examSittings.instrumentId))
    .where(eq(learnerSessions.id, sessionId));
  return row;
}

function stateOf(row: NonNullable<Awaited<ReturnType<typeof loadSitting>>>) {
  const p = (row.session.precheck ?? {}) as Precheck;
  const now = Date.now();
  const start = row.sitting.startTime.getTime();
  const end = row.sitting.endTime.getTime();
  return {
    sessionId: row.session.id,
    status: row.session.status,
    learner: { name: row.learner.name, idNumberLast4: row.learner.idNumberLast4 },
    sitting: {
      id: row.sitting.id,
      name: row.sitting.name ?? `${row.qualificationTitle} · ${row.instrumentVersion}`,
      qualificationTitle: row.qualificationTitle,
      paper: row.instrumentVersion,
      venue: row.sitting.venue,
      startTime: row.sitting.startTime.toISOString(),
      endTime: row.sitting.endTime.toISOString(),
      minutes: row.minutes,
      permittedMaterials: row.permitted,
    },
    precheck: { consent: Boolean(p.consentAt), device: Boolean(p.deviceAt), camera: p.camera ?? null, microphone: p.microphone ?? null, identityPhoto: Boolean(p.identityPhotoId), checkedIn: Boolean(p.checkedInAt) },
    consent: { version: CONSENT_VERSION, text: CONSENT_TEXT },
    window: { opensAt: new Date(start - ENTRY_LEAD_MINUTES * 60000).toISOString(), canStart: now >= start && now < end, closed: now >= end, serverTime: new Date(now).toISOString() },
  };
}

// ---- Entry -----------------------------------------------------------------------------

const enterSchema = z.object({ code: z.string().trim().min(8).max(20), idNumber: z.string().trim().regex(/^[0-9 ]{13,16}$/) });

sitRouter.post("/enter", sittingEntryLimiter, async (req, res) => {
  const parsed = enterSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter your sitting code and your 13-digit ID number." });
  const codeHash = hashCode(parsed.data.code);
  const idHash = hashIdentifier(parsed.data.idNumber.replace(/\s/g, ""));
  const [found] = await db.select({ id: learnerSessions.id }).from(learnerSessions).where(eq(learnerSessions.codeHash, codeHash));
  // One message for every failure so a code cannot be probed.
  const refuse = () => res.status(401).json({ error: "That sitting code and ID number do not match a sitting. Check both with your invigilator." });
  if (!found) return refuse();
  const row = await loadSitting(found.id);
  if (!row || row.learner.idNumberHash !== idHash) return refuse();
  if (row.learner.status === "suspended" || row.learner.status === "archived") return refuse();

  const now = Date.now();
  const opens = row.sitting.startTime.getTime() - ENTRY_LEAD_MINUTES * 60000;
  if (now < opens) return res.status(403).json({ error: `This sitting opens for check-in at ${new Date(opens).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", dateStyle: "medium", timeStyle: "short" })}.`, opensAt: new Date(opens).toISOString() });
  if (now >= row.sitting.endTime.getTime()) return res.status(403).json({ error: "This sitting has ended." });
  if (row.session.status === "submitted" || row.session.status === "sealed") return res.status(403).json({ error: "This exam has already been submitted." });
  if (row.session.entries > 0 && !row.session.reentryAllowed) {
    return res.status(403).json({ error: "This code has already been used. Ask your invigilator to allow you back in.", reentry: true });
  }

  await db
    .update(learnerSessions)
    .set({ entries: row.session.entries + 1, reentryAllowed: false })
    .where(eq(learnerSessions.id, row.session.id));
  await db.insert(auditLog).values({ actorId: row.learner.id, action: row.session.entries > 0 ? "sitting_reentered" : "sitting_entered", targetType: "session", targetId: row.session.id, reason: `entry ${row.session.entries + 1}` });

  // Cookie scoped to this exam session; expires an hour after the sitting ends.
  const ttl = Math.max(600, Math.round((row.sitting.endTime.getTime() + 3600000 - now) / 1000));
  const token = issueSessionToken({ sub: row.learner.id, roles: ["learner"], sittingSession: row.session.id }, ttl);
  res.cookie("fpt_session", token, { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", maxAge: ttl * 1000 });
  return res.json(stateOf({ ...row, session: { ...row.session, entries: row.session.entries + 1 } }));
});

// A learner may act only on the session their code opened (or, for the
// legacy password sign-in, on their own sessions).
async function ownSession(req: AuthedRequest, sessionId: string) {
  if (req.auth!.sittingSession && req.auth!.sittingSession !== sessionId) return null;
  const row = await loadSitting(sessionId);
  if (!row || row.learner.id !== req.auth!.userId) return null;
  return row;
}

sitRouter.get("/:id/state", requireAuth, requireRole("learner"), async (req: AuthedRequest, res) => {
  const row = await ownSession(req, req.params.id);
  if (!row) return res.status(404).json({ error: "Sitting not found." });
  return res.json(stateOf(row));
});

async function patchPrecheck(sessionId: string, current: unknown, patch: Partial<Precheck>) {
  const next = { ...((current ?? {}) as Precheck), ...patch };
  await db.update(learnerSessions).set({ precheck: next }).where(eq(learnerSessions.id, sessionId));
  return next;
}

sitRouter.post("/:id/consent", requireAuth, requireRole("learner"), async (req: AuthedRequest, res) => {
  const parsed = z.object({ version: z.string(), accepted: z.literal(true) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "You need to accept the conditions to continue." });
  const row = await ownSession(req, req.params.id);
  if (!row) return res.status(404).json({ error: "Sitting not found." });
  if (parsed.data.version !== CONSENT_VERSION) return res.status(409).json({ error: "The conditions have been updated - please read them again.", consent: { version: CONSENT_VERSION, text: CONSENT_TEXT } });
  const [consent] = await db
    .insert(consentRecords)
    .values({ learnerId: row.learner.id, sittingId: row.sitting.id, consentTextVersion: CONSENT_VERSION, ipAddress: req.ip ?? null })
    .returning();
  await db.update(learnerSessions).set({ consentRecordId: consent.id }).where(eq(learnerSessions.id, row.session.id));
  await patchPrecheck(row.session.id, row.session.precheck, { consentAt: new Date().toISOString(), consentVersion: CONSENT_VERSION });
  return res.json(stateOf((await loadSitting(row.session.id))!));
});

sitRouter.post("/:id/device", requireAuth, requireRole("learner"), async (req: AuthedRequest, res) => {
  const parsed = z.object({ camera: z.boolean(), microphone: z.boolean(), screen: z.boolean().optional(), userAgent: z.string().max(400).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body." });
  const row = await ownSession(req, req.params.id);
  if (!row) return res.status(404).json({ error: "Sitting not found." });
  await patchPrecheck(row.session.id, row.session.precheck, { deviceAt: new Date().toISOString(), camera: parsed.data.camera, microphone: parsed.data.microphone, screen: parsed.data.screen, userAgent: parsed.data.userAgent });
  return res.json(stateOf((await loadSitting(row.session.id))!));
});

// Stores a JPEG still from the webcam as evidence of who sat down.
export async function storeEvidence(sessionId: string, kind: "identity_photo" | "photo" | "screen", dataUrl: string, maxBytes = 600 * 1024) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new Error("Expected a JPEG/PNG/WebP image.");
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length > maxBytes) throw new Error(`Image too large (${Math.round(bytes.length / 1024)} KB; limit ${Math.round(maxBytes / 1024)} KB).`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const [blob] = await db.insert(evidenceBlobs).values({ sessionId, kind, mime: m[1], bytes, sha256 }).returning({ id: evidenceBlobs.id });
  await db.insert(captureEvents).values({ sessionId, type: kind, storageRef: `blob:${blob.id}`, sha256Hash: sha256 });
  return blob.id;
}

sitRouter.post("/:id/identity-photo", requireAuth, requireRole("learner"), async (req: AuthedRequest, res) => {
  const parsed = z.object({ image: z.string().min(100).max(1_200_000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "No photo received." });
  const row = await ownSession(req, req.params.id);
  if (!row) return res.status(404).json({ error: "Sitting not found." });
  if (row.session.status !== "scheduled" && row.session.status !== "checked_in") return res.status(400).json({ error: "The exam has already started." });
  try {
    const id = await storeEvidence(row.session.id, "identity_photo", parsed.data.image);
    await patchPrecheck(row.session.id, row.session.precheck, { identityPhotoId: id, camera: true });
    return res.json(stateOf((await loadSitting(row.session.id))!));
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

sitRouter.post("/:id/check-in", requireAuth, requireRole("learner"), async (req: AuthedRequest, res) => {
  const row = await ownSession(req, req.params.id);
  if (!row) return res.status(404).json({ error: "Sitting not found." });
  const p = (row.session.precheck ?? {}) as Precheck;
  if (!p.consentAt) return res.status(400).json({ error: "Accept the conditions first." });
  if (!p.identityPhotoId) return res.status(400).json({ error: "Take your identity photo first." });
  if (row.session.status === "scheduled") {
    await db.update(learnerSessions).set({ status: "checked_in", checkInTime: new Date() }).where(eq(learnerSessions.id, row.session.id));
    await patchPrecheck(row.session.id, row.session.precheck, { checkedInAt: new Date().toISOString() });
    await db.insert(auditLog).values({ actorId: row.learner.id, action: "sitting_checked_in", targetType: "session", targetId: row.session.id });
  }
  return res.json(stateOf((await loadSitting(row.session.id))!));
});

// Serve an evidence image to staff (admin / assigned invigilator / assessor).
// Block 8c: the learner may see their own captures once the paper is submitted
// (the consent text promises it) - signed in with their account, never with a
// sitting-code cookie.
async function learnerOwnsSubmitted(req: AuthedRequest, sessionId: string) {
  if (req.auth!.sittingSession) return false;
  const [s] = await db.select({ learnerId: learnerSessions.learnerId, status: learnerSessions.status }).from(learnerSessions).where(eq(learnerSessions.id, sessionId));
  return Boolean(s && s.learnerId === req.auth!.userId && (s.status === "submitted" || s.status === "sealed"));
}

sitRouter.get("/evidence/:blobId", requireAuth, requireRole("administrator", "invigilator", "assessor", "learner"), async (req: AuthedRequest, res) => {
  const [blob] = await db.select().from(evidenceBlobs).where(eq(evidenceBlobs.id, req.params.blobId));
  if (!blob) return res.status(404).json({ error: "Not found." });
  if (req.auth!.roles.includes("learner") && !req.auth!.roles.includes("administrator")) {
    if (!(await learnerOwnsSubmitted(req, blob.sessionId))) return res.status(403).json({ error: "Not yours." });
  } else if (!req.auth!.roles.includes("administrator")) {
    const [s] = await db.select({ sittingId: learnerSessions.sittingId }).from(learnerSessions).where(eq(learnerSessions.id, blob.sessionId));
    const [sit] = s ? await db.select().from(examSittings).where(eq(examSittings.id, s.sittingId)) : [];
    const isAssessor = sit?.assignedAssessorId === req.auth!.userId;
    const [inv] = sit ? await db.select().from(sittingInvigilators).where(and(eq(sittingInvigilators.sittingId, sit.id), eq(sittingInvigilators.invigilatorId, req.auth!.userId))) : [];
    if (!isAssessor && !inv) return res.status(403).json({ error: "Not your sitting." });
  }
  res.setHeader("Content-Type", blob.mime);
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(blob.bytes);
});

// ---- Staff side: issue codes, print, re-entry -----------------------------------------------

export async function issueCodes(sittingId: string, actorId: string, learnerIds?: string[], reissue = false) {
  const rows = await db
    .select({ id: learnerSessions.id, learnerId: learnerSessions.learnerId, codeHash: learnerSessions.codeHash, status: learnerSessions.status })
    .from(learnerSessions)
    .where(and(eq(learnerSessions.sittingId, sittingId), learnerIds?.length ? inArray(learnerSessions.learnerId, learnerIds) : undefined));
  let issued = 0;
  for (const r of rows) {
    if (r.codeHash && !reissue) continue;
    if (r.status === "submitted" || r.status === "sealed") continue;
    const code = newSittingCode();
    await db.update(learnerSessions).set({ codeEnc: encryptField(code), codeHash: hashCode(code), codeIssuedAt: new Date(), entries: 0, reentryAllowed: false }).where(eq(learnerSessions.id, r.id));
    issued++;
  }
  await db.insert(auditLog).values({ actorId, action: reissue ? "sitting_codes_reissued" : "sitting_codes_issued", targetType: "sitting", targetId: sittingId, reason: `${issued} code(s)` });
  return { issued, total: rows.length };
}

export async function codesForPrint(sittingId: string) {
  const rows = await db
    .select({ sessionId: learnerSessions.id, name: users.name, idNumberLast4: users.idNumberLast4, studentNumber: users.studentNumber, codeEnc: learnerSessions.codeEnc, entries: learnerSessions.entries, status: learnerSessions.status })
    .from(learnerSessions)
    .innerJoin(users, eq(users.id, learnerSessions.learnerId))
    .where(eq(learnerSessions.sittingId, sittingId))
    .orderBy(users.name);
  return rows.map((r) => ({ sessionId: r.sessionId, name: r.name, idNumberLast4: r.idNumberLast4, studentNumber: r.studentNumber, code: r.codeEnc ? decryptField(r.codeEnc) : null, entries: r.entries, status: r.status }));
}

// ---- Block 5b: the locked paper ---------------------------------------------------------------


async function saveProctoring(sessionId: string, p: ProctoringState) {
  await db.update(learnerSessions).set({ proctoring: p }).where(eq(learnerSessions.id, sessionId));
}

// The room's view of the session: clock, lock state, capture cadence.
export function roomStateOf(row: NonNullable<Awaited<ReturnType<typeof loadSitting>>>) {
  const p = proctoringOf(row.session.proctoring);
  const deadline = deadlineFor(row.session.startedAt, row.minutes, row.session.extraMinutes, row.sitting.endTime);
  return {
    sessionId: row.session.id,
    status: row.session.status,
    startedAt: row.session.startedAt?.toISOString() ?? null,
    deadline: deadline.toISOString(),
    serverTime: new Date().toISOString(),
    extraMinutes: row.session.extraMinutes,
    locked: Boolean(p.lockedAt),
    lockReason: p.lockReason ?? null,
    requiresInvigilator: Boolean(p.requiresInvigilator),
    locks: p.locks,
    selfResumesLeft: Math.max(0, SELF_RESUME_LIMIT - p.locks),
    cadence: { photoEverySeconds: PHOTO_EVERY_S, screenEverySeconds: SCREEN_EVERY_S },
    counts: { photos: p.photos, screens: p.screens, focusLosses: p.focusLosses, pasteAttempts: p.pasteAttempts },
    sealHash: row.session.sealHash,
    // Block 5c: messages from the invigilator not yet shown, and whether the
    // invigilator has asked for a capture now.
    notes: (p.notes ?? []).filter((n) => !n.seenAt).map((n) => ({ id: n.id, text: n.text, at: n.at })),
    captureRequested: captureRequestPending(p),
    // Block 8b: whether this sitting is recorded in full, and the segment length.
    fullRecording: fullRecordingOn(row.sitting.proctoringProfile),
    segmentSeconds: SEGMENT_SECONDS,
  };
}

// The room polls this every few seconds while the paper is open; it doubles
// as the heartbeat the console uses to show who is still connected.
sitRouter.get("/:id/room", requireAuth, requireRole("learner"), async (req: AuthedRequest, res) => {
  const row = await ownSession(req, req.params.id);
  if (!row) return res.status(404).json({ error: "Sitting not found." });
  if (row.session.status === "in_progress") {
    const p = proctoringOf(row.session.proctoring);
    if (!p.lastSeenAt || Date.now() - new Date(p.lastSeenAt).getTime() > 10_000) {
      p.lastSeenAt = new Date().toISOString();
      await saveProctoring(row.session.id, p);
      row.session.proctoring = p;
    }
  }
  return res.json({ ...stateOf(row), room: roomStateOf(row) });
});

// Something happened in the learner's browser. Focus loss and leaving full
// screen lock the paper; the learner can put it back SELF_RESUME_LIMIT times,
// after that an invigilator has to.
const eventSchema = z.object({
  type: z.enum(["focus_loss", "focus_return", "fullscreen_exit", "fullscreen_enter", "visibility_hidden", "paste_attempt", "copy_attempt", "screen_share", "screen_share_lost", "camera_lost", "camera_back", "devtools", "resize", "note_seen"]),
  detail: z.record(z.string(), z.unknown()).optional(),
});

sitRouter.post("/:id/event", requireAuth, requireRole("learner"), async (req: AuthedRequest, res) => {
  const parsed = eventSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid event." });
  const row = await ownSession(req, req.params.id);
  if (!row) return res.status(404).json({ error: "Sitting not found." });
  if (row.session.status !== "in_progress") return res.json({ room: roomStateOf(row) });
  const p = proctoringOf(row.session.proctoring);
  const { type, detail = {} } = parsed.data;
  const lockIt = (reason: string) => {
    if (!p.lockedAt) {
      p.locks += 1;
      p.lockedAt = new Date().toISOString();
      p.lockReason = reason;
      p.requiresInvigilator = p.locks > SELF_RESUME_LIMIT;
    }
  };
  switch (type) {
    case "focus_loss":
    case "visibility_hidden":
      p.focusLosses += 1;
      lockIt("You left the exam window.");
      await recordIncident(row.session.id, "focus_loss", { ...detail, locks: p.locks });
      break;
    case "fullscreen_exit":
      p.fullscreenExits += 1;
      lockIt("You left full-screen mode.");
      await recordIncident(row.session.id, "fullscreen_exit", { ...detail, locks: p.locks });
      break;
    case "paste_attempt":
    case "copy_attempt":
      p.pasteAttempts += 1;
      await recordIncident(row.session.id, type, detail);
      break;
    case "screen_share": {
      const s = String(detail.surface ?? "none");
      p.screenShare = (["monitor", "window", "browser", "none", "unsupported"].includes(s) ? s : "none") as ProctoringState["screenShare"];
      if (p.screenShare === "window" || p.screenShare === "browser") await recordIncident(row.session.id, "screen_share_partial", { surface: s });
      break;
    }
    case "screen_share_lost":
      p.screenShare = "none";
      lockIt("Screen sharing stopped.");
      await recordIncident(row.session.id, "screen_share_lost", detail);
      break;
    case "camera_lost":
      p.cameraLost = (p.cameraLost ?? 0) + 1;
      await recordIncident(row.session.id, "camera_lost", detail);
      break;
    case "devtools":
      await recordIncident(row.session.id, "devtools", detail);
      break;
    case "note_seen": {
      const n = (p.notes ?? []).find((x) => x.id === String(detail.id ?? ""));
      if (n && !n.seenAt) n.seenAt = new Date().toISOString();
      break;
    }
    default:
      break; // focus_return, fullscreen_enter, camera_back, resize: informational
  }
  p.lastSeenAt = new Date().toISOString();
  await saveProctoring(row.session.id, p);
  return res.json({ room: roomStateOf({ ...row, session: { ...row.session, proctoring: p } }) });
});

// The learner puts the paper back (re-entered full screen) - allowed while
// they have self-resumes left.
sitRouter.post("/:id/resume", requireAuth, requireRole("learner"), async (req: AuthedRequest, res) => {
  const row = await ownSession(req, req.params.id);
  if (!row) return res.status(404).json({ error: "Sitting not found." });
  const p = proctoringOf(row.session.proctoring);
  if (!p.lockedAt) return res.json({ room: roomStateOf(row) });
  if (p.requiresInvigilator) return res.status(423).json({ error: "Your paper is locked until your invigilator resumes it.", room: roomStateOf(row) });
  p.lockedAt = null;
  p.lockReason = null;
  await saveProctoring(row.session.id, p);
  await recordIncident(row.session.id, "resumed_by_learner", { locks: p.locks });
  return res.json({ room: roomStateOf({ ...row, session: { ...row.session, proctoring: p } }) });
});

// Periodic captures from the room: a webcam photo or a screen still.
sitRouter.post("/:id/capture", requireAuth, requireRole("learner"), async (req: AuthedRequest, res) => {
  const parsed = z.object({ kind: z.enum(["photo", "screen"]), image: z.string().min(100).max(1_600_000), reason: z.string().max(60).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid capture." });
  const row = await ownSession(req, req.params.id);
  if (!row) return res.status(404).json({ error: "Sitting not found." });
  if (row.session.status !== "in_progress") return res.status(409).json({ error: "The paper is not open." });
  const p = proctoringOf(row.session.proctoring);
  const last = parsed.data.kind === "photo" ? p.lastPhotoAt : p.lastScreenAt;
  // Throttle: scheduled captures no closer than MIN_GAP; a flagged capture may come any time.
  if (!parsed.data.reason && last && Date.now() - new Date(last).getTime() < MIN_GAP[parsed.data.kind] * 1000) {
    return res.status(429).json({ error: "Too soon." });
  }
  try {
    const id = await storeEvidence(row.session.id, parsed.data.kind, parsed.data.image, 900 * 1024);
    if (parsed.data.kind === "photo") { p.photos += 1; p.lastPhotoAt = new Date().toISOString(); } else { p.screens += 1; p.lastScreenAt = new Date().toISOString(); }
    if (parsed.data.reason === "requested") p.captureRequestedAt = null;
    p.lastSeenAt = new Date().toISOString();
    await saveProctoring(row.session.id, p);
    return res.json({ id, counts: { photos: p.photos, screens: p.screens } });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- Block 8b: full recording ------------------------------------------------------------------
//
//   POST /sit/:id/segment?kind=camera|screen&seq=N&startedAt=ISO&durationMs=M&pending=P   raw video/webm body
//   GET  /sit/recording/:segmentId                                                        staff playback

sitRouter.post("/:id/segment", requireAuth, requireRole("learner"), express.raw({ type: () => true, limit: SEGMENT_MAX_BYTES }), async (req: AuthedRequest, res) => {
  const q = z.object({ kind: z.enum(["camera", "screen"]), seq: z.coerce.number().int().min(0).max(100000), startedAt: z.string().datetime(), durationMs: z.coerce.number().int().min(200).max(10 * 60 * 1000), pending: z.coerce.number().int().min(0).max(1000).optional() }).safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "Invalid segment." });
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length < 100) return res.status(400).json({ error: "Empty segment." });
  const row = await ownSession(req, req.params.id);
  if (!row) return res.status(404).json({ error: "Sitting not found." });
  if (!fullRecordingOn(row.sitting.proctoringProfile)) return res.status(409).json({ error: "This sitting is not recorded in full." });
  const open = row.session.status === "in_progress";
  // The last segments may land just after submission (the browser flushes on
  // submit); they are kept and marked as arriving after the seal.
  if (!open && !(row.session.submissionTime && Date.now() - row.session.submissionTime.getTime() < 3 * 60 * 1000)) return res.status(409).json({ error: "The paper is not open." });
  const mime = (req.get("content-type") ?? "video/webm").split(";")[0] || "video/webm";
  const sha256 = createHash("sha256").update(body).digest("hex");
  const key = `recordings/${row.session.id}/${q.data.kind}/${String(q.data.seq).padStart(5, "0")}.webm`;
  const store = await objectStore();
  await store.put(key, body);
  const [seg] = await db
    .insert(recordingSegments)
    .values({ sessionId: row.session.id, kind: q.data.kind, seq: q.data.seq, startedAt: new Date(q.data.startedAt), durationMs: q.data.durationMs, bytes: body.length, mime, storageKey: key, sha256, afterSeal: !open })
    .onConflictDoNothing()
    .returning({ id: recordingSegments.id });
  if (seg && open) {
    // Part of the seal: every segment is a capture event with its hash.
    await db.insert(captureEvents).values({ sessionId: row.session.id, type: "full_recording_chunk", storageRef: `segment:${seg.id}`, sha256Hash: sha256 });
  }
  const p = proctoringOf(row.session.proctoring);
  const rec = p.recording ?? { camera: 0, screen: 0, bytes: 0 };
  if (seg) { rec[q.data.kind] += 1; rec.bytes += body.length; }
  rec.lastAt = new Date().toISOString();
  rec.pending = q.data.pending ?? 0;
  p.recording = rec;
  p.lastSeenAt = new Date().toISOString();
  await saveProctoring(row.session.id, p);
  return res.json({ id: seg?.id ?? null, duplicate: !seg, recording: rec });
});

// Serve a segment to staff (administrator / the sitting's invigilator / assessor of record).
sitRouter.get("/recording/:segmentId", requireAuth, requireRole("administrator", "invigilator", "assessor", "learner"), async (req: AuthedRequest, res) => {
  const [seg] = await db.select().from(recordingSegments).where(eq(recordingSegments.id, req.params.segmentId));
  if (!seg) return res.status(404).json({ error: "Not found." });
  if (req.auth!.roles.includes("learner") && !req.auth!.roles.includes("administrator")) {
    if (!(await learnerOwnsSubmitted(req, seg.sessionId))) return res.status(403).json({ error: "Not yours." });
  } else if (!req.auth!.roles.includes("administrator")) {
    const [s] = await db.select({ sittingId: learnerSessions.sittingId }).from(learnerSessions).where(eq(learnerSessions.id, seg.sessionId));
    const [sit] = s ? await db.select().from(examSittings).where(eq(examSittings.id, s.sittingId)) : [];
    const isAssessor = sit?.assignedAssessorId === req.auth!.userId;
    const [inv] = sit ? await db.select().from(sittingInvigilators).where(and(eq(sittingInvigilators.sittingId, sit.id), eq(sittingInvigilators.invigilatorId, req.auth!.userId))) : [];
    if (!isAssessor && !inv) return res.status(403).json({ error: "Not your sitting." });
  }
  const store = await objectStore();
  const bytes = await store.get(seg.storageKey);
  if (!bytes) return res.status(410).json({ error: "This segment has been deleted under the retention rule." });
  res.setHeader("Content-Type", seg.mime);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("Accept-Ranges", "bytes");
  const range = req.get("range");
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
    res.setHeader("Content-Length", String(end - start + 1));
    return res.end(bytes.subarray(start, end + 1));
  }
  res.setHeader("Content-Length", String(bytes.length));
  return res.end(bytes);
});

export async function segmentsFor(sessionId: string) {
  const rows = await db.select().from(recordingSegments).where(eq(recordingSegments.sessionId, sessionId)).orderBy(recordingSegments.kind, recordingSegments.seq);
  return rows.map((r) => ({ id: r.id, kind: r.kind as "camera" | "screen", seq: r.seq, startedAt: r.startedAt.toISOString(), durationMs: r.durationMs, bytes: r.bytes, afterSeal: r.afterSeal, sha256: r.sha256, purgedAt: r.purgedAt?.toISOString() ?? null }));
}

// ---- Staff: resume a locked paper, submit on the learner's behalf, extra time --------------

export async function staffResume(sessionId: string, actorId: string) {
  const [s] = await db.select().from(learnerSessions).where(eq(learnerSessions.id, sessionId));
  if (!s) return null;
  const p = proctoringOf(s.proctoring);
  p.lockedAt = null;
  p.lockReason = null;
  p.requiresInvigilator = false;
  p.resumedBy = [...(p.resumedBy ?? []), actorId];
  await saveProctoring(s.id, p);
  await recordIncident(s.id, "resumed_by_invigilator", { actionTaken: "resumed" }, actorId);
  return p;
}

// Block 5c: console actions on one learner's paper.

export async function staffNote(sessionId: string, actorId: string, text: string) {
  const [s] = await db.select().from(learnerSessions).where(eq(learnerSessions.id, sessionId));
  if (!s) return null;
  const p = proctoringOf(s.proctoring);
  const note = { id: randomInt(1e9).toString(36) + Date.now().toString(36), text, at: new Date().toISOString() };
  p.notes = [...(p.notes ?? []), note].slice(-20);
  await saveProctoring(s.id, p);
  await recordIncident(s.id, "note_to_learner", { actionTaken: text }, actorId);
  return note;
}

export async function staffRequestCapture(sessionId: string, actorId: string) {
  const [s] = await db.select().from(learnerSessions).where(eq(learnerSessions.id, sessionId));
  if (!s) return null;
  const p = proctoringOf(s.proctoring);
  p.captureRequestedAt = new Date().toISOString();
  await saveProctoring(s.id, p);
  await db.insert(auditLog).values({ actorId, action: "session_capture_requested", targetType: "session", targetId: s.id });
  return p;
}

export async function staffIncident(sessionId: string, actorId: string, type: string, note: string | undefined) {
  const [s] = await db.select().from(learnerSessions).where(eq(learnerSessions.id, sessionId));
  if (!s) return null;
  const evId = await recordIncident(s.id, type, { actionTaken: note ?? null }, actorId);
  // A flagged capture pair goes with every observation so the evidence shows what was seen.
  const p = proctoringOf(s.proctoring);
  p.captureRequestedAt = new Date().toISOString();
  await saveProctoring(s.id, p);
  return evId;
}

export { submitSession };
