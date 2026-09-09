# FPT Exam — Restructure decisions, 5 September 2026

Agreed between Melanie Schutte (FPT Academy) and Claude on 5 Sep 2026. Supersedes the
admin-side structure in `exam-centre-build-brief.md` §2/§4 and the "four intake paths"
model. Everything else in the brief (marking, sign-off gate, FPTStaff push, proctoring
phases) stands.

## 1. What FPT Exam is for

FPT Exam runs, records, marks and releases secure exams. It does **not** author QCTO
papers, does not hold the QA process, and does not hold people's full profiles. QCTO
papers come from Curricula Builder; non-QCTO assessments may be drafted here (see §2);
people come from FPTStaff; the QA process (moderation, verification, certification) runs
in FPTStaff off the result FPT Exam pushes.

## 2. Administrator structure — three steps

The admin sidebar becomes: **Overview · Set up an Assessment · Register People ·
Schedule the Sitting · Results**. "Qualifications" and "Instruments" as separate pages are
gone; the qualification is captured as part of setting up the assessment.

### Set up an Assessment — four routes (rule agreed 9 Sep 2026)

Setting up an assessment starts with one question: *what kind of assessment is this?*
The answer fixes where the paper may come from. This replaces the "two ways in" that
stood here from 5–9 Sep.

| Route | Where the paper comes from | Built on FPT Exam? |
|---|---|---|
| **QCTO FISA / EISA** (occupational qualification, QCTO rules) | **Linked in from Curricula Builder only.** Curricula Builder is the system of record for the paper, memo and its alignment; building a QCTO paper here would defeat the purpose of Curricula Builder. | **Never.** No drafting, no upload, no manual entry. |
| **Legacy FISA** (SAQA legacy qualification, e.g. ND: Payroll Administration Services 67229) | **Linked to SAQA** by qualification ID. FPT Exam fetches the title, NQF level, exit-level outcomes and assessment criteria and the AI drafts the paper from them — the flow that works today. | Yes — drafted here, editable. |
| **Build from scratch** (anything outside the QCTO rules: internal tests, short courses, skills programmes) | Administrator gives the title, then either types their own outcomes and criteria **or uploads a document** (outcomes document, or an existing paper + memo) and the AI builds the assessment. | Yes — drafted here, editable question by question. |
| **Other courses from Curricula Builder** (CPD and other creations made on Curricula Builder) | **Linked in from Curricula Builder.** | Never — comes in as built there. |

The route is recorded on the assessment (`intake_route`), shown as a badge everywhere the
assessment appears, and cannot be changed after creation. The drafting engine is enabled
per route: it answers for Legacy FISA and Build from scratch, and returns HTTP 410 for
the two Curricula Builder routes regardless of environment flags. `ENABLE_PAPER_AUTHORING`
is no longer a global switch.

Whatever the route, the paper goes through the same standard check and gate below before
it can be scheduled, and the same proctored sitting, AI-assessed / assessor-endorsed
marking, and Results hand-over afterwards.

### Every sitting is proctored (decision 8 Sep 2026)
FPT Exam is a QCTO proctored exam site to the QCTO requirement. There is no unproctored,
"just exam" or practice mode and no per-assessment supervision setting — a sitting on FPT
Exam is a proctored sitting, for every route above. (Considered and rejected: a
proctored/unproctored choice at Set up an Assessment.)

### The standard check is the gate
Every paper coming in is checked against its outcomes (coverage of every ELO/AC, Bloom's
demand vs NQF band, rubric quality). Intake status: `checking` → `ready` (meets standard
or minor gaps) or `blocked` (does not meet, or check failed). A `blocked` paper cannot be
scheduled into a sitting until it is re-uploaded fixed, or an Administrator **overrides
with a reason** (status `override`, reason in the audit log). Only `ready`/`override`
papers appear in the sitting picker.

### Register People
Unchanged in substance: pulled from FPTStaff by section (students / assessors /
invigilators), role pre-filled, manual "add new" until FPTStaff is connected (pushed back
with duplicate guard). The exam site holds name, email, role, FPTStaff reference, and for
supervisory roles the login and authenticator secret. No ID numbers in the clear, no
addresses, contracts or HR data. (Learner one-time sitting codes instead of passwords:
Phase D, with the pre-check/consent flow.)

### Schedule the Sitting
Unchanged: paper + window + assessor + invigilators + learners. Picker filtered by the gate.

### Results (new)
Administrator's read-only view of signed-off results and their FPTStaff push status.

## 3. Marking: AI assesses, assessor endorses

On submission the AI Response-Review marks every answer against the memo (suggested mark,
demonstrated/missing, depth, confidence, gap map, suggested outcome). The assessor's
dossier now **opens with the AI's marks and feedback already in place**, each tagged
*AI-recommended*. The assessor reads, adjusts where they disagree, and signs off. The
record keeps, per question, whether the AI's mark was accepted / edited / overridden. The
sign-off is the assessment decision (registered assessor, as QCTO requires) and the only
release event. Moderation/verification: FPTStaff.

## 4. Data held on FPT Exam (safety)

| Held | How long | Notes |
|---|---|---|
| Structured paper + rubric | While the paper is live; archive after | Rubric never sent to a learner browser; paper served question-by-question in session |
| People: name, email, role, FPTStaff ref, supervisory login + MFA secret | While active | No ID numbers in clear (hash only if identity check needs it) |
| Exam record: session, answers, marks, feedback, outcome, sign-off, audit | Permanent | Seal hash on submission makes it tamper-evident |
| Proctoring evidence (captures, recordings, incidents) | 12 months after the sitting, then auto-delete; hold flag for appeals/investigations | Learner may view their own; never leaves FPT Exam; window stated in consent text |
| QA process, full profiles, payments, contracts | Never | Lives in FPTStaff |

## 5. Order of work

1. This restructure (sidebar, intake with upload + extraction, authoring disabled,
   standard-check gate, Results page, AI pre-fill in the dossier, assessor queue badge). Done.
2. Four-route Set up an Assessment (this addendum): route chooser, per-route authoring
   gate, Curricula Builder pull contract with a "not connected yet" state until Curricula
   Builder exposes it.
3. Phase D — proctoring (pre-checks, consent, capture loop, seal/hash, Invigilator
   console, Integrity engine, R2, retention sweep), learner one-time sitting codes,
   assessor email notifications.
4. Phase E — FPTStaff connection (people pull/push, result push delivery).
5. Phase F — Curricula Builder connection live (the QCTO and "other courses" routes
   become usable; until then no QCTO paper can enter FPT Exam, by design).
