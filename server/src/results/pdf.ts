import PDFDocument from "pdfkit";

// Block 8c: the shared FPT Academy report chrome - A4, Helvetica (Arial
// equivalent), brand green rule, CONFIDENTIAL header, numbered footer - plus a
// few layout helpers, so every report the archive produces looks like one
// family. The Statement of Results and the alignment matrix predate this file
// and draw their own identical chrome.

export const GREEN = "#6BBF3E", BLUE = "#2E86AB", INK = "#1B2A22", MUTED = "#5D6B60", LINE = "#D9E2DB", PALE = "#F3F8F4", AMBER = "#B7791F", RED = "#B42318";

export const fmtDate = (d: Date) => d.toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Johannesburg" });
export const fmtTime = (d: Date) => d.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" });
export const fmtTimeS = (d: Date) => d.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Africa/Johannesburg" });
export const fmtDateTime = (d: Date) => `${fmtDate(d)} ${fmtTime(d)}`;
export const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

export interface Report {
  doc: PDFKit.PDFDocument;
  L: () => number;
  R: () => number;
  CW: () => number;
  bottom: () => number;
  ensure: (h: number) => void;
  title: (main: string, sub: string, right?: string) => void;
  h2: (t: string) => void;
  h3: (t: string) => void;
  para: (t: string, opts?: { size?: number; color?: string; bold?: boolean }) => void;
  facts: (rows: [string, string][], cols?: number) => void;
  table: (head: string[], rows: string[][], widths: number[], opts?: { size?: number; zebra?: boolean; tone?: (row: string[], i: number) => string | null }) => void;
  box: (text: string, color: string, sub?: string) => void;
  finish: () => Promise<Buffer>;
}

