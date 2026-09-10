import { asc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { learnerSessions, examSittings, assessmentInstruments, qualifications, users, sittingInvigilators, consentRecords, captureEvents, evidenceBlobs, recordingSegments, incidentLog, auditLog, assessorDecisions } from "../db/schema.js";
import { decryptField } from "../auth/crypto.js";
import { integrityReportFor, MANUAL_INCIDENTS, type IntegritySummary } from "../proctoring/integrity.js";
import { fullRecordingOn, SEGMENT_SECONDS } from "../proctoring/session.js";
import { statementNumberFor } from "./statement.js";
import { report, fmtDate, fmtTime, fmtTimeS, fmtDateTime, kb, INK, MUTED, GREEN, BLUE, AMBER, RED, LINE } from "./pdf.js";

// Block 8c: the evidence pack - one learner's sitting, complete, in the form
// a moderator, verifier or the QCTO can take away: who sat, under what
// conditions, everything the room recorded (identity photo, every still,
// every recording segment with its hash), every incident and staff action in
// order, the integrity summary, the seal, and the result if it has been
// released. Rendered from the sealed record on demand - there is no copy to go
// stale - and every download is written to the audit trail.

export const INCIDENT_LABEL: Record<string, string> = {
  focus_loss: "Left the exam window", fullscreen_exit: "Left full screen", paste_attempt: "Paste attempt", copy_attempt: "Copy attempt",
  screen_share_partial: "Sharing only part of the screen", screen_share_lost: "Screen sharing stopped", camera_lost: "Camera stopped", devtools: "Developer tools shortcut",
  resumed_by_learner: "Returned to the exam", resumed_by_invigilator: "Paper released by invigilator", note_to_learner: "Message sent to learner", ended_by_invigilator: "Paper ended by invigilator",
  ...Object.fromEntries(Object.entries(MANUAL_INCIDENTS).map(([k, v]) => [k, v.title])),
};
export const ACTION_LABEL: Record<string, string> = {
  sitting_entered: "Entered with sitting code", sitting_reentered: "Re-entered with sitting code", sitting_checked_in: "Checked in", sitting_reentry_allowed: "Re-entry allowed",
  session_started: "Paper opened", session_extra_time: "Extra time granted", session_submitted: "Submitted by learner", session_auto_submitted: "Submitted by the clock", session_submitted_by_invigilator: "Submitted by invigilator",
  session_terminated: "Paper ended", session_capture_requested: "Capture requested", session_evidence_viewed: "Evidence viewed", session_recording_viewed: "Recording viewed",
  session_evidence_pack_downloaded: "Evidence pack downloaded", session_evidence_self_viewed: "Learner viewed own evidence",
};
export const labelFor = (t: string) => INCIDENT_LABEL[t] ?? ACTION_LABEL[t] ?? t.replace(/_/g, " ");

const SUBMITTED_WORD: Record<string, string> = { learner: "by the learner", time_up: "by the clock (time up)", invigilator: "by the invigilator", unknown: "—" };
const REC_WORD: Record<string, string> = { clear: "CLEAR", review: "REVIEW", investigate: "INVESTIGATE" };
const REC_COLOR: Record<string, string> = { clear: GREEN, review: AMBER, investigate: RED };

export interface EvidencePackData {
  packNumber: string;
  generatedAt: Date;
  learner: { id: string; name: string; idNumber: string | null; studentNumber: string | null; email: string };
  qualification: { title: string; saqaId: string | null; type: string };
  paper: { id: string; version: string; minutes: number; questions: number; totalMarks: number };
  sitting: { id: string; name: string | null; venue: string | null; startTime: Date; endTime: Date; fullRecording: boolean; assessorName: string; invigilators: string[] };
  session: { id: string; status: string; checkInTime: Date | null; startedAt: Date | null; submittedAt: Date | null; extraMinutes: number; entries: number; sealHash: string | null; answered: number };
  consent: { version: string | null; acceptedAt: Date | null; ip: string | null };
  precheck: { camera: boolean | null; microphone: boolean | null; screen: string | null; userAgent: string | null };
  identityPhotoId: string | null;
  captures: { id: string; blobId: string | null; kind: string; at: Date; sha256: string; bytes: number | null }[];
  segments: { id: string; kind: string; seq: number; startedAt: Date; durationMs: number; bytes: number; sha256: string; afterSeal: boolean; storageKey: string }[];
  incidents: { at: Date; type: string; detail: string | null; by: string }[];
  actions: { at: Date; type: string; detail: string | null; by: string | null }[];
  integrity: IntegritySummary | null;
  result: { outcome: string; totalMark: number; totalMax: number; percentage: number; signedOffAt: Date; assessorName: string; statementNumber: string } | null;
}

export const packNumberFor = (sessionId: string, sittingStart: Date) => `FPT-EP-${sittingStart.getFullYear()}-${sessionId.replace(/-/g, "").slice(0, 10).toUpperCase()}`;

export async function loadEvidencePack(sessionId: string): Promise<EvidencePackData | null> {
  const [row] = await db
    .select({ session: learnerSessions, sitting: examSittings, learner: users })
    .from(learnerSessions)
    .innerJoin(examSittings, eq(examSittings.id, learnerSessions.sittingId))
    .innerJoin(users, eq(users.id, learnerSessions.learnerId))
    .where(eq(learnerSessions.id, sessionId));
  if (!row) return null;
  const [instrument] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, row.sitting.instrumentId));
  const [qualification] = await db.select().from(qualifications).where(eq(qualifications.id, row.sitting.qualificationId));
  const [assessor] = await db.select({ name: users.name }).from(users).where(eq(users.id, row.sitting.assignedAssessorId));
  const invigilators = await db.select({ name: users.name }).from(sittingInvigilators).innerJoin(users, eq(users.id, sittingInvigilators.invigilatorId)).where(eq(sittingInvigilators.sittingId, row.sitting.id));
  const consent = row.session.consentRecordId ? (await db.select().from(consentRecords).where(eq(consentRecords.id, row.session.consentRecordId)))[0] : undefined;
  const caps = await db.select().from(captureEvents).where(eq(captureEvents.sessionId, sessionId)).orderBy(asc(captureEvents.capturedAt), asc(captureEvents.id));
  const blobMeta = await db.select({ id: evidenceBlobs.id, kind: evidenceBlobs.kind, createdAt: evidenceBlobs.createdAt, sha256: evidenceBlobs.sha256, len: sql<number>`length(${evidenceBlobs.bytes})::int` }).from(evidenceBlobs).where(eq(evidenceBlobs.sessionId, sessionId));
  const blobBytes = new Map(blobMeta.map((b) => [b.id, b.len]));
  const segs = await db.select().from(recordingSegments).where(eq(recordingSegments.sessionId, sessionId)).orderBy(asc(recordingSegments.kind), asc(recordingSegments.seq));
  const incidents = await db.select({ i: incidentLog, byName: users.name }).from(incidentLog).leftJoin(users, eq(users.id, incidentLog.raisedByUserId)).where(eq(incidentLog.sessionId, sessionId)).orderBy(asc(incidentLog.occurredAt));
  const actions = await db.select({ a: auditLog, byName: users.name }).from(auditLog).leftJoin(users, eq(users.id, auditLog.actorId)).where(eq(auditLog.targetId, sessionId)).orderBy(asc(auditLog.occurredAt));
  const [decision] = await db.select().from(assessorDecisions).where(eq(assessorDecisions.sessionId, sessionId));
  const decisionAssessor = decision?.signedOffAt ? (await db.select({ name: users.name }).from(users).where(eq(users.id, decision.assessorId)))[0] : undefined;
  const integrity = await integrityReportFor(sessionId);

  let idNumber: string | null = null;
  if (row.learner.idNumberEnc) { try { idNumber = decryptField(row.learner.idNumberEnc); } catch { idNumber = null; } }
  const pre = (row.session.precheck ?? {}) as { camera?: boolean; microphone?: boolean; screen?: string; userAgent?: string; identityPhotoId?: string; consentAt?: string; consentVersion?: string };
  const questions = (instrument.questions as { maxMark: number }[]) ?? [];
  const answers = (row.session.answers ?? {}) as Record<string, unknown>;
  const answered = Object.values(answers).filter((v) => v !== null && v !== undefined && String(v).trim() !== "").length;
  const totalMax = decision?.totalMax ?? questions.reduce((s, q) => s + q.maxMark, 0);

  return {
    packNumber: packNumberFor(sessionId, row.sitting.startTime),
    generatedAt: new Date(),
    learner: { id: row.learner.id, name: row.learner.name, idNumber, studentNumber: row.learner.studentNumber, email: row.learner.email },
    qualification: { title: qualification.title, saqaId: qualification.saqaQualificationId, type: qualification.qctoRegistrationType },
    paper: { id: instrument.id, version: instrument.version, minutes: instrument.timeAllocationMinutes, questions: questions.length, totalMarks: questions.reduce((s, q) => s + q.maxMark, 0) },
    sitting: { id: row.sitting.id, name: row.sitting.name, venue: row.sitting.venue, startTime: row.sitting.startTime, endTime: row.sitting.endTime, fullRecording: fullRecordingOn(row.sitting.proctoringProfile), assessorName: assessor?.name ?? "—", invigilators: invigilators.map((i) => i.name) },
    session: { id: row.session.id, status: row.session.status, checkInTime: row.session.checkInTime, startedAt: row.session.startedAt, submittedAt: row.session.submissionTime, extraMinutes: row.session.extraMinutes, entries: row.session.entries, sealHash: row.session.sealHash, answered },
    consent: { version: consent?.consentTextVersion ?? pre.consentVersion ?? null, acceptedAt: consent?.acceptedAt ?? (pre.consentAt ? new Date(pre.consentAt) : null), ip: consent?.ipAddress ?? null },
    precheck: { camera: pre.camera ?? null, microphone: pre.microphone ?? null, screen: pre.screen ?? null, userAgent: pre.userAgent ?? null },
    identityPhotoId: pre.identityPhotoId ?? null,
    captures: caps.map((c) => { const blobId = c.storageRef.startsWith("blob:") ? c.storageRef.slice(5) : null; return { id: c.id, blobId, kind: c.type, at: c.capturedAt, sha256: c.sha256Hash, bytes: blobId ? blobBytes.get(blobId) ?? null : null }; }),
    segments: segs.map((s) => ({ id: s.id, kind: s.kind, seq: s.seq, startedAt: s.startedAt, durationMs: s.durationMs, bytes: s.bytes, sha256: s.sha256, afterSeal: s.afterSeal, storageKey: s.storageKey })),
    incidents: incidents.map(({ i, byName }) => ({ at: i.occurredAt, type: i.type, detail: i.actionTaken, by: i.raisedBy === "invigilator" ? byName ?? "invigilator" : "system" })),
    actions: actions.filter(({ a }) => a.action.startsWith("sitting_") || a.action.startsWith("session_")).map(({ a, byName }) => ({ at: a.occurredAt, type: a.action, detail: a.reason, by: byName })),
    integrity,
    result: decision?.signedOffAt ? { outcome: decision.outcome ?? "not_yet_competent", totalMark: decision.totalMark ?? 0, totalMax, percentage: totalMax === 0 ? 0 : Math.round(((decision.totalMark ?? 0) / totalMax) * 1000) / 10, signedOffAt: decision.signedOffAt, assessorName: decisionAssessor?.name ?? "Registered assessor", statementNumber: statementNumberFor(sessionId, decision.signedOffAt) } : null,
  };
}

