import archiver from "archiver";
import type { Response } from "express";
import { asc, eq, inArray, and, sql, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { learnerSessions, examSittings, assessmentInstruments, qualifications, users, sittingInvigilators, cohorts, assessorDecisions, aiIntegrityReports, auditLog, incidentLog, recordingSegments, evidenceBlobs } from "../db/schema.js";
import { decryptField } from "../auth/crypto.js";
import { fullRecordingOn } from "../proctoring/session.js";
import type { IntegritySummary } from "../proctoring/integrity.js";
import type { Question } from "../types.js";
import { loadStatement, renderStatement, statementNumberFor } from "./statement.js";
import { loadAlignment, renderAlignment } from "./alignment.js";
import { loadEvidencePack, renderEvidencePack, loadBlobs, captureFileName, segmentFileName, labelFor, packNumberFor } from "./evidencePack.js";
import { objectStore } from "../storage/index.js";
import { report, fmtDate, fmtTime, fmtDateTime, kb, MUTED, GREEN, AMBER, RED, BLUE } from "./pdf.js";

// Block 8c: the Portfolio of Evidence for one sitting - everything the
// governing body (QCTO, the SETA, an external moderator or verifier) asks to
// see about a sitting, assembled from the sealed record into one ZIP:
//
//   00-README.txt                       what is in the portfolio and how to verify it
//   01-Sitting-Register.pdf             who sat, when, how it went, the result, the integrity call
//   02-Alignment-Matrix.pdf             the paper's quality-assurance record (question x outcome)
//   03-Question-Paper.pdf               the paper as the learners saw it
//   04-Marking-Guideline.pdf            model answers and rubrics (assessor copy)
//   05-Results.csv                      one row per learner - opens in Excel
//   06-Incidents.csv                    every incident across the sitting
//   07-Audit-Trail.csv                  every recorded action on the sitting and its sessions
//   learners/<Surname Name - ID>/       Evidence-Pack.pdf, Statement-of-Results.pdf (once released),
//                                       captures/*.jpg, recording/*.webm (when asked for), manifest.json
//
// Nothing is copied ahead of time: the database is the archive, and the ZIP is
// produced from it when it is asked for, so it always matches the record.

export const RETENTION_MONTHS = 12;
export const retentionUntil = (sittingEnd: Date) => { const d = new Date(sittingEnd); d.setMonth(d.getMonth() + RETENTION_MONTHS); return d; };

const csvCell = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const csv = (head: string[], rows: unknown[][]) => [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
const safeName = (s: string) => s.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, " ").slice(0, 60);
const OUTCOME_WORD: Record<string, string> = { competent: "Competent", not_yet_competent: "Not yet competent" };
const STATUS_WORD: Record<string, string> = { scheduled: "Did not sit", checked_in: "Checked in, did not open the paper", in_progress: "Writing", submitted: "Submitted", sealed: "Submitted" };
const REC_COLOR: Record<string, string> = { clear: GREEN, review: AMBER, investigate: RED };

export async function loadSittingRegister(sittingId: string) {
  const [sitting] = await db.select().from(examSittings).where(eq(examSittings.id, sittingId));
  if (!sitting) return null;
  const [instrument] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, sitting.instrumentId));
  const [qualification] = await db.select().from(qualifications).where(eq(qualifications.id, sitting.qualificationId));
  const [assessor] = await db.select({ name: users.name, reg: users.registrationNumber }).from(users).where(eq(users.id, sitting.assignedAssessorId));
  const invigilators = await db.select({ name: users.name, reg: users.registrationNumber }).from(sittingInvigilators).innerJoin(users, eq(users.id, sittingInvigilators.invigilatorId)).where(eq(sittingInvigilators.sittingId, sittingId));
  const cohort = sitting.cohortId ? (await db.select().from(cohorts).where(eq(cohorts.id, sitting.cohortId)))[0] : undefined;
  const rows = await db
    .select({ session: learnerSessions, learner: users, decision: assessorDecisions, integrity: aiIntegrityReports.findings })
    .from(learnerSessions)
    .innerJoin(users, eq(users.id, learnerSessions.learnerId))
    .leftJoin(assessorDecisions, eq(assessorDecisions.sessionId, learnerSessions.id))
    .leftJoin(aiIntegrityReports, eq(aiIntegrityReports.sessionId, learnerSessions.id))
    .where(eq(learnerSessions.sittingId, sittingId))
    .orderBy(asc(users.name));
  const ids = rows.map((r) => r.session.id);
  const segTotals = ids.length ? await db.select({ sessionId: recordingSegments.sessionId, n: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${recordingSegments.bytes}),0)::bigint` }).from(recordingSegments).where(inArray(recordingSegments.sessionId, ids)).groupBy(recordingSegments.sessionId) : [];
  const blobTotals = ids.length ? await db.select({ sessionId: evidenceBlobs.sessionId, n: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(length(${evidenceBlobs.bytes})),0)::bigint` }).from(evidenceBlobs).where(inArray(evidenceBlobs.sessionId, ids)).groupBy(evidenceBlobs.sessionId) : [];
  const segMap = new Map(segTotals.map((s) => [s.sessionId, { n: s.n, bytes: Number(s.bytes) }]));
  const blobMap = new Map(blobTotals.map((s) => [s.sessionId, { n: s.n, bytes: Number(s.bytes) }]));
  const questions = (instrument.questions as Question[]) ?? [];
  const learners = rows.map((r) => {
    let idNumber: string | null = null;
    if (r.learner.idNumberEnc) { try { idNumber = decryptField(r.learner.idNumberEnc); } catch { idNumber = null; } }
    const ig = r.integrity as IntegritySummary | null;
    const released = Boolean(r.decision?.signedOffAt);
    return {
      sessionId: r.session.id, learnerId: r.learner.id, name: r.learner.name, idNumber, studentNumber: r.learner.studentNumber, email: r.learner.email,
      status: r.session.status, checkInTime: r.session.checkInTime, startedAt: r.session.startedAt, submittedAt: r.session.submissionTime, extraMinutes: r.session.extraMinutes, sealHash: r.session.sealHash,
      integrity: ig ? { recommendation: ig.recommendation, headline: ig.headline, findings: ig.findings.length, high: ig.findings.filter((f) => f.severity === "high").length } : null,
      result: released ? { outcome: r.decision!.outcome ?? "not_yet_competent", totalMark: r.decision!.totalMark ?? 0, totalMax: r.decision!.totalMax ?? questions.reduce((s, q) => s + q.maxMark, 0), signedOffAt: r.decision!.signedOffAt!, statementNumber: statementNumberFor(r.session.id, r.decision!.signedOffAt!) } : null,
      marking: r.decision ? (released ? "released" : "in_progress") : r.session.submissionTime ? "waiting" : "none",
      stills: blobMap.get(r.session.id) ?? { n: 0, bytes: 0 }, recording: segMap.get(r.session.id) ?? { n: 0, bytes: 0 },
      packNumber: packNumberFor(r.session.id, sitting.startTime),
    };
  });
  return { sitting, instrument, qualification, questions, assessor: assessor ?? null, invigilators, cohort: cohort ?? null, learners, fullRecording: fullRecordingOn(sitting.proctoringProfile), retentionUntil: retentionUntil(sitting.endTime), generatedAt: new Date() };
}
export type SittingRegister = NonNullable<Awaited<ReturnType<typeof loadSittingRegister>>>;

