import { Router } from "express";

// Block 6: a sample of the FPTStaff exam-sync contract, served by FPT Exam
// itself when the Repl secret FPTSTAFF_MOCK=yes is set. Three sections of
// learners, four staff, and a receiving end for people and results pushed
// across (kept in memory - it is a stand-in, not a store). Every name says
// SAMPLE. Remove the secret and set the two real ones when FPTStaff is live.
// docs/fptstaff-sync-reference.md walks through this file as the reference
// implementation for the FPTStaff side.

export const SAMPLE_KEY = "sample";

const FIRST = ["Thandiwe", "Sipho", "Ayesha", "Johan", "Naledi", "Pieter", "Zanele", "Kagiso", "Rachel", "Lwazi", "Fatima", "Bongani", "Anele", "Ruan", "Nomvula", "Tebogo"];
const LAST = ["Mokoena", "Naidoo", "van der Merwe", "Dlamini", "Khumalo", "Botha", "Pillay", "Zulu", "Nkosi", "Petersen", "Mahlangu", "Sithole"];

interface SampleLearner { fptstaffId: string; name: string; email: string; idNumber: string; studentNumber: string; sectionId: string; status: "active"; updatedAt: string }

function makeLearners(sectionId: string, sectionNo: number, count: number): SampleLearner[] {
  const out: SampleLearner[] = [];
  for (let i = 0; i < count; i++) {
    const n = sectionNo * 100 + i;
    const name = `${FIRST[(n * 7) % FIRST.length]} ${LAST[(n * 5) % LAST.length]}`;
    // 13 digits, fixed and unique per learner, in a range no real ID uses (year 99, month 13).
    const idNumber = `99130${String(n).padStart(3, "0")}00${String(n % 100).padStart(2, "0")}9`.slice(0, 13);
    out.push({ fptstaffId: `fs-l-${sectionNo}-${i + 1}`, name: `${name} (SAMPLE)`, email: `sample.${sectionNo}.${i + 1}@example.com`, idNumber, studentNumber: `FPT-${2026}-${String(n).padStart(4, "0")}`, sectionId, status: "active", updatedAt: "2026-09-01T08:00:00Z" });
  }
  return out;
}

const SECTIONS = [
  { id: "fs-sec-1", name: "SAMPLE · Payroll Administrator · Durban · Sep 2026", qualificationTitle: "Occupational Certificate: Payroll Administrator", saqaQualificationId: "118706", site: "Durban", intake: "Sep 2026", status: "active" as const },
  { id: "fs-sec-2", name: "SAMPLE · Payroll Administrator · Johannesburg · Sep 2026", qualificationTitle: "Occupational Certificate: Payroll Administrator", saqaQualificationId: "118706", site: "Johannesburg", intake: "Sep 2026", status: "active" as const },
  { id: "fs-sec-3", name: "SAMPLE · Bookkeeping · Durban · Aug 2026", qualificationTitle: "National Certificate: Bookkeeping", saqaQualificationId: "58375", site: "Durban", intake: "Aug 2026", status: "active" as const },
];
const LEARNERS: SampleLearner[] = [...makeLearners("fs-sec-1", 1, 14), ...makeLearners("fs-sec-2", 2, 9), ...makeLearners("fs-sec-3", 3, 6)];
const STAFF = [
  { fptstaffId: "fs-s-1", name: "Sipho Dlamini (SAMPLE)", email: "sample.assessor1@example.com", roles: ["assessor"], employmentRelationship: "internal", registrationNumber: "ETDP-A-4471", status: "active" },
  { fptstaffId: "fs-s-2", name: "Rachel Petersen (SAMPLE)", email: "sample.assessor2@example.com", roles: ["assessor", "invigilator"], employmentRelationship: "external", registrationNumber: "SSETA-A-0912", status: "active" },
  { fptstaffId: "fs-s-3", name: "Kagiso Mahlangu (SAMPLE)", email: "sample.invig1@example.com", roles: ["invigilator"], employmentRelationship: "internal", registrationNumber: null, status: "active" },
  { fptstaffId: "fs-s-4", name: "Fatima Naidoo (SAMPLE)", email: "sample.invig2@example.com", roles: ["invigilator"], employmentRelationship: "external", registrationNumber: null, status: "active" },
];

