# FPTStaff ↔ FPT Exam: exam-sync contract

FPTStaff is the system of record for people and for everything after a result
(moderation, verification, certification). FPT Exam pulls learners by section and staff
from it, pushes people registered on FPT Exam so FPTStaff has them too, and pushes every
signed-off result with its Statement of Results. This page is what FPTStaff has to expose;
FPT Exam's client is `server/src/integrations/fptstaff/client.ts`.

## Configuration on the FPT Exam side (Replit Secrets)

| Secret | Value |
|---|---|
| `FPTSTAFF_BASE_URL` | FPTStaff's origin, e.g. `https://fptstaff.fptacademy.co.za` |
| `FPTSTAFF_API_KEY` | A bearer token FPTStaff issues to FPT Exam |
| `FPTSTAFF_MOCK` | `yes` to work with the sample FPTStaff that FPT Exam serves itself (testing only) |

Until the two real secrets are set, the FPTStaff panel on *Register People* says "not
connected", results queue for hand-over, and people registered here are pushed across the
moment the link is live.

## Authentication

Every request carries `Authorization: Bearer <FPTSTAFF_API_KEY>`. Anything else → 401.

## 1. Sections

`GET /api/exam-sync/sections`

```json
{ "sections": [ { "id": "sec-2026-09-dbn-pay", "name": "Payroll Administrator · Durban · Sep 2026",
  "qualificationTitle": "Occupational Certificate: Payroll Administrator", "saqaQualificationId": "118706",
  "site": "Durban", "intake": "Sep 2026", "learnerCount": 28, "status": "active" } ] }
```

A section is whatever FPTStaff groups learners by (intake, class, site group). On FPT Exam
each pulled section becomes one **cohort**, named after it, and can be pulled again at any
time to pick up new learners.

## 2. Learners in a section

`GET /api/exam-sync/learners?section={id}&page={n}&pageSize={≤500}`

```json
{ "learners": [ { "fptstaffId": "L-104432", "name": "Thandiwe Mokoena", "email": "thandiwe@example.com",
  "idNumber": "9001015009087", "studentNumber": "FPT-2026-0412", "sectionId": "sec-2026-09-dbn-pay",
  "status": "active", "updatedAt": "2026-09-01T08:00:00Z" } ], "nextPage": null }
```

`idNumber` is the 13-digit South African ID number — the student identifier on FPT Exam.
A learner without one is rejected on pull and reported. `status: inactive` learners are
skipped. `nextPage` is the next page number or `null`.

## 3. Staff

`GET /api/exam-sync/staff`

```json
{ "staff": [ { "fptstaffId": "S-77", "name": "Sipho Dlamini", "email": "sipho@fptacademy.co.za",
  "roles": ["assessor", "invigilator"], "employmentRelationship": "internal",
  "registrationNumber": "ETDP-A-4471", "status": "active" } ] }
```

`roles` is any of `assessor`, `invigilator`. Administrators are not synced.

## 4. A person registered on FPT Exam

`POST /api/exam-sync/learners`

```json
{ "examRef": "<FPT Exam user id>", "name": "…", "email": "…", "idNumber": "9001015009087", "studentNumber": null }
```

FPTStaff matches on ID number, then email, and never creates a duplicate:

```json
{ "fptstaffId": "L-104433", "outcome": "created" | "matched" | "updated" }
```

## 5. A signed-off result with its Statement

`POST /api/exam-sync/results` — sent the moment an assessor signs off. Idempotent on `examRef`.

```json
{
  "examRef": "<FPT Exam session id>",
  "learner": { "fptstaffId": "L-104432", "name": "…", "email": "…", "idNumber": "…", "studentNumber": "…" },
  "qualification": { "title": "…", "type": "fisa" | "eisa" | "non_qcto", "saqaQualificationId": "118706" },
  "paper": { "version": "2026-Nov-P1", "source": "curricula_builder", "externalRef": "cb-assess-8821" },
  "sitting": { "id": "…", "startTime": "2026-11-04T07:00:00Z", "venue": "Durban Lab 1" },
  "result": { "outcome": "competent" | "not_yet_competent", "totalMark": 64, "totalMax": 80, "percentage": 80,
              "signedOffAt": "2026-11-06T13:20:00Z", "assessor": { "name": "…", "fptstaffId": "S-77" } },
  "integrity": { "recommendation": "clear" | "review" | "investigate", "headline": "…" },
  "statement": { "number": "FPT-SR-2026-9B2CE5AD83", "filename": "Statement-of-Results-….pdf", "pdfBase64": "JVBERi0…" }
}
```

```json
{ "received": true, "fptstaffResultId": "R-2026-000812", "duplicate": false }
```

FPTStaff stores the Statement PDF against the learner and starts its own moderation /
verification. FPT Exam records the acknowledgement on the Results page (*Sent*); a failed
delivery is retried and can be re-queued with *Push now*.

## Testing before FPTStaff is ready

With `FPTSTAFF_MOCK=yes` on the FPT Exam Repl, FPT Exam serves a sample FPTStaff itself:
three sections (29 learners, every name marked SAMPLE), four staff, and a receiving end for
people and results (in memory). The whole route runs: pull sections → cohorts → schedule →
sit → mark → sign off → result and Statement pushed → visible at
`GET /api/exam-sync/received` (sample only). A drop-in reference implementation for the
FPTStaff side is in `fptstaff-sync-reference.md`.