// The images the PDF embeds: identity photo + every still. Loaded separately
// so the ZIP can reuse the same bytes for its captures/ folder.
export async function loadBlobs(sessionId: string): Promise<Map<string, { mime: string; bytes: Buffer; kind: string; at: Date }>> {
  const rows = await db.select().from(evidenceBlobs).where(eq(evidenceBlobs.sessionId, sessionId));
  return new Map(rows.map((b) => [b.id, { mime: b.mime, bytes: b.bytes, kind: b.kind, at: b.createdAt }]));
}

export const captureFileName = (kind: string, at: Date, seq: number) => `${String(seq).padStart(3, "0")}-${kind}-${at.toISOString().replace(/[:.]/g, "").slice(0, 17)}.jpg`;
export const segmentFileName = (kind: string, seq: number) => `${kind}-${String(seq).padStart(5, "0")}.webm`;

const TYPE_WORD: Record<string, string> = { eisa: "QCTO EISA", fisa: "QCTO FISA", non_qcto: "Assessment" };
const SEV_COLOR: Record<string, string> = { info: MUTED, low: BLUE, medium: AMBER, high: RED };

export async function renderEvidencePack(d: EvidencePackData, blobs: Map<string, { mime: string; bytes: Buffer }>, opts: { stills?: boolean } = {}): Promise<Buffer> {
  const r = report({ title: `Evidence pack ${d.packNumber}`, headerRight: `Evidence pack ${d.packNumber}`, confidentialLine: "CONFIDENTIAL — sitting evidence. FPT Academy (Pty) Ltd and its quality-assurance partners only", subject: `${d.learner.name} · ${d.qualification.title}` });
  const { doc } = r;
  const includeStills = opts.stills !== false;

  r.title("Sitting Evidence Pack", `${d.learner.name} · ${d.qualification.title}`, `Generated ${fmtDateTime(d.generatedAt)}`);

  // 1. Who, what, where
  r.h2("1. The sitting");
  r.facts([
    ["Learner", d.learner.name], ["ID number", d.learner.idNumber ?? "—"], ["Student number", d.learner.studentNumber ?? "—"],
    ["Qualification", d.qualification.title], ["Assessment", `${TYPE_WORD[d.qualification.type] ?? d.qualification.type}${d.qualification.saqaId ? ` · SAQA ${d.qualification.saqaId}` : ""}`], ["Paper", `${d.paper.version} · ${d.paper.questions} questions · ${d.paper.totalMarks} marks · ${d.paper.minutes} min`],
    ["Sitting", `${d.sitting.name ?? "—"}`], ["When", `${fmtDate(d.sitting.startTime)}, ${fmtTime(d.sitting.startTime)}–${fmtTime(d.sitting.endTime)}`], ["Venue", d.sitting.venue ?? "Remote / not recorded"],
    ["Assessor of record", d.sitting.assessorName], ["Invigilator(s)", d.sitting.invigilators.join(", ") || "—"], ["Evidence kept", d.sitting.fullRecording ? "Full recording (camera and screen, continuous) plus stills" : "Stills (camera and screen at intervals)"],
  ]);

  // 2. Integrity
  r.h2("2. Integrity summary");
  if (d.integrity) {
    const ig = d.integrity;
    r.box(`${REC_WORD[ig.recommendation] ?? ig.recommendation.toUpperCase()} — ${ig.headline}`, REC_COLOR[ig.recommendation] ?? MUTED, `Computed at submission from the room's own record · ${ig.writingMinutes} min writing · submitted ${SUBMITTED_WORD[ig.submittedBy]}`);
    r.facts([
      ["Locks", String(ig.counts.locks)], ["Left the window", String(ig.counts.focusLosses)], ["Left full screen", String(ig.counts.fullscreenExits)], ["Paste attempts", String(ig.counts.pasteAttempts)],
      ["Camera stills", `${ig.counts.photos} of ~${ig.counts.photosExpected}`], ["Screen stills", `${ig.counts.screens} of ~${ig.counts.screensExpected}`], ["Screen shared", ig.screenShare ?? "—"], ["Identity photo", ig.identityPhoto ? "Taken" : "Missing"],
      ["Invigilator incidents", String(ig.counts.invigilatorIncidents)], ["Messages to learner", String(ig.counts.notesToLearner)], ["Entries to the room", String(ig.counts.entries)], ["Extra time", `${ig.counts.extraMinutes} min`],
    ], 4);
    if (ig.recording) r.para(`Full recording: ${ig.recording.camera} camera and ${ig.recording.screen} screen segments of ${SEGMENT_SECONDS} s (about ${ig.recording.expected} expected per stream), ${kb(ig.recording.bytes)} in total.`, { color: MUTED, size: 9 });
    if (ig.findings.length) {
      r.h3("Findings");
      r.table(["Severity", "Finding", "Detail"], ig.findings.map((f) => [f.severity.toUpperCase(), f.title + (f.count ? ` (${f.count})` : ""), f.detail]), [12, 30, 58], { tone: (row) => SEV_COLOR[row[0].toLowerCase()] ?? null });
    }
  } else {
    r.para(d.session.submittedAt ? "No integrity report was stored for this sitting." : "The paper has not been submitted; the integrity summary is computed at submission.", { color: MUTED });
  }

  // 3. Consent, identity and device
  r.h2("3. Consent, identity and device check");
  r.facts([
    ["Consent", d.consent.acceptedAt ? `Accepted ${fmtDateTime(d.consent.acceptedAt)} (text version ${d.consent.version ?? "—"})` : "Not recorded"], ["Camera", d.precheck.camera === null ? "—" : d.precheck.camera ? "Working" : "Not available"], ["Microphone", d.precheck.microphone === null ? "—" : d.precheck.microphone ? "Working" : "Not available"],
    ["Screen share", d.precheck.screen ?? "—"], ["Browser", d.precheck.userAgent ? d.precheck.userAgent.slice(0, 90) : "—"], ["Checked in", d.session.checkInTime ? fmtDateTime(d.session.checkInTime) : "—"],
  ]);
  const idBlob = d.identityPhotoId ? blobs.get(d.identityPhotoId) : undefined;
  if (idBlob) {
    r.ensure(150);
    const y = doc.y;
    try { doc.image(idBlob.bytes, r.L(), y, { fit: [170, 130] }); } catch { /* not an image pdfkit can read */ }
    doc.fillColor(MUTED).font("Helvetica").fontSize(8.5).text("Identity photograph taken at check-in, before the paper opened. Compared by the invigilator with the registered ID number.", r.L() + 182, y + 4, { width: r.CW() - 190 });
    doc.text(`SHA-256 ${d.captures.find((c) => c.blobId === d.identityPhotoId)?.sha256 ?? ""}`, r.L() + 182, y + 40, { width: r.CW() - 190 });
    doc.y = y + 140;
  }

  // 4. Timeline
  r.h2("4. What happened, in order");
  const events: { at: Date; kind: string; what: string; detail: string; by: string }[] = [];
  for (const a of d.actions) events.push({ at: a.at, kind: "Action", what: labelFor(a.type), detail: a.detail ?? "", by: a.by ?? "system" });
  for (const i of d.incidents) events.push({ at: i.at, kind: i.by === "system" ? "System" : "Invigilator", what: labelFor(i.type), detail: i.detail ?? "", by: i.by });
  events.sort((x, y) => x.at.getTime() - y.at.getTime());
  if (events.length) r.table(["Time", "Source", "Event", "Detail", "By"], events.map((e) => [fmtTimeS(e.at), e.kind, e.what, e.detail.slice(0, 220), e.by]), [12, 12, 26, 36, 14], { tone: (row) => (row[1] === "Invigilator" ? AMBER : row[1] === "System" ? BLUE : null) });
  else r.para("No events recorded.", { color: MUTED });
  r.para(`The paper opened ${d.session.startedAt ? fmtDateTime(d.session.startedAt) : "—"} and was submitted ${d.session.submittedAt ? fmtDateTime(d.session.submittedAt) : "— (not yet)"}${d.session.extraMinutes ? ` with ${d.session.extraMinutes} minutes' extra time` : ""}. ${d.session.answered} of ${d.paper.questions} questions carry an answer.`, { size: 9, color: MUTED });

  // 5. Stills
  const stills = d.captures.filter((c) => c.blobId && (c.kind === "photo" || c.kind === "screen"));
  r.h2(`5. Captures (${stills.filter((c) => c.kind === "photo").length} camera · ${stills.filter((c) => c.kind === "screen").length} screen)`);
  if (!stills.length) r.para("No stills were captured.", { color: MUTED });
  else if (!includeStills) r.para("Stills are supplied as image files in the captures/ folder of the ZIP that accompanies this pack; each is listed with its hash in section 7.", { color: MUTED });
  else {
    const cols = 4, gap = 8, cw = (r.CW() - gap * (cols - 1)) / cols, ch = cw * 0.72;
    let i = 0;
    for (const c of stills) {
      const col = i % cols;
      if (col === 0) { r.ensure(ch + 22); }
      const x = r.L() + col * (cw + gap), y = doc.y;
      const b = blobs.get(c.blobId!);
      doc.rect(x, y, cw, ch).lineWidth(0.5).strokeColor(LINE).stroke();
      if (b) { try { doc.image(b.bytes, x + 1, y + 1, { fit: [cw - 2, ch - 2], align: "center", valign: "center" }); } catch { /* skip */ } }
      doc.fillColor(MUTED).font("Helvetica").fontSize(7).text(`${c.kind === "photo" ? "Camera" : "Screen"} · ${fmtTimeS(c.at)} · ${c.sha256.slice(0, 12)}…`, x, y + ch + 3, { width: cw, lineBreak: false });
      if (col === cols - 1 || i === stills.length - 1) doc.y = y + ch + 16;
      i++;
    }
  }

  // 6. Recording
  if (d.sitting.fullRecording) {
    r.h2(`6. Full recording (${d.segments.filter((s) => s.kind === "camera").length} camera · ${d.segments.filter((s) => s.kind === "screen").length} screen segments · ${kb(d.segments.reduce((n, s) => n + s.bytes, 0))})`);
    r.para(`The browser recorded both streams continuously in self-contained ${SEGMENT_SECONDS}-second segments and uploaded each as it was made. Every segment is hashed; hashes of segments that arrived before submission are part of the seal. Segments marked "after seal" were still in the browser's upload queue at submission and landed within minutes afterwards.`, { size: 9, color: MUTED });
    if (d.segments.length) r.table(["Stream", "#", "Started", "Length", "Size", "SHA-256", "Sealed"], d.segments.map((s) => [s.kind, String(s.seq), fmtTimeS(s.startedAt), `${Math.round(s.durationMs / 1000)} s`, kb(s.bytes), s.sha256, s.afterSeal ? "after seal" : "yes"]), [8, 4, 11, 7, 8, 54, 8], { size: 6.5 });
  } else {
    r.h2("6. Full recording");
    r.para("This sitting kept stills only; no continuous recording was made.", { color: MUTED });
  }

  // 7. Seal and hashes
  r.h2("7. The seal");
  r.para(d.session.sealHash ? `Seal (SHA-256): ${d.session.sealHash}` : "Not sealed — the paper has not been submitted.", { bold: true, size: 9 });
  r.para("The seal is a SHA-256 hash over the session id, the submission time, the answers exactly as submitted (keys sorted), and the SHA-256 of every capture and recording segment stored before submission, in order of capture. Re-computing it from the stored record and comparing it with the value above proves that none of these has changed since the learner submitted.", { size: 9, color: MUTED });
  r.h3("Capture hashes");
  const hashRows = d.captures.map((c, i) => [String(i + 1), c.kind.replace(/_/g, " "), fmtTimeS(c.at), c.bytes === null ? "—" : kb(c.bytes), c.sha256]);
  if (hashRows.length) r.table(["#", "Kind", "Time", "Size", "SHA-256"], hashRows, [4, 14, 10, 8, 64], { size: 6.5 });
  else r.para("None.", { color: MUTED });

  // 8. Result
  r.h2("8. Result");
  if (d.result) {
    const competent = d.result.outcome === "competent";
    r.box(`${competent ? "COMPETENT" : "NOT YET COMPETENT"} — ${d.result.totalMark}/${d.result.totalMax} (${d.result.percentage}%)`, competent ? GREEN : AMBER, `Signed off ${fmtDateTime(d.result.signedOffAt)} by ${d.result.assessorName} · Statement of Results ${d.result.statementNumber}`);
    r.para("The Statement of Results, with marks per exit-level outcome, accompanies this pack. Moderation, verification and certification are recorded on FPTStaff.", { size: 9, color: MUTED });
  } else r.para(d.session.submittedAt ? "Awaiting the assessor's sign-off. The result is released to the learner, and to FPTStaff, only once signed off." : "Not yet submitted.", { color: MUTED });

  r.para(`Evidence pack ${d.packNumber} · session ${d.session.id} · generated ${fmtDateTime(d.generatedAt)} from the sealed record. Captures and recordings are kept for 12 months after the sitting unless placed on hold for an appeal or investigation.`, { size: 7.5, color: MUTED });
  doc.fillColor(INK);
  return r.finish();
}
