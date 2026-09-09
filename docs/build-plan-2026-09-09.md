# FPT Exam — Build plan from 9 September 2026

Agreed between Melanie Schutte (FPT Academy) and Claude on 9 Sep 2026. This is the order
of work from here. It follows `restructure-2026-09-05.md` (the rules) and replaces the
"Order of work" list at the end of that document.

## Standing rules (already decided — every block below respects them)

1. **Four routes into an assessment.** QCTO FISA/EISA papers only from Curricula Builder;
   legacy FISA drafted from SAQA; non-QCTO assessments built here; other Curricula Builder
   courses linked in. Never a QCTO paper built on FPT Exam.
2. **Every sitting is proctored** to the QCTO requirement. No modes.
3. **The standard check is the gate.** Coverage of every outcome and criterion, Bloom's
   demand against the NQF band, rubric quality, time. Blocked papers are fixed (AI or by
   hand), or overridden with an audited reason.
4. **AI assesses, assessor endorses.** The assessor's sign-off is the only release event.
   Moderation and verification run in FPTStaff (decided 9 Sep 2026).
5. **Data minimisation.** FPT Exam holds what an exam needs. Learner ID number and student
   number are stored encrypted, masked on screen, printed in full only on the Statement of
   Results. Proctoring evidence is kept 12 months then deleted (hold flag for appeals).
6. **The Administrator never handles a password.** People get a one-use set-up link.
   Two-step (authenticator) sign-in is switched OFF during the build (no `MFA_REQUIRED`
   secret); it is switched on with `MFA_REQUIRED=yes` before real sittings, when every
   supervisory account enrols through a set-up link.
7. **FPTStaff is the system of record for people; Curricula Builder for QCTO papers.**
   Until they are connected, FPT Exam captures locally and syncs later.
8. **Delivery is by GitHub → Replit.** Push origin, Pull, Run. No Shell steps.

## The blocks, in order

### Block 1 — People at scale
*What you get:* Register People becomes tabs — **Students · Assessors & Moderators ·
Invigilators** (Administrators behind a fourth) — each with the columns that matter for
that type. Instant search (name, email, student number, ID last four), filters
(qualification, cohort, status, sitting), server-side paging and sorting so tens of
thousands of rows behave like twenty. Account status you can see: Invited · Active ·
Suspended · Archived, with "chase all unused set-up links" in one click. A person page
per user (sittings, results, marking done, set-up status). Bulk import from CSV/XLSX with
a downloadable template and a preview of what will be created / updated / rejected
before anything is saved. Student number and ID number captured on students (encrypted).
*Done when:* 20 000 test students load in under a second per page; import of 500 rows
with duplicates and errors previews correctly and imports clean rows only; every list
exports to CSV.

**Delivered 9 Sep 2026.** Measured against the done-when with 20 981 students in the
database: first page 35 ms, page 200 48 ms, search 79 ms (the People page paints in under
half a second); a 500-row import with duplicates and errors previewed correctly and
committed the clean rows in 1.8 s; every tab exports to CSV (full ID numbers are never in
the export — last four only). Filters by qualification, cohort and sitting wait for
Blocks 2–3, where those things start to exist. Two notes for the Administrator: a
suspended or archived person is locked out within a minute, even mid-session; and
revealing a full ID number on the person page is written to the audit log every time.
Before real learner data goes in, set `DATA_ENCRYPTION_KEY` in the Repl's Secrets (a
long random string) — until then ID numbers are encrypted under a key derived from
`JWT_SECRET`, which works but couples the two.

### Block 2 — Cohorts
*What you get:* Cohorts as the unit of work (e.g. *ND Payroll · Durban · Jan 2026
intake*): create, import, move students between them, and allocate a whole cohort to a
sitting. Cohort page with its students, sittings and results. Ready for FPTStaff to own
cohorts when connected.
*Done when:* a 300-student cohort is allocated to a sitting in one action and appears in
the invigilator's roster.

**Delivered 9 Sep 2026.** Cohorts page (create with a suggested name such as *NC: Payroll
· Durban · Jan 2026*, search, active/closed), cohort page (students paged and searchable,
add by search or "add all matching", import a file straight into the cohort, tick to move
or remove, export CSV, sittings for the cohort, audit trail). Schedule the Sitting now
starts with *Who is writing*: choose the cohort and every student in it goes on the roster
when the sitting is created (300 students in 45 ms in the test), with the 1:30 invigilator
count shown against the cohort size; each sitting has a roster (paged, searchable, add a
whole cohort or individual students, take off students who have not started). Register
People shows each student's cohorts and filters by cohort; the register form and import
can put a student straight into a cohort. Decision 1 applied: the ID number is required
for every new student (13 digits, unique — a second registration of the same number is
refused and points to the existing record; imports match existing students by it), the
student number is optional. Also in this block: the standard check now blocks any
question that cannot be answered in a proctored sitting (research, uploads, workplace or
interview tasks, work over days) and the drafting and Fix-the-gaps engines are told
never to write one; and the server no longer crashes on an unexpected database error in a
request (Express 4 needed an explicit guard) — the one request fails with a clear message
and everyone else carries on.

