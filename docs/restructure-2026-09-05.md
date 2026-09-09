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

### Fixing a paper that fails the check (added 9 Sep 2026)
A blocked paper is not a dead end. On its page the Administrator has three ways out, in
this order: **Fix the gaps with AI** — the AI revises the paper against the moderator's
findings (covers every missing outcome and criterion, labels and lifts cognitive demand
to the NQF band, fixes flagged questions, stays within the time allocation), keeps the
questions that already work, then the check runs again (up to two rounds); the previous
version is kept and can be restored. **Edit the questions** by hand — the check re-runs on
save. **Override with a reason** — audited. Curricula Builder papers get none of these:
they are corrected at their source and pulled again.

### The outcomes list itself can be wrong (added 9 Sep 2026)
SAQA's legacy records often read as a preamble, one run-on entry holding twenty
competences, exit-point and credit-transfer notes, and procedural text about integrated
assessment - none of which a paper can cover, so the check fails for the wrong reason.
Two remedies: SAQA lists that look malformed are **tidied by the AI at fetch time** (split
run-ons, drop non-outcomes; the raw read stays on record), and on the assessment page the
Administrator can **edit the outcomes and criteria** the check measures against (one per
line, with a *Tidy up with AI* helper); saving re-runs the check. Curricula Builder
papers: the list comes from Curricula Builder and is not edited here.

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
Pulled from FPTStaff by section (students / assessors / invigilators), role pre-filled,
manual "add new" until FPTStaff is connected (pushed back with duplicate guard). The exam
site holds name, email, role, FPTStaff reference, and for supervisory roles the login and
authenticator secret. No ID numbers in the clear, no addresses, contracts or HR data.

**Sign-in set-up (added 9 Sep 2026).** The Administrator never handles anyone's password.
Registering a person issues a one-use **set-up link** (48 hours) that is emailed to them
when email is connected (SMTP secrets) and otherwise shown to the Administrator to send.
On that page the person chooses their own password and, for a supervisory role, scans the
authenticator QR code and confirms it with a first code. The secret never travels in an
email. "Send set-up link" on a person's row re-issues it — and, for supervisory roles, a
new authenticator secret (lost-phone recovery). (Learner one-time sitting codes for the
exam itself: Phase D, with the pre-check/consent flow.)

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
| People: name, email, role, FPTStaff ref, supervisory login + MFA secret | While active | Learner ID number and unique student number (decision 9 Sep 2026: required on the Statement of Results) stored **encrypted**, masked on screen, printed in full only on the Statement; captured at registration, pulled from FPTStaff once connected |
| Exam record: session, answers, marks, feedback, outcome, sign-off, audit | Permanent | Seal hash on submission makes it tamper-evident |
| Proctoring evidence (captures, recordings, incidents) | 12 months after the sitting, then auto-delete; hold flag for appeals/investigations | Learner may view their own; never leaves FPT Exam; window stated in consent text |
| QA process, full profiles, payments, contracts | Never | Lives in FPTStaff |

## 5. Order of work

Superseded on 9 Sep 2026 by `build-plan-2026-09-09.md` (seven blocks: people at scale,
cohorts, scheduling at scale, moderator role if needed, Phase D proctoring + Statement of
Results, Phase E FPTStaff, Phase F Curricula Builder live).