export async function renderRegister(d: SittingRegister): Promise<Buffer> {
  const name = d.sitting.name ?? `${d.qualification.title} · ${d.instrument.version}`;
  const r = report({ title: `Sitting register - ${name}`, headerRight: `Sitting register · ${fmtDate(d.sitting.startTime)}`, confidentialLine: "CONFIDENTIAL — sitting record for moderation and verification. FPT Academy (Pty) Ltd", landscape: true });
  r.title("Sitting Register", name, `Generated ${fmtDateTime(d.generatedAt)}`);
  const sat = d.learners.filter((l) => l.submittedAt).length, competent = d.learners.filter((l) => l.result?.outcome === "competent").length, released = d.learners.filter((l) => l.result).length;
  r.facts([
    ["Qualification", `${d.qualification.title}${d.qualification.saqaQualificationId ? ` · SAQA ${d.qualification.saqaQualificationId}` : ""}`], ["Paper", `${d.instrument.version} · ${d.questions.length} questions · ${d.questions.reduce((s, q) => s + q.maxMark, 0)} marks · ${d.instrument.timeAllocationMinutes} min`], ["Cohort", d.cohort ? `${d.cohort.name}${d.cohort.site ? ` · ${d.cohort.site}` : ""}${d.cohort.intake ? ` · ${d.cohort.intake}` : ""}` : "—"],
    ["When", `${fmtDate(d.sitting.startTime)}, ${fmtTime(d.sitting.startTime)}–${fmtTime(d.sitting.endTime)}`], ["Venue", d.sitting.venue ?? "Remote / not recorded"], ["Evidence kept", d.fullRecording ? "Full recording plus stills" : "Stills at intervals"],
    ["Assessor of record", `${d.assessor?.name ?? "—"}${d.assessor?.reg ? ` (${d.assessor.reg})` : ""}`], ["Invigilator(s)", d.invigilators.map((i) => `${i.name}${i.reg ? ` (${i.reg})` : ""}`).join(", ") || "—"], ["Independent invigilation", d.sitting.independentInvigilationRequired ? "Required" : "Not required"],
    ["Registered", `${d.learners.length}`], ["Sat and submitted", `${sat}`], ["Results released", `${released} (${competent} competent, ${released - competent} not yet competent)`],
  ]);
  r.h2("Learners");
  r.table(
    ["Learner", "ID number", "Student no.", "Checked in", "Opened", "Submitted", "Integrity", "Result", "Statement", "Evidence pack"],
    d.learners.map((l) => [l.name, l.idNumber ?? "—", l.studentNumber ?? "—", l.checkInTime ? fmtTime(l.checkInTime) : "—", l.startedAt ? fmtTime(l.startedAt) : "—", l.submittedAt ? fmtTime(l.submittedAt) + (l.extraMinutes ? ` (+${l.extraMinutes} min)` : "") : STATUS_WORD[l.status] ?? l.status, l.integrity ? `${l.integrity.recommendation.toUpperCase()}${l.integrity.high ? ` · ${l.integrity.high} high` : ""}` : "—", l.result ? `${OUTCOME_WORD[l.result.outcome] ?? l.result.outcome} · ${l.result.totalMark}/${l.result.totalMax}` : l.marking === "in_progress" ? "Being marked" : l.marking === "waiting" ? "Awaiting marking" : "—", l.result?.statementNumber ?? "—", l.packNumber]),
    [18, 11, 9, 7, 7, 10, 11, 14, 14, 14],
    { size: 7.5, tone: (row) => { const w = row[6].split(" ")[0].toLowerCase(); return REC_COLOR[w] ?? null; } }
  );
  r.para(`Captures and recordings for this sitting are kept until ${fmtDate(d.retentionUntil)} (${RETENTION_MONTHS} months after the sitting) unless placed on hold. Statements of Results, evidence-pack records, marks and the audit trail are kept permanently.`, { size: 8.5, color: MUTED });
  return r.finish();
}

