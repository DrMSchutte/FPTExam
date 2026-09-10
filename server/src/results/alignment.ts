import PDFDocument from "pdfkit";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { assessmentInstruments, qualifications } from "../db/schema.js";
import type { Question, InstrumentQualityReview } from "../types.js";
import { BLUEPRINT } from "../ai/paperBlueprint.js";

// The alignment matrix report for one paper: the standard-check verdict, the
// paper's shape, cognitive demand, every outcome and criterion with the
// questions that evidence it, the question × outcome grid, and the question
// index. A4, FPT Academy branding, confidential header and footer - the
// quality-assurance record an assessor, moderator or QCTO verifier asks for.

const GREEN = "#6BBF3E", BLUE = "#2E86AB", INK = "#1B2A22", MUTED = "#5D6B60", LINE = "#D9E2DB";
const fmtDateTime = (d: Date) => d.toLocaleString("en-ZA", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" });
const VERDICT_WORD: Record<string, string> = { meets_standard: "MEETS THE STANDARD", meets_with_minor_gaps: "MEETS THE STANDARD WITH MINOR GAPS", does_not_meet: "DOES NOT MEET THE STANDARD" };
const TYPE_WORD: Record<string, string> = { mcq: "Multiple choice", short_answer: "Knowledge & depth", long_answer: "Comprehensive", practical_upload: "Practical upload" };
const ROUTE_WORD: Record<string, string> = { qcto_curricula_builder: "Curricula Builder · QCTO", legacy_saqa: "Legacy FISA · drafted from SAQA", built_here: "Built here", curricula_builder_other: "Curricula Builder · other course" };

export async function loadAlignment(instrumentId: string) {
  const [instrument] = await db.select().from(assessmentInstruments).where(eq(assessmentInstruments.id, instrumentId));
  if (!instrument) return null;
  const [qualification] = await db.select().from(qualifications).where(eq(qualifications.id, instrument.qualificationId));
  return { instrument, qualification, review: (instrument.qualityReview as InstrumentQualityReview | null) ?? null, questions: (instrument.questions as Question[]) ?? [] };
}

export function renderAlignment(d: NonNullable<Awaited<ReturnType<typeof loadAlignment>>>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const { instrument, qualification, review, questions } = d;
    const doc = new PDFDocument({ size: "A4", margins: { top: 64, bottom: 64, left: 48, right: 48 }, info: { Title: `Alignment matrix - ${qualification.title} ${instrument.version}`, Author: "FPT Academy (Pty) Ltd" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    let pageNo = 0;
    const chrome = () => {
      pageNo++;
      const savedBottom = doc.page.margins.bottom, savedY = doc.y;
      doc.page.margins.bottom = 0;
      doc.save();
      const W = doc.page.width, L = doc.page.margins.left, R = W - doc.page.margins.right, CW = R - L;
      doc.rect(0, 0, W, 8).fill(GREEN);
      doc.fontSize(8).fillColor(MUTED).font("Helvetica").text("CONFIDENTIAL — assessment quality-assurance record. FPT Academy (Pty) Ltd", L, 20, { width: CW });
      doc.text(`${qualification.title} · ${instrument.version}`, L, 20, { width: CW, align: "right" });
      const fy = doc.page.height - 40;
      doc.moveTo(L, fy - 8).lineTo(R, fy - 8).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.fontSize(7.5).fillColor(MUTED).text("FPT Academy (Pty) Ltd · QCTO- and SETA-accredited skills development provider · Durban, KwaZulu-Natal · fptacademy.co.za", L, fy, { width: CW * 0.8 });
      doc.text(`Page ${pageNo}`, L, fy, { width: CW, align: "right", lineBreak: false });
      doc.restore();
      doc.page.margins.bottom = savedBottom;
      doc.y = savedY;
    };
    doc.on("pageAdded", chrome);
    chrome();

    const L = () => doc.page.margins.left, R = () => doc.page.width - doc.page.margins.right, CW = () => R() - L();
    const bottom = () => doc.page.height - 90;
    const ensure = (h: number) => { if (doc.y + h > bottom()) { doc.addPage(); doc.y = 100; } };
    const h2 = (t: string) => { ensure(40); doc.moveDown(0.8); doc.fillColor(BLUE).font("Helvetica-Bold").fontSize(13).text(t, L()); doc.moveDown(0.3); };
    const label = (t: string) => doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(t.toUpperCase(), { characterSpacing: 0.4 });
    const value = (t: string, size = 11) => doc.fillColor(INK).font("Helvetica-Bold").fontSize(size).text(t);

    // Title block
    doc.roundedRect(L(), 44, 34, 34, 8).fill(GREEN);
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(20).text("F", L(), 51, { width: 34, align: "center" });
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(17).text("FPT Academy", L() + 44, 46);
    doc.fillColor(MUTED).font("Helvetica").fontSize(9.5).text("Secure Exam Centre · FPT Exam", L() + 44, 66);
    doc.fillColor(BLUE).font("Helvetica-Bold").fontSize(20).text("Alignment Matrix", L(), 48, { width: CW(), align: "right" });
    doc.fillColor(MUTED).font("Helvetica").fontSize(9.5).text(`Generated ${fmtDateTime(new Date())}`, L(), 74, { width: CW(), align: "right" });
    doc.moveTo(L(), 96).lineTo(R(), 96).lineWidth(1).strokeColor(GREEN).stroke();
    doc.y = 108;

    // Paper facts
    const totalMarks = questions.reduce((s, q) => s + q.maxMark, 0);
    const col = CW() / 3;
    const y0 = doc.y;
    doc.text("", L(), y0); label("Qualification"); value(qualification.title, 12);
    doc.fillColor(MUTED).font("Helvetica").fontSize(9.5).text(`${qualification.qctoRegistrationType.toUpperCase().replace("NON_QCTO", "Non-QCTO")}${qualification.saqaQualificationId ? ` · SAQA ${qualification.saqaQualificationId}` : ""}${qualification.nqfLevel ? ` · NQF Level ${qualification.nqfLevel}` : ""}`);
    const y1 = doc.y + 8;
    doc.text("", L(), y1); label("Paper"); value(instrument.version, 10.5);
    doc.text("", L() + col, y1); label("Route"); value(ROUTE_WORD[instrument.intakeRoute] ?? instrument.intakeRoute, 10.5);
    doc.text("", L() + col * 2, y1); label("Size"); value(`${questions.length} questions · ${totalMarks} marks · ${instrument.timeAllocationMinutes} min`, 10.5);
    doc.y = Math.max(doc.y, y1 + 32);

    // Verdict box
    const verdict = review?.verdict ?? null;
    const tone = verdict === "meets_standard" ? ["#F0F8EA", GREEN, "#3C7A1E"] : verdict === "meets_with_minor_gaps" ? ["#FFF7E6", "#E0A020", "#8A5A00"] : verdict ? ["#FDECEC", "#D9534F", "#8A1F1B"] : ["#F3F7F4", LINE, MUTED];
    doc.moveDown(0.6);
    const vy = doc.y;
    const summary = review?.summary ?? "This paper has not been checked against the assessment standard yet.";
    const summaryH = doc.font("Helvetica").fontSize(9.5).heightOfString(summary, { width: CW() - 36 });
    ensure(summaryH + 70);
    doc.roundedRect(L(), doc.y, CW(), summaryH + 62, 10).fillAndStroke(tone[0], tone[1]);
    doc.fillColor(MUTED).font("Helvetica").fontSize(8).text("STANDARD CHECK VERDICT", L() + 18, vy + 14, { characterSpacing: 0.4 });
    doc.fillColor(tone[2]).font("Helvetica-Bold").fontSize(15).text(verdict ? VERDICT_WORD[verdict] : "NOT CHECKED", L() + 18, vy + 26);
    if (review) doc.fillColor(MUTED).font("Helvetica").fontSize(8.5).text(`Checked ${fmtDateTime(new Date(review.generatedAt))} · gate: ${instrument.intakeStatus}${instrument.intakeOverrideReason ? ` (override: ${instrument.intakeOverrideReason})` : ""}`, L() + 18, vy + 46, { width: CW() - 36 });
    doc.fillColor(INK).font("Helvetica").fontSize(9.5).text(summary, L() + 18, vy + 58, { width: CW() - 36 });
    doc.y = vy + summaryH + 62 + 10;

    if (review) {
      const p = review.profile;
      // Shape + demand facts
      h2("Paper shape and cognitive demand");
      const shape = p.shape;
      const facts: [string, string][] = [
        ["Multiple choice", shape ? `${shape.mcq} (standard ${BLUEPRINT.mcq.min}+)` : String(p.byType["mcq"]?.count ?? 0)],
        ["Knowledge & depth", shape ? `${shape.knowledge} (standard ${BLUEPRINT.knowledge.count})` : String(p.byType["short_answer"]?.count ?? 0)],
        ["Comprehensive", shape ? `${shape.comprehensive} (standard ${BLUEPRINT.comprehensive.count})` : String(p.byType["long_answer"]?.count ?? 0)],
        ["Higher-order marks", `${p.higherOrderMarkShare}% (expected ${p.expectedHigherOrderShare.min}–${p.expectedHigherOrderShare.max}%)`],
        ["Minutes per mark", String(p.minutesPerMark)],
        ["Coverage", `${review.coverage.filter((c) => c.status === "covered").length} covered · ${review.coverage.filter((c) => c.status === "partial").length} partial · ${review.coverage.filter((c) => c.status === "not_covered").length} not covered`],
      ];
      const fy = doc.y;
      facts.forEach(([k, v], i) => {
        const x = L() + (i % 3) * col, y = fy + Math.floor(i / 3) * 34;
        doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(k.toUpperCase(), x, y, { characterSpacing: 0.4 });
        doc.fillColor(INK).font("Helvetica-Bold").fontSize(10.5).text(v, x, y + 11, { width: col - 10 });
      });
      doc.y = fy + 72;
      // Bloom line
      const bloom = (["remember", "understand", "apply", "analyse", "evaluate", "create"] as const).map((b) => `${b} ${p.byBloom[b]?.marks ?? 0} mk / ${p.byBloom[b]?.count ?? 0} q`).join(" · ");
      doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(`Bloom's taxonomy (marks / questions): ${bloom}.`, L(), doc.y, { width: CW() });
      if (review.bloomAssessment) { doc.moveDown(0.3); doc.fillColor(INK).font("Helvetica").fontSize(9.5).text(review.bloomAssessment, L(), doc.y, { width: CW() }); }
      if (shape && shape.shortfalls.length) { doc.moveDown(0.3); doc.fillColor("#8A5A00").font("Helvetica").fontSize(9.5).text(`Shape shortfalls: ${shape.shortfalls.join("; ")}.`, L(), doc.y, { width: CW() }); }

      // Coverage table
      h2("Coverage of the assessment standard");
      const idxOf = new Map(questions.map((q, i) => [q.id, i + 1]));
      const c1 = L(), c2 = L() + CW() * 0.56, c3 = L() + CW() * 0.68, c4 = L() + CW() * 0.9, c5 = R();
      const head = () => {
        doc.rect(L(), doc.y, CW(), 18).fill("#F3F7F4");
        const y = doc.y + 5;
        doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8);
        doc.text("OUTCOME / CRITERION", c1 + 6, y, { width: c2 - c1 - 10 }); doc.text("STATUS", c2, y, { width: c3 - c2 }); doc.text("QUESTIONS", c3, y, { width: c4 - c3 - 6 }); doc.text("MARKS", c4, y, { width: c5 - c4 - 6, align: "right" });
        doc.y += 18;
      };
      head();
      for (const kind of ["elo", "ac"] as const) {
        const rows = review.coverage.filter((c) => c.kind === kind);
        if (!rows.length) continue;
        ensure(24);
        doc.fillColor(BLUE).font("Helvetica-Bold").fontSize(8.5).text(kind === "elo" ? "EXIT LEVEL OUTCOMES" : "ASSOCIATED ASSESSMENT CRITERIA", c1 + 6, doc.y + 6); doc.y += 20;
        for (const c of rows) {
          const qs = c.questionIds.map((id) => `Q${idxOf.get(id) ?? "?"}`).join(", ") || "—";
          const refH = doc.font("Helvetica").fontSize(9).heightOfString(c.ref, { width: c2 - c1 - 12 });
          const noteH = c.note ? doc.font("Helvetica").fontSize(7.5).heightOfString(c.note, { width: c2 - c1 - 12 }) : 0;
          const qsH = doc.font("Helvetica").fontSize(9).heightOfString(qs, { width: c4 - c3 - 8 });
          const h = Math.max(refH + noteH + 10, qsH + 8, 20);
          if (doc.y + h > bottom()) { doc.addPage(); doc.y = 100; head(); }
          const y = doc.y;
          doc.fillColor(INK).font("Helvetica").fontSize(9).text(c.ref, c1 + 6, y + 4, { width: c2 - c1 - 12 });
          if (c.note) doc.fillColor(MUTED).font("Helvetica").fontSize(7.5).text(c.note, c1 + 6, y + 4 + refH + 1, { width: c2 - c1 - 12 });
          const statusColor = c.status === "covered" ? "#3C7A1E" : c.status === "partial" ? "#8A5A00" : "#8A1F1B";
          doc.fillColor(statusColor).font("Helvetica-Bold").fontSize(8.5).text(c.status === "covered" ? "Covered" : c.status === "partial" ? "Partial" : "Not covered", c2, y + 4, { width: c3 - c2 });
          doc.fillColor(INK).font("Helvetica").fontSize(9).text(qs, c3, y + 4, { width: c4 - c3 - 8 });
          doc.fillColor(INK).font("Helvetica-Bold").fontSize(9).text(String(c.marks), c4, y + 4, { width: c5 - c4 - 6, align: "right" });
          doc.y = y + h;
          doc.moveTo(L(), doc.y).lineTo(R(), doc.y).lineWidth(0.4).strokeColor(LINE).stroke();
        }
      }

      // Matrix grid (landscape pages, chunked)
      const outcomes = review.coverage;
      if (outcomes.length && questions.length) {
        const perPage = 30;
        for (let start = 0; start < questions.length; start += perPage) {
          const slice = questions.slice(start, start + perPage);
          doc.addPage({ size: "A4", layout: "landscape", margins: { top: 64, bottom: 64, left: 40, right: 40 } });
          doc.y = 100;
          doc.fillColor(BLUE).font("Helvetica-Bold").fontSize(13).text(`Question × outcome matrix${questions.length > perPage ? ` (questions ${start + 1}–${start + slice.length})` : ""}`, L());
          doc.moveDown(0.4);
          const labelW = 190, cell = Math.min(22, (CW() - labelW) / slice.length), rowH = 15;
          let y = doc.y + 4;
          doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(7);
          slice.forEach((q, i) => doc.text(`Q${start + i + 1}`, L() + labelW + i * cell, y, { width: cell, align: "center" }));
          y += 12;
          doc.fillColor(MUTED).font("Helvetica").fontSize(6);
          slice.forEach((q, i) => doc.text(`${q.maxMark}`, L() + labelW + i * cell, y, { width: cell, align: "center" }));
          y += 10;
          for (const o of outcomes) {
            if (y + rowH > bottom()) {
              doc.addPage({ size: "A4", layout: "landscape", margins: { top: 64, bottom: 64, left: 40, right: 40 } }); y = 100;
              doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(7); slice.forEach((q, i) => doc.text(`Q${start + i + 1}`, L() + labelW + i * cell, y, { width: cell, align: "center" })); y += 22;
            }
            doc.moveTo(L(), y + rowH).lineTo(L() + labelW + slice.length * cell, y + rowH).lineWidth(0.3).strokeColor(LINE).stroke();
            const short = o.ref.length > 48 ? o.ref.slice(0, 46) + "…" : o.ref;
            doc.fillColor(o.status === "not_covered" ? "#8A1F1B" : INK).font(o.kind === "elo" ? "Helvetica-Bold" : "Helvetica").fontSize(7).text(short, L(), y + 3, { width: labelW - 6, lineBreak: false });
            slice.forEach((q, i) => {
              if (o.questionIds.includes(q.id)) { doc.circle(L() + labelW + i * cell + cell / 2, y + rowH / 2, 3.2).fill(GREEN); }
            });
            y += rowH;
          }
          doc.y = y + 10;
          doc.fillColor(MUTED).font("Helvetica").fontSize(7.5).text("A green dot marks a question that evidences the outcome / criterion (as judged by the standard check). The number under each question is its marks.", L(), doc.y, { width: CW() });
        }
      }

      // Recommendations
      if (review.recommendations.length || review.questionIssues.length) {
        doc.addPage({ size: "A4", layout: "portrait", margins: { top: 64, bottom: 64, left: 48, right: 48 } });
        doc.y = 100;
        h2("Recommendations and question issues");
        review.recommendations.forEach((r, i) => { ensure(30); doc.fillColor(INK).font("Helvetica").fontSize(9.5).text(`${i + 1}. ${r}`, L(), doc.y, { width: CW() }); doc.moveDown(0.3); });
        for (const iss of review.questionIssues) {
          ensure(30);
          doc.fillColor(iss.severity === "critical" ? "#8A1F1B" : iss.severity === "warning" ? "#8A5A00" : MUTED).font("Helvetica-Bold").fontSize(9).text(`Q${idxOf.get(iss.questionId) ?? "?"} · ${iss.severity}`, L(), doc.y);
          doc.fillColor(INK).font("Helvetica").fontSize(9).text(`${iss.issue} ${iss.suggestion ? `— ${iss.suggestion}` : ""}`, L() + 12, doc.y, { width: CW() - 12 });
          doc.moveDown(0.3);
        }
      }
    }

    // Question index
    doc.addPage({ size: "A4", layout: "portrait", margins: { top: 64, bottom: 64, left: 48, right: 48 } });
    doc.y = 100;
    h2("Question index");
    const q1 = L(), q2 = L() + 34, q3 = L() + 140, q4 = L() + 210, q5 = L() + 250, q6 = R();
    const qhead = () => {
      doc.rect(L(), doc.y, CW(), 18).fill("#F3F7F4");
      const y = doc.y + 5; doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8);
      doc.text("Q", q1 + 6, y); doc.text("TYPE", q2, y); doc.text("BLOOM'S", q3, y); doc.text("MARKS", q4, y); doc.text("OUTCOME · CRITERION · QUESTION", q5, y, { width: q6 - q5 });
      doc.y += 18;
    };
    qhead();
    questions.forEach((q, i) => {
      const text = `${[q.eloRef, q.acRef].filter(Boolean).join(" · ")}${q.eloRef || q.acRef ? " — " : ""}${q.prompt.replace(/\s+/g, " ").slice(0, 160)}${q.prompt.length > 160 ? "…" : ""}`;
      const h = Math.max(16, doc.font("Helvetica").fontSize(8).heightOfString(text, { width: q6 - q5 - 6 }) + 6);
      if (doc.y + h > bottom()) { doc.addPage(); doc.y = 100; qhead(); }
      const y = doc.y;
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(8.5).text(`Q${i + 1}`, q1 + 6, y + 3);
      doc.fillColor(INK).font("Helvetica").fontSize(8).text(TYPE_WORD[q.type] ?? q.type, q2, y + 3, { width: q3 - q2 - 4 });
      doc.text(q.bloomLevel ?? "—", q3, y + 3, { width: q4 - q3 - 4 });
      doc.text(String(q.maxMark), q4, y + 3, { width: q5 - q4 - 6 });
      doc.text(text, q5, y + 3, { width: q6 - q5 - 6 });
      doc.y = y + h;
      doc.moveTo(L(), doc.y).lineTo(R(), doc.y).lineWidth(0.3).strokeColor(LINE).stroke();
    });
    doc.moveDown(1);
    doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(`This report is generated by FPT Exam from the paper as stored and the assessment-standard check recorded against it. Model answers and rubrics are not included; they never leave the marking record. Paper id ${instrument.id}.`, L(), doc.y, { width: CW() });
    doc.end();
  });
}