### Block 3 — Scheduling at scale
*What you get:* **Sitting series** — one paper, many rooms/dates — with capacity per
sitting and automatic split of a cohort across sittings. Month calendar view. Assessor
allocation that checks registration scope (only qualifications they are registered to
assess), balances marking load against each assessor's cap, and a **marking workload
board** (waiting, average turnaround, overdue). Invigilator allocation that enforces the
ratio you set (e.g. 1:30) and the independence rule. Clash check for double-booking.
*Done when:* a series of 6 sittings for 900 learners is created and staffed in under ten
minutes with no manual counting.

### Block 4 — Moderator role — DROPPED 9 Sep 2026 (moderation stays in FPTStaff)
*What you get:* Moderator as a fifth role with its own queue: sampling of signed-off
scripts by rule (e.g. 10% or at least 5, all borderline, all fails), moderation record
per script (confirmed / adjusted / referred), and moderation status on Results. If
moderation stays in FPTStaff, this block is skipped and the result push (Block 6) carries
what FPTStaff needs.

### Block 5 — Phase D: proctoring and the exam experience
*What you get:* Mapping of QCTO/AQP proctoring requirements to features (from public
QCTO policy; FPT's own documents if supplied). Learner **one-time sitting codes** instead
of passwords for the exam itself. Pre-checks (camera, microphone, screen, identity photo
against the registration photo), consent text with the retention window, capture loop
(periodic photo, screen, tab-switch and paste detection, focus loss), tamper-evident
**seal hash** on submission, **Invigilator console** (live roster, flags, chat, pause /
resume / terminate with reason), **Integrity engine** (flags → incident log → integrity
summary on the dossier), evidence storage with the 12-month sweep and hold flag.
**Statement of Results** — branded PDF for the learner with ID number, student number,
sitting details, integrity summary, assessor sign-off — and the result-released email.
Assessor email notifications (scripts waiting).
*Done when:* a full sitting runs end to end with a proctored learner, an invigilator
watching, an assessor signing off and the learner downloading their Statement.
Added 9 Sep 2026: continuous live view of every learner for the invigilator; full-screen
exam with tab/window switching detected, the paper locked and the invigilator alerted.

### Block 6 — Phase E: FPTStaff connection
*What you get:* People and cohorts pulled from FPTStaff by section; manual adds pushed
back with duplicate guard; results and Statements pushed on sign-off; moderation /
verification / certification stay in FPTStaff. Contract written for the FPTStaff side.

### Block 7 — Phase F: Curricula Builder connection live
*What you get:* the two Curricula Builder routes become usable — released QCTO papers
and other courses listed and pulled in. The contract is already written
(`curricula-builder-contract.md`); Curricula Builder has to expose it.

## Decisions taken 9 Sep 2026 (were the open decisions)

1. **Student identifier — the ID number.** The learner's South African ID number is the
   unique student identifier on FPT Exam and on the Statement of Results (stored
   encrypted, masked on screen, full only on the Statement). A separate student number
   is optional — a reference to Learnership Manager / FPTStaff where one exists — and
   is no longer required or validated. The person page, import and Statement follow this.
2. **Moderation stays in FPTStaff.** Block 4 is dropped. The result push in Block 6
   carries what moderation needs (marks, AI/assessor trail, sample scripts on request).
3. **Email — yes, set-up deferred (9 Sep 2026 pm).** Melanie enters `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
   `MAIL_FROM` in the Repl's Secrets herself; set-up links and later notifications then
   send automatically. Office 365: `smtp.office365.com`, 587, SMTP AUTH enabled on the
   sending mailbox.
4. **Curricula Builder builds the export** to `curricula-builder-contract.md`. FPT Exam
   side needs `CURRICULA_BUILDER_BASE_URL` and `CURRICULA_BUILDER_API_KEY` once it exists.
5. **Proctoring requirement accepted as written in Block 5**, with two additions:
   the **invigilator may watch every learner live for the whole sitting** (continuous
   camera/screen view in the Invigilator console, not only periodic captures and flags);
   and **no tab-switching while writing** — the exam runs full-screen, leaving the exam
   tab or window is detected, the paper locks with a notice to the learner, the
   invigilator is alerted, and the event goes in the incident log. (Browser limit, stated
   plainly: a web page can detect and lock on every switch and can require full screen,
   but cannot physically stop the operating system from switching; a lockdown browser app
   would be the only way to do that, and it is out of scope unless asked for.)
6. **Invigilator ratio 1:30** confirmed; assessor cap of 60 scripts in flight stands.
7. **`DATA_ENCRYPTION_KEY`** — Melanie generates a random 64-character string and adds it
   as a Secret before real ID numbers go in.

## How each block is delivered

One or two commits per block, each verified end to end with real AI before it leaves
here (API tests, browser walk-through, Phase C marking regression), then merged into your
FPTExam folder for **Push origin → Pull → Run**. Each delivery note says what changed
and what to click. The restructure document and this plan are updated as decisions land;
both live in the repo under `docs/` and in the Claude project.