const TYPE_HEAD: Record<string, string> = { mcq: "SECTION A — MULTIPLE CHOICE", short_answer: "SECTION B — KNOWLEDGE AND DEPTH", long_answer: "SECTION C — COMPREHENSIVE", practical_upload: "PRACTICAL" };

export async function renderPaper(d: SittingRegister, withGuideline: boolean): Promise<Buffer> {
  const total = d.questions.reduce((s, q) => s + q.maxMark, 0);
  const r = report({ title: `${withGuideline ? "Marking guideline" : "Question paper"} - ${d.qualification.title} ${d.instrument.version}`, headerRight: `${d.qualification.title} · ${d.instrument.version}`, confidentialLine: withGuideline ? "CONFIDENTIAL — assessor's marking guideline. Never issued to learners" : "CONFIDENTIAL — examination paper. FPT Academy (Pty) Ltd" });
  r.title(withGuideline ? "Marking Guideline" : "Question Paper", `${d.qualification.title} · ${d.instrument.version}`, `${total} marks · ${d.instrument.timeAllocationMinutes} minutes`);
  const materials = (d.instrument.permittedMaterials as string[] | null) ?? [];
  r.facts([["Qualification", d.qualification.title], ["Paper", d.instrument.version], ["Time", `${d.instrument.timeAllocationMinutes} minutes`], ["Total marks", String(total)], ["Permitted materials", materials.length ? materials.join(", ") : "None"], ["Pass rule", (d.instrument.passMarkOrCompetencyRule as { rule?: string } | null)?.rule ?? "—"]]);
  if (!withGuideline) r.para("Answer every question. Multiple-choice questions have one correct option. Write your answers in the exam room on screen; nothing may be uploaded. This paper is delivered under proctoring as consented to at check-in.", { size: 9, color: MUTED });
  let section = "";
  const letter = (i: number) => String.fromCharCode(65 + i);
  // Sections in exam order (A, B, C) whatever order the paper stores them in.
  const ORDER: Record<string, number> = { mcq: 0, short_answer: 1, long_answer: 2, practical_upload: 3 };
  const ordered = d.questions.map((q, i) => ({ q, i })).sort((a, b) => (ORDER[a.q.type] ?? 9) - (ORDER[b.q.type] ?? 9) || a.i - b.i);
  ordered.forEach(({ q }, n) => {
    const head = TYPE_HEAD[q.type] ?? q.type.toUpperCase();
    if (head !== section) { section = head; r.h2(section); }
    r.ensure(60);
    r.doc.fillColor(BLUE).font("Helvetica-Bold").fontSize(10).text(`Question ${n + 1}`, r.L(), r.doc.y, { continued: true }).fillColor(MUTED).font("Helvetica").fontSize(8.5).text(`   ${q.maxMark} mark${q.maxMark === 1 ? "" : "s"}${q.eloRef ? ` · ${q.eloRef}` : ""}${q.acRef ? ` · ${q.acRef}` : ""}${q.bloomLevel ? ` · ${q.bloomLevel}` : ""}${q.id.length <= 8 ? ` · ${q.id}` : ""}`);
    r.para(q.prompt, { size: 9.5 });
    if (q.options?.length) q.options.forEach((o, j) => r.para(`${letter(j)}.  ${o}`, { size: 9, color: "#2A3A30" }));
    if (withGuideline && q.modelAnswerOrRubric) { r.doc.moveDown(0.1); r.para(`Memo: ${q.modelAnswerOrRubric}`, { size: 8.5, color: "#2E5A3A" }); }
    r.doc.moveDown(0.3);
  });
  return r.finish();
}

