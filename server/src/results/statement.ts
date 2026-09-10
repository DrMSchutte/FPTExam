import PDFDocument from "pdfkit";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { learnerSessions, examSittings, assessmentInstruments, qualifications, users, assessorDecisions } from "../db/schema.js";
import { decryptField } from "../auth/crypto.js";
import { integrityReportFor, type IntegritySummary } from "../proctoring/integrity.js";
import type { Question, QuestionMark } from "../types.js";

// Block 5d: the Statement of Results - the learner's formal record of a
// signed-off result. One A4 PDF, FPT Academy branding, Arial-equivalent
// (Helvetica), confidential header and footer. Carries the learner's full ID
// number and student number (decision 9 Sep 2026), the qualification and
// paper, the sitting, the outcome and marks per outcome, the sitting-integrity
// summary, the assessor's sign-off, the seal and a statement number.

const GREEN = "#6BBF3E";
const BLUE = "#2E86AB";
const INK = "#1B2A22";
const MUTED = "#5D6B60";
const LINE = "#D9E2DB";

export interface StatementData {
  statementNumber: string;
  issuedAt: Date;
  learner: { name: string; idNumber: string | null; studentNumber: string | null; email: string };
  qualification: { title: string; saqaId: string | null; type: string; aqpReference: string | null };
  paper: { version: string; minutes: number };
  sitting: { name: string | null; venue: string | null; startTime: Date; endTime: Date };
  session: { id: string; submittedAt: Date | null; sealHash: string | null };
  result: { outcome: string; totalMark: number; totalMax: number; percentage: number; signedOffAt: Date; assessorName: string; overallFeedback: string | null };
  perOutcome: { ref: string; mark: number; max: number; questions: number }[];
  integrity: IntegritySummary | null;
}

export const statementNumberFor = (sessionId: string, signedOffAt: Date) => `FPT-SR-${signedOffAt.getFullYear()}-${sessionId.replace(/-/g, "").slice(0, 10).toUpperCase()}`;

export async function loadStatement(sessionId: string): Promise<StatementData | null> {
  const [row] = await db
    .select({ session: learnerSessions, sitting: examSittings, decision: assessorDecisions, learner: users })
    .from(learnerSessions)
    .innerJoin(examSittings, eq(examSittings.id, learnerSessions.sittingId))
    .innerJoin(assessorDecisions, eq(assessorDecisions.sessionId, learnerSessions.id))
    .innerJoin(users, eq(users.id, learnerSessions.learnerId))
    .where(eq(learnerSessions.id, sessionId));
  if (!row || !row.decision.signedOffAt) return null;
  const [instrument] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, row.sitting.instrumentId));
  const [qualification] = await db.select().from(qualifications).where(eq(qualifications.id, row.sitting.qualificationId));
  const [assessor] = await db.select({ name: users.name }).from(users).where(eq(users.id, row.decision.assessorId));
  const integrity = await integrityReportFor(sessionId);

  const questions = (instrument.questions as Question[]) ?? [];
  const marks = new Map((row.decision.perCriterionMarks as QuestionMark[]).map((m) => [m.questionId, m.mark]));
  const groups = new Map<string, { mark: number; max: number; questions: number }>();
  for (const q of questions) {
    const ref = q.eloRef?.trim() || "General";
    const g = groups.get(ref) ?? { mark: 0, max: 0, questions: 0 };
    g.mark += marks.get(q.id) ?? 0;
    g.max += q.maxMark;
    g.questions += 1;
    groups.set(ref, g);
  }
  const totalMark = row.decision.totalMark ?? 0;
  const totalMax = row.decision.totalMax ?? questions.reduce((s, q) => s + q.maxMark, 0);
  let idNumber: string | null = null;
  if (row.learner.idNumberEnc) {
    try { idNumber = decryptField(row.learner.idNumberEnc); } catch { idNumber = null; }
  }
  return {
    statementNumber: statementNumberFor(row.session.id, row.decision.signedOffAt),
    issuedAt: new Date(),
    learner: { name: row.learner.name, idNumber, studentNumber: row.learner.studentNumber, email: row.learner.email },
    qualification: { title: qualification.title, saqaId: qualification.saqaQualificationId, type: qualification.qctoRegistrationType, aqpReference: qualification.aqpReference },
    paper: { version: instrument.version, minutes: instrument.timeAllocationMinutes },
    sitting: { name: row.sitting.name, venue: row.sitting.venue, startTime: row.sitting.startTime, endTime: row.sitting.endTime },
    session: { id: row.session.id, submittedAt: row.session.submissionTime, sealHash: row.session.sealHash },
    result: { outcome: row.decision.outcome ?? "not_yet_competent", totalMark, totalMax, percentage: totalMax === 0 ? 0 : Math.round((totalMark / totalMax) * 1000) / 10, signedOffAt: row.decision.signedOffAt, assessorName: assessor?.name ?? "Registered assessor", overallFeedback: row.decision.overallFeedback },
    perOutcome: [...groups.entries()].map(([ref, g]) => ({ ref, ...g })),
    integrity,
  };
}