export function report(opts: { title: string; headerRight: string; confidentialLine: string; landscape?: boolean; subject?: string }): Report {
  const doc = new PDFDocument({ size: "A4", layout: opts.landscape ? "landscape" : "portrait", margins: { top: 64, bottom: 64, left: 48, right: 48 }, info: { Title: opts.title, Author: "FPT Academy (Pty) Ltd", Subject: opts.subject ?? opts.title } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => { doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject); });

  let pageNo = 0;
  const chrome = () => {
    pageNo++;
    const savedBottom = doc.page.margins.bottom, savedY = doc.y;
    doc.page.margins.bottom = 0;
    doc.save();
    const W = doc.page.width, L = doc.page.margins.left, R = W - doc.page.margins.right, CW = R - L;
    doc.rect(0, 0, W, 8).fill(GREEN);
    doc.fontSize(7.5).fillColor(MUTED).font("Helvetica").text(opts.confidentialLine, L, 20, { width: CW * 0.58, lineBreak: false, ellipsis: true, height: 10 });
    doc.text(opts.headerRight, L + CW * 0.6, 20, { width: CW * 0.4, align: "right", lineBreak: false, ellipsis: true, height: 10 });
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

  const title = (main: string, sub: string, right?: string) => {
    doc.roundedRect(L(), 44, 34, 34, 8).fill(GREEN);
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(20).text("F", L(), 51, { width: 34, align: "center" });
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(17).text("FPT Academy", L() + 44, 46);
    doc.fillColor(MUTED).font("Helvetica").fontSize(9.5).text("Secure Exam Centre · FPT Exam", L() + 44, 66);
    doc.fillColor(BLUE).font("Helvetica-Bold").fontSize(20).text(main, L(), 48, { width: CW(), align: "right" });
    doc.fillColor(MUTED).font("Helvetica").fontSize(9.5).text(right ?? sub, L(), 74, { width: CW(), align: "right" });
    doc.moveTo(L(), 96).lineTo(R(), 96).lineWidth(1).strokeColor(GREEN).stroke();
    doc.y = 110;
    if (right) { doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text(sub, L(), doc.y, { width: CW() }); doc.moveDown(0.4); }
  };
  const h2 = (t: string) => { ensure(96); doc.moveDown(0.9); doc.fillColor(BLUE).font("Helvetica-Bold").fontSize(13).text(t, L()); doc.moveDown(0.3); };
  const h3 = (t: string) => { ensure(30); doc.moveDown(0.5); doc.fillColor(INK).font("Helvetica-Bold").fontSize(10.5).text(t, L()); doc.moveDown(0.15); };
  const para = (t: string, o: { size?: number; color?: string; bold?: boolean } = {}) => { ensure(24); doc.fillColor(o.color ?? INK).font(o.bold ? "Helvetica-Bold" : "Helvetica").fontSize(o.size ?? 9.5).text(t, L(), doc.y, { width: CW(), lineGap: 1.5 }); doc.moveDown(0.35); };

  const facts = (rows: [string, string][], cols = 3) => {
    const colW = CW() / cols;
    for (let i = 0; i < rows.length; i += cols) {
      const slice = rows.slice(i, i + cols);
      const heights = slice.map(([, v]) => { doc.font("Helvetica-Bold").fontSize(10); return doc.heightOfString(v || "—", { width: colW - 10 }); });
      const h = Math.max(...heights) + 20;
      ensure(h);
      const y = doc.y;
      slice.forEach(([k, v], j) => {
        const x = L() + j * colW;
        doc.fillColor(MUTED).font("Helvetica").fontSize(7.5).text(k.toUpperCase(), x, y, { width: colW - 10, characterSpacing: 0.4 });
        doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text(v || "—", x, y + 10, { width: colW - 10 });
      });
      doc.y = y + h;
    }
  };

  const table = (head: string[], rows: string[][], widths: number[], o: { size?: number; zebra?: boolean; tone?: (row: string[], i: number) => string | null } = {}) => {
    const size = o.size ?? 8.5;
    const total = widths.reduce((a, b) => a + b, 0);
    const ws = widths.map((w) => (w / total) * CW());
    const drawHead = () => {
      const y = doc.y;
      doc.font("Helvetica-Bold").fontSize(7);
      const hh = Math.max(16, ...head.map((h, i) => doc.heightOfString(h.toUpperCase(), { width: ws[i] - 8, characterSpacing: 0.3 }) + 8));
      doc.rect(L(), y, CW(), hh).fill(PALE);
      let x = L();
      head.forEach((h, i) => { doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(7).text(h.toUpperCase(), x + 4, y + 4.5, { width: ws[i] - 8, characterSpacing: 0.3 }); x += ws[i]; });
      doc.y = y + hh;
    };
    ensure(40);
    drawHead();
    rows.forEach((r, ri) => {
      doc.font("Helvetica").fontSize(size);
      const h = Math.max(14, ...r.map((c, i) => doc.heightOfString(c || "—", { width: ws[i] - 8 }) + 6));
      if (doc.y + h > bottom()) { doc.addPage(); doc.y = 100; drawHead(); }
      const y = doc.y;
      if (o.zebra !== false && ri % 2 === 1) doc.rect(L(), y, CW(), h).fill("#FAFCFA");
      const tone = o.tone?.(r, ri);
      if (tone) { doc.rect(L(), y, 3, h).fill(tone); }
      let x = L();
      r.forEach((c, i) => { doc.fillColor(INK).font("Helvetica").fontSize(size).text(c || "—", x + 4, y + 3, { width: ws[i] - 8, lineGap: 0.5 }); x += ws[i]; });
      doc.moveTo(L(), y + h).lineTo(R(), y + h).lineWidth(0.4).strokeColor(LINE).stroke();
      doc.y = y + h;
    });
    doc.moveDown(0.5);
  };

  const box = (text: string, color: string, sub?: string) => {
    doc.font("Helvetica-Bold").fontSize(13);
    const th = doc.heightOfString(text, { width: CW() - 24 });
    doc.font("Helvetica").fontSize(8.5);
    const sh = sub ? doc.heightOfString(sub, { width: CW() - 24 }) : 0;
    const h = 12 + th + (sub ? 4 + sh : 0) + 10;
    ensure(h + 10);
    const y = doc.y;
    doc.roundedRect(L(), y, CW(), h, 6).lineWidth(1.2).strokeColor(color).stroke();
    doc.rect(L(), y, 6, h).fill(color);
    doc.fillColor(color).font("Helvetica-Bold").fontSize(13).text(text, L() + 16, y + 12, { width: CW() - 24 });
    if (sub) doc.fillColor(MUTED).font("Helvetica").fontSize(8.5).text(sub, L() + 16, y + 12 + th + 4, { width: CW() - 24 });
    doc.y = y + h + 10;
  };

  return { doc, L, R, CW, bottom, ensure, title, h2, h3, para, facts, table, box, finish: () => { doc.end(); return done; } };
}