export async function sittingCsvs(d: SittingRegister) {
  const ids = d.learners.map((l) => l.sessionId);
  const results = csv(
    ["Learner", "ID number", "Student number", "Email", "Sitting", "Date", "Qualification", "Paper", "Status", "Checked in", "Paper opened", "Submitted", "Extra minutes", "Integrity", "Integrity findings", "Outcome", "Mark", "Out of", "Percentage", "Signed off", "Statement number", "Evidence pack", "Seal"],
    d.learners.map((l) => [l.name, l.idNumber, l.studentNumber, l.email, d.sitting.name, d.sitting.startTime.toISOString(), d.qualification.title, d.instrument.version, STATUS_WORD[l.status] ?? l.status, l.checkInTime?.toISOString(), l.startedAt?.toISOString(), l.submittedAt?.toISOString(), l.extraMinutes, l.integrity?.recommendation, l.integrity?.findings, l.result ? OUTCOME_WORD[l.result.outcome] ?? l.result.outcome : "", l.result?.totalMark, l.result?.totalMax, l.result ? Math.round((l.result.totalMark / Math.max(1, l.result.totalMax)) * 1000) / 10 : "", l.result?.signedOffAt.toISOString(), l.result?.statementNumber, l.packNumber, l.sealHash])
  );
  const inc = ids.length ? await db.select({ i: incidentLog, learner: users.name, by: sql<string>`(select name from users u where u.id = ${incidentLog.raisedByUserId})` }).from(incidentLog).innerJoin(learnerSessions, eq(learnerSessions.id, incidentLog.sessionId)).innerJoin(users, eq(users.id, learnerSessions.learnerId)).where(inArray(incidentLog.sessionId, ids)).orderBy(asc(incidentLog.occurredAt)) : [];
  const incidents = csv(["Time", "Learner", "Raised by", "Type", "Description", "Detail", "Session"], inc.map(({ i, learner, by }) => [i.occurredAt.toISOString(), learner, i.raisedBy === "invigilator" ? by ?? "invigilator" : "system", i.type, labelFor(i.type), i.actionTaken, i.sessionId]));
  const targets = [d.sitting.id, ...ids];
  const aud = await db.select({ a: auditLog, actor: users.name }).from(auditLog).leftJoin(users, eq(users.id, auditLog.actorId)).where(inArray(auditLog.targetId, targets)).orderBy(asc(auditLog.occurredAt));
  const learnerOf = new Map(d.learners.map((l) => [l.sessionId, l.name]));
  const audit = csv(["Time", "Actor", "Action", "Description", "Target", "Learner", "Detail"], aud.map(({ a, actor }) => [a.occurredAt.toISOString(), actor ?? "system", a.action, labelFor(a.action), a.targetType, a.targetId ? learnerOf.get(a.targetId) ?? "" : "", a.reason]));
  return { results, incidents, audit };
}