// What FPT Exam pushed across (in memory - a stand-in).
const pushedLearners: { fptstaffId: string; examRef: string; name: string; email: string; idNumber: string | null; studentNumber: string | null; receivedAt: string }[] = [];
const pushedResults: { fptstaffResultId: string; examRef: string; receivedAt: string; summary: Record<string, unknown>; pdfBytes: number }[] = [];

export const sampleSyncRouter = Router();

sampleSyncRouter.use((req, res, next) => {
  const expected = process.env.FPTSTAFF_API_KEY || SAMPLE_KEY;
  if ((req.get("authorization") ?? "") !== `Bearer ${expected}`) return res.status(401).json({ error: "Unauthorised." });
  next();
});

// GET /api/exam-sync/sections
sampleSyncRouter.get("/sections", (_req, res) => {
  res.json({ sections: SECTIONS.map((s) => ({ ...s, learnerCount: LEARNERS.filter((l) => l.sectionId === s.id).length })) });
});

// GET /api/exam-sync/learners?section=&page=&pageSize=
sampleSyncRouter.get("/learners", (req, res) => {
  const section = typeof req.query.section === "string" ? req.query.section : null;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 100));
  const all = LEARNERS.filter((l) => !section || l.sectionId === section);
  const slice = all.slice((page - 1) * pageSize, page * pageSize);
  res.json({ learners: slice, nextPage: page * pageSize < all.length ? page + 1 : null, total: all.length });
});

// GET /api/exam-sync/staff
sampleSyncRouter.get("/staff", (_req, res) => res.json({ staff: STAFF }));

// POST /api/exam-sync/learners - a person registered on FPT Exam. FPTStaff
// matches on ID number, then email; otherwise creates. Answers with its id.
sampleSyncRouter.post("/learners", (req, res) => {
  const b = req.body ?? {};
  if (!b.examRef || !b.name || !b.email) return res.status(400).json({ error: "examRef, name and email are required." });
  const byId = b.idNumber ? LEARNERS.find((l) => l.idNumber === b.idNumber) ?? pushedLearners.find((l) => l.idNumber === b.idNumber) : null;
  const byEmail = LEARNERS.find((l) => l.email.toLowerCase() === String(b.email).toLowerCase()) ?? pushedLearners.find((l) => l.email.toLowerCase() === String(b.email).toLowerCase());
  const match = byId ?? byEmail;
  if (match) return res.json({ fptstaffId: match.fptstaffId, outcome: "matched" });
  const fptstaffId = `fs-new-${pushedLearners.length + 1}`;
  pushedLearners.push({ fptstaffId, examRef: b.examRef, name: b.name, email: b.email, idNumber: b.idNumber ?? null, studentNumber: b.studentNumber ?? null, receivedAt: new Date().toISOString() });
  res.status(201).json({ fptstaffId, outcome: "created" });
});

// POST /api/exam-sync/results - a signed-off result with its Statement. Idempotent on examRef.
sampleSyncRouter.post("/results", (req, res) => {
  const b = req.body ?? {};
  if (!b.examRef || !b.learner || !b.result || !b.statement?.pdfBase64) return res.status(400).json({ error: "examRef, learner, result and statement.pdfBase64 are required." });
  const dupe = pushedResults.find((r) => r.examRef === b.examRef);
  if (dupe) return res.json({ received: true, fptstaffResultId: dupe.fptstaffResultId, duplicate: true });
  const fptstaffResultId = `fs-r-${pushedResults.length + 1}`;
  pushedResults.push({ fptstaffResultId, examRef: b.examRef, receivedAt: new Date().toISOString(), summary: { learner: b.learner?.name, outcome: b.result?.outcome, mark: `${b.result?.totalMark}/${b.result?.totalMax}`, statement: b.statement?.number, integrity: b.integrity?.recommendation ?? null }, pdfBytes: Buffer.from(String(b.statement.pdfBase64), "base64").length });
  res.status(201).json({ received: true, fptstaffResultId });
});

// Sample only: what has been received, so the Administrator can see the push landed.
sampleSyncRouter.get("/received", (_req, res) => res.json({ learners: pushedLearners, results: pushedResults }));

export const isSampleSyncEnabled = () => /^(yes|true|1)$/i.test(process.env.FPTSTAFF_MOCK ?? "");
