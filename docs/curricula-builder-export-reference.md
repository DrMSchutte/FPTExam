# Curricula Builder: building the exam export (reference implementation)

This is the page to hand to whoever builds the Curricula Builder side — a person or a
Claude session working in the Curricula Builder repository. It gives them a complete,
drop-in Express router that satisfies the contract in `curricula-builder-contract.md`,
the four mapping points they have to fill in from Curricula Builder's own data model,
how to issue the key, and how to prove it works against FPT Exam.

FPT Exam already has its receiving end built and tested (Block 7, 10 Sep 2026), against a
sample export that implements this exact contract (`server/src/integrations/curriculaBuilder/sampleExport.ts`
on FPT Exam — the same shape as the router below, with sample data instead of a database).

## What Curricula Builder has to expose

Two GET routes under `/api/exam-export`, bearer-token protected, returning **released**
assessments only:

| Route | Returns |
|---|---|
| `GET /api/exam-export/assessments?kind=qcto\|other` | every released version of every assessment of that kind (summary fields) |
| `GET /api/exam-export/assessments/:id?version=…` | one assessment in full; without `version`, the latest release |

An assessment keeps the same `id` across releases; each release has its own `version`.
FPT Exam never imports the same `id` + `version` twice, and when a newer version is pulled
in the older paper on FPT Exam is marked superseded and can no longer be scheduled.

## The router (TypeScript, Express)

```ts
// src/routes/examExport.ts  (Curricula Builder)
import { Router } from "express";

export const examExportRouter = Router();

// ---- 1. Authentication -----------------------------------------------------
// One long random key, kept in Curricula Builder's secrets as EXAM_EXPORT_API_KEY
// and given to FPT Exam as CURRICULA_BUILDER_API_KEY. Anything else -> 401.
examExportRouter.use((req, res, next) => {
  const expected = process.env.EXAM_EXPORT_API_KEY;
  if (!expected) return res.status(503).json({ error: "Exam export is not configured (EXAM_EXPORT_API_KEY)." });
  if (req.get("authorization") !== `Bearer ${expected}`) return res.status(401).json({ error: "Unauthorised." });
  next();
});

// ---- 2. The shapes FPT Exam expects -----------------------------------------
type Kind = "qcto" | "other";
interface Summary {
  id: string;                       // Curricula Builder's stable id for the assessment
  title: string;                    // e.g. "EISA Paper 1 — 2026 November"
  qualificationTitle: string;       // e.g. "Occupational Certificate: Payroll Administrator"
  kind: Kind;                       // qcto = FISA/EISA paper; other = CPD or any other course assessment
  qctoRegistrationType: "fisa" | "eisa" | null;   // null for kind=other
  saqaQualificationId: string | null;             // null for kind=other
  nqfLevel: number | null;
  version: string;                  // one per release, e.g. "2026-Nov-P1"
  updatedAt: string;                // ISO date-time of the release
}
interface Question {
  id: string;
  type: "mcq" | "short_answer" | "long_answer";   // practical_upload is not sat on FPT Exam
  prompt: string;
  maxMark: number;
  options?: string[];               // mcq only
  modelAnswerOrRubric: string;      // REQUIRED - what the AI review and the assessor mark against
  eloRef?: string;                  // e.g. "ELO 2" - marks per outcome on the Statement of Results
  acRef?: string;
  bloomLevel?: "remember" | "understand" | "apply" | "analyse" | "evaluate" | "create";
}
interface Full extends Summary {
  timeAllocationMinutes: number;
  permittedMaterials: string[];
  passMarkOrCompetencyRule: string | null;        // e.g. "50% overall"
  exitLevelOutcomes: string[];      // full ELO text, in order
  assessmentCriteria: string[];     // full AC text, in order
  questions: Question[];
}

// ---- 3. Mapping points: fill these in from Curricula Builder's own model -----
// (a) Which assessments are released? Only these may be listed.
async function listReleased(kind: Kind): Promise<Summary[]> {
  // TODO: query Curricula Builder's assessments where status = released/approved
  //       and (kind === "qcto" ? qualification is a QCTO FISA/EISA : everything else),
  //       one row per released version.
  throw new Error("map me");
}
// (b) One release in full.
async function loadRelease(id: string, version?: string): Promise<Full | null> {
  // TODO: load the assessment; pick the named version or the latest release;
  //       map its sections/questions to Question[] above. Every question MUST
  //       carry modelAnswerOrRubric - FPT Exam's standard check blocks a paper without it.
  throw new Error("map me");
}

// ---- 4. The two routes --------------------------------------------------------
examExportRouter.get("/assessments", async (req, res) => {
  const kind: Kind = req.query.kind === "other" ? "other" : "qcto";
  res.json({ assessments: await listReleased(kind) });
});

examExportRouter.get("/assessments/:id", async (req, res) => {
  const version = typeof req.query.version === "string" ? req.query.version : undefined;
  const full = await loadRelease(req.params.id, version);
  if (!full) return res.status(404).json({ error: "No released assessment with that id." });
  res.json(full);
});
```

Mount it once: `app.use("/api/exam-export", examExportRouter);`

## Rules the mapping must respect

- **Released only.** A draft on Curricula Builder must never appear in the list.
- **Every question is answerable in the sitting.** FPT Exam is a proctored exam room:
  no research, uploads, portfolios, workplace evidence, "over N days", or draw/plot
  tasks. FPT Exam's standard check blocks such questions; better not to export them.
- **Every question has `modelAnswerOrRubric`.** It is what the AI Response-Review and the
  registered assessor mark against.
- **`eloRef` on every question.** The Statement of Results reports marks per exit-level
  outcome; questions without an `eloRef` fall under "General".
- **A correction is a new version.** Fix on Curricula Builder, release with a new
  `version`; FPT Exam pulls it and supersedes the old paper.

## Issuing the key and connecting

1. On Curricula Builder, generate one key (e.g. `openssl rand -hex 32`) and store it as the
   secret `EXAM_EXPORT_API_KEY`. Never commit it.
2. On the FPT Exam Repl, set `CURRICULA_BUILDER_BASE_URL` to Curricula Builder's origin
   (e.g. `https://curriculabuilder.fptacademy.co.za`) and `CURRICULA_BUILDER_API_KEY` to
   the same key. Remove `CURRICULA_BUILDER_MOCK` if it is set.
3. On FPT Exam → *Set up an Assessment* → *QCTO FISA / EISA* → **Test connection**. It
   reports, in order: reachable → key accepted → list matches the contract → counts.

## Proving it from the command line

```bash
# list (expect 200 and {"assessments":[...]})
curl -s -H "Authorization: Bearer $KEY" "$CB/api/exam-export/assessments?kind=qcto"
# one release in full
curl -s -H "Authorization: Bearer $KEY" "$CB/api/exam-export/assessments/<id>?version=<version>"
# without the key (expect 401)
curl -s -o /dev/null -w "%{http_code}\n" "$CB/api/exam-export/assessments?kind=qcto"
```

FPT Exam validates every response against the contract and says exactly which field is
wrong if one is (for example `assessments.0.questions.3.modelAnswerOrRubric Required`).