const readme = (d: SittingRegister, video: boolean) => `FPT ACADEMY - PORTFOLIO OF EVIDENCE FOR ONE SITTING
=====================================================
Sitting        ${d.sitting.name ?? "-"}
Qualification  ${d.qualification.title}${d.qualification.saqaQualificationId ? ` (SAQA ${d.qualification.saqaQualificationId})` : ""}
Paper          ${d.instrument.version}
When           ${fmtDate(d.sitting.startTime)}, ${fmtTime(d.sitting.startTime)}-${fmtTime(d.sitting.endTime)}${d.sitting.venue ? ` at ${d.sitting.venue}` : ""}
Generated      ${fmtDateTime(d.generatedAt)} from the sealed record on FPT Exam
Learners       ${d.learners.length} registered, ${d.learners.filter((l) => l.submittedAt).length} submitted, ${d.learners.filter((l) => l.result).length} results released

CONTENTS
  01-Sitting-Register.pdf     who sat, when, integrity call, result, statement and pack numbers
  02-Alignment-Matrix.pdf     the paper's quality-assurance record: standard check verdict, shape, question x outcome grid
  03-Question-Paper.pdf       the paper as delivered
  04-Marking-Guideline.pdf    the paper with model answers and rubrics (assessor copy - do not issue to learners)
  05-Results.csv              one row per learner (Excel)
  06-Incidents.csv            every incident raised by the system or the invigilator, across the sitting
  07-Audit-Trail.csv          every recorded action on this sitting and its learner sessions
  learners/<name - ID>/
      Evidence-Pack.pdf             the learner's complete sitting record: identity photo, integrity summary,
                                    timeline, every still, recording manifest, seal and hashes, result
      Statement-of-Results.pdf      present once the assessor has signed off
      captures/                     every camera and screen still as taken (JPEG), numbered in time order
      recording/                    ${video ? "every one-minute camera and screen segment (WebM), playable in any modern browser or VLC" : "NOT INCLUDED in this portfolio - ask for the portfolio 'with video' (large)"}
      manifest.json                 machine-readable index: every file with its SHA-256

VERIFYING
  Every capture and recording segment carries its SHA-256 in manifest.json and in the evidence pack.
  Re-hash any file (e.g. 'shasum -a 256 <file>') and compare. The seal printed in each evidence pack is
  SHA-256 over the session id, submission time, the answers as submitted and the capture hashes in order;
  it proves nothing has changed since the learner submitted.

RETENTION
  Captures and recordings are kept on FPT Exam until ${fmtDate(d.retentionUntil)} (${RETENTION_MONTHS} months after the sitting)
  unless placed on hold for an appeal or investigation. Results, statements, integrity reports, marks and
  the audit trail are kept permanently. Moderation, verification and certification are recorded on FPTStaff.

CONFIDENTIAL - for FPT Academy (Pty) Ltd and its quality-assurance partners only.
`;

