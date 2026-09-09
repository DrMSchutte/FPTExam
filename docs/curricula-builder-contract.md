# Curricula Builder → FPT Exam: export contract

FPT Exam never authors a QCTO paper. A QCTO FISA/EISA paper — and any CPD or other
course assessment created on Curricula Builder — enters FPT Exam only by being pulled from
Curricula Builder over this contract (`docs/restructure-2026-09-05.md` §2). This page is
what Curricula Builder has to expose; FPT Exam's client is
`server/src/integrations/curriculaBuilder/client.ts`.

## Configuration on the FPT Exam side (Replit Secrets)

| Secret | Value |
|---|---|
| `CURRICULA_BUILDER_BASE_URL` | Curricula Builder's origin, e.g. `https://curriculabuilder.example` |
| `CURRICULA_BUILDER_API_KEY` | A bearer token Curricula Builder issues to FPT Exam |

Until both are set the two Curricula Builder routes under *Set up an Assessment* show
"not connected yet". Nothing else changes.

## Authentication

Every request carries `Authorization: Bearer <CURRICULA_BUILDER_API_KEY>`. Curricula
Builder should reject anything else with 401. Only **released / approved** assessments
should be listed — a draft on Curricula Builder must not be schedulable on FPT Exam.

## 1. List assessments

`GET /api/exam-export/assessments?kind=qcto` or `?kind=other`

- `qcto` — QCTO FISA/EISA papers (occupational qualifications and legacy qualifications
  whose papers Curricula Builder holds).
- `other` — CPD and any other course assessment created on Curricula Builder.

```json
{
  "assessments": [
    {
      "id": "cb-assess-8821",
      "title": "FISA Paper 1 — 2026 November",
      "qualificationTitle": "Occupational Certificate: Payroll Administrator",
      "kind": "qcto",
      "qctoRegistrationType": "eisa",
      "saqaQualificationId": "118706",
      "nqfLevel": 5,
      "version": "2026-Nov-P1",
      "updatedAt": "2026-09-01T09:12:00Z"
    }
  ]
}
```

`qctoRegistrationType`, `saqaQualificationId`, `nqfLevel` may be `null` for `kind: other`.

## 2. One assessment, in full

`GET /api/exam-export/assessments/{id}`

Everything in the summary above, plus:

```json
{
  "timeAllocationMinutes": 180,
  "permittedMaterials": ["Non-programmable calculator"],
  "passMarkOrCompetencyRule": "50% overall",
  "exitLevelOutcomes": ["ELO 1 text…", "ELO 2 text…"],
  "assessmentCriteria": ["AC 1.1 text…", "AC 1.2 text…"],
  "questions": [
    {
      "id": "q-1",
      "type": "short_answer",
      "prompt": "1.1 Explain …",
      "maxMark": 5,
      "modelAnswerOrRubric": "Award 1 mark for each of: …",
      "eloRef": "ELO 1",
      "acRef": "AC 1.2",
      "bloomLevel": "understand"
    },
    {
      "id": "q-2",
      "type": "mcq",
      "prompt": "1.2 Which …",
      "maxMark": 1,
      "options": ["A …", "B …", "C …", "D …"],
      "modelAnswerOrRubric": "B",
      "eloRef": "ELO 1",
      "bloomLevel": "remember"
    }
  ]
}
```

`type` is one of `mcq | short_answer | long_answer | practical_upload`. `bloomLevel` is
one of `remember | understand | apply | analyse | evaluate | create`. Every question needs
a `modelAnswerOrRubric`: it is what the AI Response-Review and the assessor mark against,
and the standard check will block a paper without one.

## What FPT Exam does with it

1. Finds or creates the qualification by `saqaQualificationId` (else by exact title) with
   the given type and NQF level. `kind: other` becomes type `non_qcto`.
2. Stores the outcomes and criteria as the reference list the standard check measures
   coverage against.
3. Stores the paper with `source = curricula_builder`, `intake_route` =
   `qcto_curricula_builder` or `curricula_builder_other`, `external_ref` = Curricula
   Builder's `id`. The same `id` + `version` is never imported twice.
4. Runs the standard check; the gate applies as for any other paper.
5. The paper is read-only on FPT Exam. Corrections are made on Curricula Builder and
   pulled again as a new version.
