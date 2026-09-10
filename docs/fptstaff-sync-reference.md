# FPTStaff: building the exam-sync (reference implementation)

Hand this page to whoever builds the FPTStaff side — a person or a Claude session in the
FPTStaff repository. It is a complete, drop-in Express router for the contract in
`fptstaff-contract.md`, with the five mapping points to fill in from FPTStaff's own data
model, how to issue the key, and how to prove it works against FPT Exam.

FPT Exam's side is built and tested (Block 6, 10 Sep 2026) against a sample that implements
this exact contract — `server/src/integrations/fptstaff/sampleSync.ts` on FPT Exam is the
same shape as the router below, with sample data instead of FPTStaff's database.

## What FPTStaff exposes

| Route | Purpose |
|---|---|
| `GET  /api/exam-sync/sections` | the groups FPT Exam pulls learners by |
| `GET  /api/exam-sync/learners?section=&page=&pageSize=` | learners in a section, paged |
| `GET  /api/exam-sync/staff` | assessors and invigilators |
| `POST /api/exam-sync/learners` | a person registered on FPT Exam — match or create, answer with FPTStaff's id |
| `POST /api/exam-sync/results` | a signed-off result with its Statement of Results PDF |

## The router (TypeScript, Express)

```ts
// src/routes/examSync.ts  (FPTStaff)
import { Router } from "express";
export const examSyncRouter = Router();

// ---- 1. Authentication -----------------------------------------------------
// One long random key, kept in FPTStaff's secrets as EXAM_SYNC_API_KEY and given
// to FPT Exam as FPTSTAFF_API_KEY. Anything else -> 401.
examSyncRouter.use((req, res, next) => {
  const expected = process.env.EXAM_SYNC_API_KEY;
  if (!expected) return res.status(503).json({ error: "Exam sync is not configured (EXAM_SYNC_API_KEY)." });
  if (req.get("authorization") !== `Bearer ${expected}`) return res.status(401).json({ error: "Unauthorised." });
  next();
});
// Results carry a PDF (base64, typically 5-50 KB): allow a few MB on this router.
examSyncRouter.use(require("express").json({ limit: "8mb" }));

// ---- 2. Shapes FPT Exam expects -----------------------------------------------
interface Section { id: string; name: string; qualificationTitle: string | null; saqaQualificationId: string | null; site: string | null; intake: string | null; learnerCount: number; status: "active" | "closed" }
interface Learner { fptstaffId: string; name: string; email: string; idNumber: string | null /* 13 digits */; studentNumber: string | null; sectionId: string; status: "active" | "inactive"; updatedAt: string }
interface Staff { fptstaffId: string; name: string; email: string; roles: ("assessor" | "invigilator")[]; employmentRelationship: "internal" | "external" | null; registrationNumber: string | null; status: "active" | "inactive" }

// ---- 3. Mapping points: fill in from FPTStaff's own model -----------------------
async function listSections(): Promise<Section[]> {
  // TODO: FPTStaff's groups of learners (intake / class / site group) with a
  //       count of active learners in each.
  throw new Error("map me");
}
async function listLearners(sectionId: string, page: number, pageSize: number): Promise<{ learners: Learner[]; nextPage: number | null }> {
  // TODO: learners in the section. idNumber MUST be the 13-digit SA ID number -
  //       it is the student identifier on FPT Exam; a learner without one is rejected there.
  throw new Error("map me");
}
async function listStaff(): Promise<Staff[]> {
  // TODO: every active assessor and invigilator with their registration number.
  throw new Error("map me");
}
async function matchOrCreateLearner(p: { examRef: string; name: string; email: string; idNumber: string | null; studentNumber: string | null }): Promise<{ fptstaffId: string; outcome: "created" | "matched" | "updated" }> {
  // TODO: find by ID number, then by email (case-insensitive). Never create a
  //       duplicate. Store examRef as the FPT Exam reference on the person.
  throw new Error("map me");
}
async function storeResult(r: any): Promise<{ fptstaffResultId: string; duplicate: boolean }> {
  // TODO: idempotent on r.examRef. Store outcome, marks, assessor, sign-off time,
  //       integrity recommendation, and the Statement PDF
  //       (Buffer.from(r.statement.pdfBase64, "base64")) against the learner
  //       (r.learner.fptstaffId, else match on r.learner.idNumber). Then start
  //       FPTStaff's own moderation / verification flow for a competent result.
  throw new Error("map me");
}

// ---- 4. Routes -------------------------------------------------------------------
examSyncRouter.get("/sections", async (_req, res) => res.json({ sections: await listSections() }));
examSyncRouter.get("/learners", async (req, res) => {
  const section = String(req.query.section ?? "");
  if (!section) return res.status(400).json({ error: "section is required." });
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 100));
  res.json(await listLearners(section, page, pageSize));
});
examSyncRouter.get("/staff", async (_req, res) => res.json({ staff: await listStaff() }));
examSyncRouter.post("/learners", async (req, res) => {
  const b = req.body ?? {};
  if (!b.examRef || !b.name || !b.email) return res.status(400).json({ error: "examRef, name and email are required." });
  const r = await matchOrCreateLearner({ examRef: b.examRef, name: b.name, email: b.email, idNumber: b.idNumber ?? null, studentNumber: b.studentNumber ?? null });
  res.status(r.outcome === "created" ? 201 : 200).json(r);
});
examSyncRouter.post("/results", async (req, res) => {
  const b = req.body ?? {};
  if (!b.examRef || !b.learner || !b.result || !b.statement?.pdfBase64) return res.status(400).json({ error: "examRef, learner, result and statement.pdfBase64 are required." });
  const r = await storeResult(b);
  res.status(r.duplicate ? 200 : 201).json({ received: true, ...r });
});
```

Mount it once: `app.use("/api/exam-sync", examSyncRouter);`

## Rules the mapping must respect

- **ID number on every learner.** It is the student identifier on FPT Exam and prints on
  the Statement of Results.
- **Never duplicate a person.** Match on ID number first, email second.
- **Results are idempotent on `examRef`.** FPT Exam retries a failed delivery; the second
  arrival must answer `duplicate: true` with the same `fptstaffResultId`.
- **Moderation, verification and certification stay on FPTStaff.** FPT Exam's result push
  is the hand-over point.

## Issuing the key and connecting

1. On FPTStaff, generate one key (`openssl rand -hex 32`), store it as the secret
   `EXAM_SYNC_API_KEY`. Never commit it.
2. On the FPT Exam Repl, set `FPTSTAFF_BASE_URL` to FPTStaff's origin and
   `FPTSTAFF_API_KEY` to the same key. Remove `FPTSTAFF_MOCK` if set.
3. On FPT Exam → *Register People* → **Pull from FPTStaff** → **Test connection**. It reports
   reachable → key accepted → contract matched → section and staff counts. Then *Results* →
   **Push now** delivers every result that queued while FPTStaff was not connected.

## Proving it from the command line

```bash
curl -s -H "Authorization: Bearer $KEY" "$FS/api/exam-sync/sections"
curl -s -H "Authorization: Bearer $KEY" "$FS/api/exam-sync/learners?section=<id>&page=1&pageSize=50"
curl -s -H "Authorization: Bearer $KEY" "$FS/api/exam-sync/staff"
curl -s -o /dev/null -w "%{http_code}\n" "$FS/api/exam-sync/sections"          # expect 401
```

FPT Exam validates every response against the contract and names the field that is wrong
(for example `learners.3.idNumber Invalid`).