const fmtDate = (d: Date) => d.toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Johannesburg" });
const fmtTime = (d: Date) => d.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" });
const TYPE_WORD: Record<string, string> = { eisa: "QCTO External Integrated Summative Assessment (EISA)", fisa: "QCTO Final Integrated Summative Assessment (FISA)", non_qcto: "Assessment" };
const OUTCOME_WORD: Record<string, string> = { competent: "COMPETENT", not_yet_competent: "NOT YET COMPETENT" };

export function renderStatement(s: StatementData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 64, bottom: 64, left: 52, right: 52 }, info: { Title: `Statement of Results ${s.statementNumber}`, Author: "FPT Academy (Pty) Ltd", Subject: s.qualification.title } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = doc.page.width, L = doc.page.margins.left, R = W - doc.page.margins.right, CW = R - L;
    const outcomeWord = OUTCOME_WORD[s.result.outcome] ?? s.result.outcome.toUpperCase();
    const competent = s.result.outcome === "competent";

    // Header and footer on every page.
    let pageNo = 0;
    const chrome = () => {
      pageNo++;
      // The footer sits inside the bottom margin; lift the margin while drawing it
      // or pdfkit would start a new page (and call this again, forever).
      const savedBottom = doc.page.margins.bottom;
      const savedY = doc.y;
      doc.page.margins.bottom = 0;
      doc.save();
      doc.rect(0, 0, W, 8).fill(GREEN);
      doc.fontSize(8).fillColor(MUTED).font("Helvetica").text("CONFIDENTIAL — issued to the named learner. FPT Academy (Pty) Ltd", L, 20, { width: CW, align: "left" });
      doc.text(`Statement ${s.statementNumber}`, L, 20, { width: CW, align: "right" });
      const fy = doc.page.height - 40;
      doc.moveTo(L, fy - 8).lineTo(R, fy - 8).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.fontSize(7.5).fillColor(MUTED).text("FPT Academy (Pty) Ltd · QCTO- and SETA-accredited skills development provider · Durban, KwaZulu-Natal · fptacademy.co.za", L, fy, { width: CW * 0.8, align: "left" });
      doc.text(`Page ${pageNo}`, L, fy, { width: CW, align: "right", lineBreak: false });
      doc.restore();
      doc.page.margins.bottom = savedBottom;
      doc.y = savedY;
    };
    doc.on("pageAdded", chrome);
    chrome();

    // Brand block
    doc.roundedRect(L, 44, 34, 34, 8).fill(GREEN);
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(20).text("F", L, 51, { width: 34, align: "center" });
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(17).text("FPT Academy", L + 44, 46);
    doc.fillColor(MUTED).font("Helvetica").fontSize(9.5).text("Secure Exam Centre · FPT Exam", L + 44, 66);
    doc.fillColor(BLUE).font("Helvetica-Bold").fontSize(22).text("Statement of Results", L, 48, { width: CW, align: "right" });
    doc.fillColor(MUTED).font("Helvetica").fontSize(9.5).text(`Issued ${fmtDate(s.issuedAt)}`, L, 76, { width: CW, align: "right" });
    doc.moveTo(L, 96).lineTo(R, 96).lineWidth(1).strokeColor(GREEN).stroke();

    // Learner + qualification
    let y = 110;
    const label = (t: string, x: number, yy: number, w: number) => doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(t.toUpperCase(), x, yy, { width: w, characterSpacing: 0.4 });
    const value = (t: string, x: number, yy: number, w: number, size = 11.5, bold = true) => doc.fillColor(INK).font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).text(t, x, yy + 11, { width: w });
    const col = CW / 3;
    label("Learner", L, y, col); value(s.learner.name, L, y, col * 1.4);
    label("ID number", L + col * 1.5, y, col); value(s.learner.idNumber ?? "—", L + col * 1.5, y, col);
    label("Student number", L + col * 2.3, y, col); value(s.learner.studentNumber ?? "—", L + col * 2.3, y, col * 0.7);
    y += 42;
    label("Qualification", L, y, CW); value(s.qualification.title, L, y, CW * 0.72, 12);
    y += 14 + doc.heightOfString(s.qualification.title, { width: CW * 0.72 }) + 6;
    label("Assessment", L, y, col); value(TYPE_WORD[s.qualification.type] ?? s.qualification.type, L, y, col * 1.45, 10, false);
    label("SAQA ID", L + col * 1.5, y, col); value(s.qualification.saqaId ?? "—", L + col * 1.5, y, col, 10, false);
    label("Paper", L + col * 2.3, y, col); value(s.paper.version, L + col * 2.3, y, col * 0.7, 10, false);
    y += 40;
    label("Sitting", L, y, col); value(`${fmtDate(s.sitting.startTime)}, ${fmtTime(s.sitting.startTime)}–${fmtTime(s.sitting.endTime)}${s.sitting.venue ? ` · ${s.sitting.venue}` : ""}`, L, y, col * 2.2, 10, false);
    label("Submitted", L + col * 2.3, y, col); value(s.session.submittedAt ? `${fmtDate(s.session.submittedAt)} ${fmtTime(s.session.submittedAt)}` : "—", L + col * 2.3, y, col * 0.7, 10, false);
    y += 44;

    // Outcome box
    doc.roundedRect(L, y, CW, 70, 10).fillAndStroke(competent ? "#F0F8EA" : "#FFF7E6", competent ? GREEN : "#E0A020");
    doc.fillColor(MUTED).font("Helvetica").fontSize(8).text("OUTCOME", L + 18, y + 14, { characterSpacing: 0.4 });
    doc.fillColor(competent ? "#3C7A1E" : "#8A5A00").font("Helvetica-Bold").fontSize(22).text(outcomeWord, L + 18, y + 27);
    doc.fillColor(MUTED).font("Helvetica").fontSize(8).text("TOTAL MARK", L + CW * 0.55, y + 14, { characterSpacing: 0.4 });
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(22).text(`${s.result.totalMark} / ${s.result.totalMax}`, L + CW * 0.55, y + 27);
    doc.fillColor(MUTED).font("Helvetica").fontSize(8).text("PERCENTAGE", L + CW * 0.82, y + 14, { characterSpacing: 0.4 });
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(22).text(`${s.result.percentage}%`, L + CW * 0.82, y + 27);
    y += 88;

    // Marks per outcome
    doc.fillColor(BLUE).font("Helvetica-Bold").fontSize(12).text("Marks per outcome", L, y);
    y += 20;
    const c1 = L, c2 = R - 150, c3 = R - 80, c4 = R;
    doc.rect(L, y, CW, 18).fill("#F3F7F4");
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8).text("EXIT-LEVEL OUTCOME / SECTION", c1 + 8, y + 5, { width: c2 - c1 - 16 });
    doc.text("QUESTIONS", c2, y + 5, { width: c3 - c2 - 8, align: "right" });
    doc.text("MARK", c3, y + 5, { width: c4 - c3 - 8, align: "right" });
    y += 18;
    doc.font("Helvetica").fontSize(9.5);
    for (const o of s.perOutcome) {
      const h = Math.max(18, doc.heightOfString(o.ref, { width: c2 - c1 - 16 }) + 8);
      if (y + h > doc.page.height - 90) { doc.addPage(); y = 110; }
      doc.fillColor(INK).text(o.ref, c1 + 8, y + 4, { width: c2 - c1 - 16 });
      doc.fillColor(MUTED).text(String(o.questions), c2, y + 4, { width: c3 - c2 - 8, align: "right" });
      doc.fillColor(INK).font("Helvetica-Bold").text(`${o.mark} / ${o.max}`, c3, y + 4, { width: c4 - c3 - 8, align: "right" }).font("Helvetica");
      y += h;
      doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor(LINE).stroke();
    }
    y += 4;
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(9.5).text("Total", c1 + 8, y + 4, { width: c2 - c1 });
    doc.text(`${s.result.totalMark} / ${s.result.totalMax}`, c3, y + 4, { width: c4 - c3 - 8, align: "right" });
    y += 30;

    // Feedback
    if (s.result.overallFeedback) {
      const fbH = doc.font("Helvetica").fontSize(9.5).heightOfString(s.result.overallFeedback, { width: CW - 24 });
      if (y + fbH + 50 > doc.page.height - 90) { doc.addPage(); y = 110; }
      doc.fillColor(BLUE).font("Helvetica-Bold").fontSize(12).text("Assessor's feedback", L, y);
      y += 20;
      doc.fillColor(INK).font("Helvetica").fontSize(9.5).text(s.result.overallFeedback, L + 12, y, { width: CW - 24 });
      y += fbH + 18;
    }

    // Integrity
    const ig = s.integrity;
    const igLines = ig ? ig.findings.filter((f) => f.severity !== "info").map((f) => `${f.title} — ${f.detail}`) : [];
    const igH = 48 + igLines.length * 14;
    if (y + igH > doc.page.height - 90) { doc.addPage(); y = 110; }
    doc.fillColor(BLUE).font("Helvetica-Bold").fontSize(12).text("Sitting integrity", L, y);
    y += 20;
    if (ig) {
      const word = ig.recommendation === "clear" ? "No integrity concerns recorded" : ig.recommendation === "review" ? "Observations reviewed by the assessor before sign-off" : "Serious observations reviewed under the irregularity procedure before sign-off";
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(9.5).text(word, L, y);
      y += 14;
      doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(`Proctored sitting: identity photograph ${ig.identityPhoto ? "taken" : "not taken"}; ${ig.counts.photos} camera and ${ig.counts.screens} screen captures over ${ig.writingMinutes} minutes; entire screen ${ig.screenShare === "monitor" ? "shared" : "not fully shared"}${ig.recording ? `; recorded in full (${ig.recording.camera} min camera, ${ig.recording.screen} min screen)` : ""}; submitted by ${ig.submittedBy === "time_up" ? "the clock at time-up" : ig.submittedBy === "invigilator" ? "the invigilator" : "the learner"}.`, L, y, { width: CW });
      y += doc.heightOfString("x", { width: CW }) * 2 + 4;
      for (const line of igLines) { doc.fillColor(INK).font("Helvetica").fontSize(9).text(`• ${line}`, L + 8, y, { width: CW - 16 }); y += doc.heightOfString(`• ${line}`, { width: CW - 16 }) + 2; }
    } else {
      doc.fillColor(MUTED).font("Helvetica").fontSize(9.5).text("No integrity record is held for this sitting.", L, y);
      y += 14;
    }
    y += 14;

    // Sign-off
    if (y + 110 > doc.page.height - 90) { doc.addPage(); y = 110; }
    doc.moveTo(L, y).lineTo(R, y).lineWidth(1).strokeColor(GREEN).stroke();
    y += 14;
    label("Assessed and signed off by", L, y, col * 1.5); value(s.result.assessorName, L, y, col * 1.5, 11);
    doc.fillColor(MUTED).font("Helvetica").fontSize(8.5).text("Registered assessor · FPT Academy", L, y + 27);
    label("Signed off on", L + col * 1.6, y, col); value(`${fmtDate(s.result.signedOffAt)} ${fmtTime(s.result.signedOffAt)}`, L + col * 1.6, y, col * 1.4, 10, false);
    y += 48;
    doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(`Verification: statement ${s.statementNumber} · exam record ${s.session.id} · seal ${s.session.sealHash ? s.session.sealHash.slice(0, 32) + "…" : "—"}. The exam record, its answers and evidence are held tamper-evident by FPT Exam. To verify this statement contact FPT Academy quoting the statement number. This statement records the result of the assessment named above; certification is issued by the relevant quality council.`, L, y, { width: CW, lineGap: 1 });

    doc.end();
  });
}