// Streams the ZIP straight to the response so a sitting with video never has
// to fit in memory. Returns when the archive has been fully written.
export async function streamPortfolio(res: Response, d: SittingRegister, opts: { video: boolean; learnerIds?: string[] }): Promise<{ files: number; bytes: number }> {
  const zip = archiver("zip", { zlib: { level: 6 }, store: false });
  const stamp = d.sitting.startTime.toISOString().slice(0, 10);
  const fname = `Portfolio-of-Evidence-${safeName(d.qualification.title).replace(/ /g, "-")}-${stamp}${opts.video ? "-with-video" : ""}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
  res.setHeader("Cache-Control", "private, no-store");
  const finished = new Promise<void>((resolve, reject) => { zip.on("end", resolve); zip.on("error", reject); res.on("close", resolve); });
  zip.pipe(res);
  let files = 0;
  const add = (name: string, data: Buffer | string) => { zip.append(data, { name, date: d.generatedAt }); files++; };

  add("00-README.txt", readme(d, opts.video));
  add("01-Sitting-Register.pdf", await renderRegister(d));
  const al = await loadAlignment(d.instrument.id);
  if (al) add("02-Alignment-Matrix.pdf", await renderAlignment(al));
  add("03-Question-Paper.pdf", await renderPaper(d, false));
  add("04-Marking-Guideline.pdf", await renderPaper(d, true));
  const c = await sittingCsvs(d);
  add("05-Results.csv", c.results); add("06-Incidents.csv", c.incidents); add("07-Audit-Trail.csv", c.audit);

  const store = opts.video ? await objectStore() : null;
  for (const l of d.learners) {
    if (opts.learnerIds && !opts.learnerIds.includes(l.learnerId)) continue;
    const folder = `learners/${safeName(l.name)}${l.idNumber ? ` - ${l.idNumber}` : ""}`;
    await addLearnerFolder(add, folder, l.sessionId, { video: opts.video, store, stillsInPdf: false });
    // let the stream drain between learners so memory stays flat
    await new Promise((r) => setImmediate(r));
  }
  await zip.finalize();
  await finished;
  return { files, bytes: zip.pointer() };
}

type Adder = (name: string, data: Buffer | string) => void;

async function addLearnerFolder(add: Adder, folder: string, sessionId: string, o: { video: boolean; store: Awaited<ReturnType<typeof objectStore>> | null; stillsInPdf: boolean }) {
  const pack = await loadEvidencePack(sessionId);
  if (!pack) return;
  const blobs = await loadBlobs(sessionId);
  add(`${folder}/Evidence-Pack.pdf`, await renderEvidencePack(pack, blobs, { stills: o.stillsInPdf }));
  if (pack.result) { const st = await loadStatement(sessionId); if (st) add(`${folder}/Statement-of-Results.pdf`, await renderStatement(st)); }
  const manifest: { file: string; kind: string; at: string; bytes: number; sha256: string; afterSeal?: boolean }[] = [];
  let n = 0;
  for (const c of pack.captures) {
    if (!c.blobId) continue;
    const b = blobs.get(c.blobId);
    if (!b) continue;
    const file = c.kind === "identity_photo" ? `captures/000-identity-photo.jpg` : `captures/${captureFileName(c.kind, c.at, ++n)}`;
    add(`${folder}/${file}`, b.bytes);
    manifest.push({ file, kind: c.kind, at: c.at.toISOString(), bytes: b.bytes.length, sha256: c.sha256 });
  }
  for (const s of pack.segments) {
    const file = `recording/${segmentFileName(s.kind, s.seq)}`;
    if (o.video && o.store) { const bytes = await o.store.get(s.storageKey); if (bytes) add(`${folder}/${file}`, bytes); }
    manifest.push({ file, kind: `recording_${s.kind}`, at: s.startedAt.toISOString(), bytes: s.bytes, sha256: s.sha256, afterSeal: s.afterSeal });
  }
  add(`${folder}/manifest.json`, JSON.stringify({ packNumber: pack.packNumber, sessionId, learner: { name: pack.learner.name, idNumber: pack.learner.idNumber, studentNumber: pack.learner.studentNumber }, sitting: { id: pack.sitting.id, name: pack.sitting.name, startTime: pack.sitting.startTime.toISOString() }, seal: pack.session.sealHash, submittedAt: pack.session.submittedAt?.toISOString() ?? null, integrity: pack.integrity ? { recommendation: pack.integrity.recommendation, headline: pack.integrity.headline } : null, result: pack.result ? { outcome: pack.result.outcome, totalMark: pack.result.totalMark, totalMax: pack.result.totalMax, statementNumber: pack.result.statementNumber } : null, recordingIncluded: o.video, files: manifest }, null, 2));
}

// One learner's evidence as a ZIP (pack PDF, statement, captures, optional video, manifest).
export async function streamLearnerZip(res: Response, sessionId: string, opts: { video: boolean }): Promise<boolean> {
  const pack = await loadEvidencePack(sessionId);
  if (!pack) return false;
  const zip = archiver("zip", { zlib: { level: 6 } });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="Evidence-${pack.packNumber}${opts.video ? "-with-video" : ""}.zip"`);
  res.setHeader("Cache-Control", "private, no-store");
  const finished = new Promise<void>((resolve, reject) => { zip.on("end", resolve); zip.on("error", reject); res.on("close", resolve); });
  zip.pipe(res);
  const add: Adder = (name, data) => zip.append(data, { name, date: pack.generatedAt });
  await addLearnerFolder(add, pack.packNumber, sessionId, { video: opts.video, store: opts.video ? await objectStore() : null, stillsInPdf: false });
  await zip.finalize();
  await finished;
  return true;
}

