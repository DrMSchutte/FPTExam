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
Cohorts (added 9 Sep 2026) · Schedule the Sitting · Results**. "Qualifications" and "Instruments" as separate pages are
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

**Built for scale (Block 1 of the build plan, delivered 9 Sep 2026).** The page is four
tabs — Students · Assessors & Moderators · Invigilators · Administrators — each with a
count and the number still waiting to set up their sign-in. Search is instant across
name, email, student number and the last four digits of the ID number; a status filter
(Invited · Active · Suspended · Archived) and server-side paging keep tens of thousands
of rows behaving like twenty. Each person has a page: details (ID number masked, full
reveal audited), sign-in state with send-link / suspend / reactivate / archive, their
sittings and results (or marking and invigilation duties), and their audit trail. People
are added one at a time or imported from CSV/XLSX against a downloadable template, with a
preview of create / update / unchanged / rejected rows before anything is saved. Every
tab exports to CSV without full ID numbers. Suspended and archived accounts are locked
out of every request, not just the login page.

**Sign-in set-up (added 9 Sep 2026).** The Administrator never handles anyone's password.
Registering a person issues a one-use **set-up link** (48 hours) that is emailed to them
when email is connected (SMTP secrets) and otherwise shown to the Administrator to send.
On that page the person chooses their own password and, for a supervisory role, scans the
authenticator QR code and confirms it with a first code. The secret never travels in an
email. "Send set-up link" on a person's row re-issues it — and, for supervisory roles, a
new authenticator secret (lost-phone recovery). (Learner one-time sitting codes for the
exam itself: Phase D, with the pre-check/consent flow.)

### Cohorts (Block 2, delivered 9 Sep 2026)
A cohort is the working unit for students — a group such as *ND Payroll · Durban · Jan
2026 intake*. Students are added by search, by "add all matching", or by importing a file
straight into the cohort; they can be moved between cohorts and removed; the cohort page
shows its students, its sittings and an audit trail. FPTStaff owns cohorts once connected
(`external_ref`).

### Schedule the Sitting
Starts with *who is writing*: pick the cohort and its whole membership is on the roster
the moment the sitting is created; the invigilator count is shown against the 1:30 ratio.
Then paper (picker filtered by the gate, the cohort's qualification first), window,
assessor, invigilators. Every sitting has a roster — paged, searchable, add another cohort
or individual students, take off anyone who has not started. The roster is what the
Invigilator console (Block 5) shows live.

### Scheduling at scale (Block 3, delivered 9 Sep 2026)
*Plan a series*: one paper, one or more cohorts, several sittings across rooms and dates,
split by seats and staffed in one action, with the plan checked before creation. Rules
that refuse: 1 invigilator to 30 learners, assessor scope, invigilator clashes, assessor as
invigilator, independence, no one free to place. Rules that warn and need acceptance:
marking cap (60 by default, per assessor), seats short, students already booked. Calendar
month view; Marking workload board per assessor; assessor scope and cap on the person
page; Results filtered by cohort/qualification/outcome/date with a CSV results sheet.

### The ID number is the student identifier (decision 9 Sep 2026)
Every new student is registered with their 13-digit ID number; it is unique on FPT Exam
(a second registration of the same number is refused and points to the existing record),
stored encrypted, masked on screen, revealed only with an audit entry, and printed in full
only on the Statement of Results. The student number is an optional reference to
Learnership Manager / FPTStaff.

### Every question is answerable in the sitting (rule added 9 Sep 2026)
A proctored, closed-book, locked-screen sitting cannot accommodate research, internet or
textbook use, workplace tasks, interviews, or uploading a document — those are assignment
tasks, not exam questions. The drafting and Fix-the-gaps engines are instructed never to
write one, and the standard check blocks a paper that contains one (deterministically, by
question type and wording, as well as by the moderator's reading) until it is replaced by
a scenario, case-study or worked task answered in writing during the sitting.

### Results (new)
Administrator's read-only view of signed-off results and their FPTStaff push status;
since Block 5d also whether the learner has been told (result email) with *Send again*,
and the *Statement* link per row.

### Statement of Results (Block 5d, 10 Sep 2026)
The learner's formal record of a signed-off result: a branded A4 PDF with the full ID
number and student number, qualification and paper, sitting, outcome, marks per
exit-level outcome, integrity statement, assessor sign-off, statement number and seal.
Available to the learner (their account), the assessor of record and the Administrator
only after sign-off; every download audited.

## 3. Marking: AI assesses, assessor endorses

On submission the AI Response-Review marks every answer against the memo (suggested mark,
demonstrated/missing, depth, confidence, gap map, suggested outcome). The assessor's
dossier now **opens with the AI's marks and feedback already in place**, each tagged
*AI-recommended*. The assessor reads, adjusts where they disagree, and signs off. The
record keeps, per question, whether the AI's mark was accepted / edited / overridden. The
sign-off is the assessment decision (registered assessor, as QCTO requires) and the only
release event. Moderation/verification: FPTStaff.

**Integrity before marks (Block 5c, 10 Sep 2026).** The dossier opens with the sitting's
integrity summary — Clear / Review / Investigate with the findings, the identity photo and
the evidence timeline — computed the moment the paper was submitted from everything the
exam room and the invigilator recorded. The assessor's judgement stays theirs; the
summary makes sure nothing recorded in the room is missed at sign-off.

### The invigilator's workspace (Block 5c, 10 Sep 2026)
*My sittings* (the sittings the invigilator is assigned to) and the **live console** per
sitting: learner cards with the latest camera still, clock and flags (red = needs you,
amber = worth a look), the live incidents strip, and per learner the camera and screen
side by side, release / message / extra time / capture now / record what I see / end the
paper, and the evidence timeline. Administrators open the same console from the roster.

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
