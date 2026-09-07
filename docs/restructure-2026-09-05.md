# FPT Exam — Restructure decisions, 5 September 2026

Agreed between Melanie Schutte (FPT Academy) and Claude on 5 Sep 2026. Supersedes the
admin-side structure in `exam-centre-build-brief.md` §2/§4 and the "four intake paths"
model. Everything else in the brief (marking, sign-off gate, FPTStaff push, proctoring
phases) stands.

## 1. What FPT Exam is for

FPT Exam runs, records, marks and releases secure exams. It does **not** author papers,
does not hold the QA process, and does not hold people's full profiles. Papers come from
Curricula Builder (or an uploaded document); people come from FPTStaff; the QA process
(moderation, verification, certification) runs in FPTStaff off the result FPT Exam pushes.

## 2. Administrator structure — three steps

The admin sidebar becomes: **Overview · Set up an Assessment · Register People ·
Schedule the Sitting · Results**. "Qualifications" and "Instruments" as separate pages are
gone; the qualification is captured as part of setting up the assessment.

### Set up an Assessment (intake, not a builder)
Two ways in:
- **Upload the paper** — the exam paper and its memo/rubric as Word or PDF (one file or
  two). The system extracts the questions, marks, question types and marking guide into
  the structured form the rest of the system needs; the qualification is captured on the
  same screen from the SAQA ID (title and NQF level fetched from SAQA) with a manual
  fallback (title, FISA/EISA, NQF).
- **Link from Curricula Builder** — Phase F, when the connection exists.

Removed from the UI: manual question-by-question entry; AI drafting from SAQA; AI drafting
from a QCTO specification document. The engines stay in the codebase but their endpoints
are disabled (HTTP 410) unless `ENABLE_PAPER_AUTHORING=true`; the drafting capability is
intended to move to Curricula Builder.

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
   standard-check gate, Results page, AI pre-fill in the dossier, assessor queue badge).
2. Phase D — proctoring (pre-checks, consent, capture loop, seal/hash, Invigilator
   console, Integrity engine, R2, retention sweep), learner one-time sitting codes,
   assessor email notifications.
3. Phase E — FPTStaff connection (people pull/push, result push delivery).
4. Phase F — Curricula Builder link (paper intake), where paper authoring lives.