// The archive register: every sitting whose window has closed, with what the
// record holds for it. Newest first.
export async function archiveRows(limit = 200) {
  const now = new Date();
  const sittings = await db
    .select({ sitting: examSittings, qualification: qualifications.title, saqaId: qualifications.saqaQualificationId, paper: assessmentInstruments.version, assessor: users.name, cohort: cohorts.name })
    .from(examSittings)
    .innerJoin(qualifications, eq(qualifications.id, examSittings.qualificationId))
    .innerJoin(assessmentInstruments, eq(assessmentInstruments.id, examSittings.instrumentId))
    .innerJoin(users, eq(users.id, examSittings.assignedAssessorId))
    .leftJoin(cohorts, eq(cohorts.id, examSittings.cohortId))
    .where(sql`${examSittings.endTime} < ${now}`)
    .orderBy(desc(examSittings.startTime))
    .limit(limit);
  const ids = sittings.map((s) => s.sitting.id);
  if (!ids.length) return [];
  const sessions = await db
    .select({ sittingId: learnerSessions.sittingId, id: learnerSessions.id, status: learnerSessions.status, submitted: learnerSessions.submissionTime, released: assessorDecisions.signedOffAt, outcome: assessorDecisions.outcome, rec: aiIntegrityReports.overallRecommendation })
    .from(learnerSessions)
    .leftJoin(assessorDecisions, eq(assessorDecisions.sessionId, learnerSessions.id))
    .leftJoin(aiIntegrityReports, eq(aiIntegrityReports.sessionId, learnerSessions.id))
    .where(inArray(learnerSessions.sittingId, ids));
  const sids = sessions.map((s) => s.id);
  const segTotals = sids.length ? await db.select({ sittingId: learnerSessions.sittingId, n: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${recordingSegments.bytes}),0)::bigint` }).from(recordingSegments).innerJoin(learnerSessions, eq(learnerSessions.id, recordingSegments.sessionId)).where(inArray(recordingSegments.sessionId, sids)).groupBy(learnerSessions.sittingId) : [];
  const blobTotals = sids.length ? await db.select({ sittingId: learnerSessions.sittingId, n: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(length(${evidenceBlobs.bytes})),0)::bigint` }).from(evidenceBlobs).innerJoin(learnerSessions, eq(learnerSessions.id, evidenceBlobs.sessionId)).where(inArray(evidenceBlobs.sessionId, sids)).groupBy(learnerSessions.sittingId) : [];
  const seg = new Map(segTotals.map((s) => [s.sittingId, { n: s.n, bytes: Number(s.bytes) }]));
  const blob = new Map(blobTotals.map((s) => [s.sittingId, { n: s.n, bytes: Number(s.bytes) }]));
  const downloads = await db.select({ targetId: auditLog.targetId, n: sql<number>`count(*)::int`, last: sql<Date>`max(${auditLog.occurredAt})` }).from(auditLog).where(and(eq(auditLog.action, "sitting_portfolio_downloaded"), inArray(auditLog.targetId, ids))).groupBy(auditLog.targetId);
  const dl = new Map(downloads.map((d) => [d.targetId, d]));
  return sittings.map((s) => {
    const ss = sessions.filter((x) => x.sittingId === s.sitting.id);
    const submitted = ss.filter((x) => x.submitted).length;
    const released = ss.filter((x) => x.released).length;
    return {
      id: s.sitting.id, name: s.sitting.name, qualificationTitle: s.qualification, saqaId: s.saqaId, paper: s.paper, instrumentId: s.sitting.instrumentId, venue: s.sitting.venue, cohort: s.cohort, assessor: s.assessor,
      startTime: s.sitting.startTime.toISOString(), endTime: s.sitting.endTime.toISOString(), fullRecording: fullRecordingOn(s.sitting.proctoringProfile),
      learners: ss.length, submitted, released, competent: ss.filter((x) => x.released && x.outcome === "competent").length, marking: submitted - released,
      integrity: { clear: ss.filter((x) => x.rec === "clear").length, review: ss.filter((x) => x.rec === "review").length, investigate: ss.filter((x) => x.rec === "investigate").length },
      stills: blob.get(s.sitting.id) ?? { n: 0, bytes: 0 }, recording: seg.get(s.sitting.id) ?? { n: 0, bytes: 0 },
      retentionUntil: retentionUntil(s.sitting.endTime).toISOString(),
      complete: ss.length > 0 && released === submitted && submitted > 0,
      portfolioDownloads: dl.get(s.sitting.id)?.n ?? 0, portfolioLastDownloadedAt: dl.get(s.sitting.id)?.last ? new Date(dl.get(s.sitting.id)!.last).toISOString() : null,
    };
  });
}
