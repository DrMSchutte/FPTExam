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

**Delivered 9 Sep 2026.** *Plan a series* on Schedule the Sitting: choose cohort(s), the
paper and the assessor of record, give a room size and *Quick plan* lays out the sittings
(two a day), or add them by hand — date, minutes, venue, seats, invigilators (with a
*Fill N free* button). *Check the plan* shows the split and every rule finding before
anything is created; *Create* makes all the sittings and rosters together, or none. In
the test a 6-sitting series for 900 students was checked and created in 147 ms. Rules
enforced (refused): 1 invigilator per 30 learners; assessor outside their recorded scope;
an invigilator on two overlapping sittings (existing or within the series); assessor as
invigilator; independent invigilation when required; nobody free to place. Noted
(created after the Administrator accepts): assessor over their marking cap (60 unless set
on their person page); seats short (students left off, counted); students already booked
in the period (left off); scope not yet recorded (note only). Students already on an
overlapping sitting are never double-booked. The same rules now apply to a single sitting.
*Calendar* tab: month view, sittings short of invigilators in amber, click through to the
roster. *Marking workload* tab: per assessor — scripts waiting, overdue (> 5 days),
in flight against cap, signed off in 30 days, average turnaround, upcoming sittings,
scope. Person page (assessors): *Assessment scope* card — qualifications registered to
assess and marking cap. Results: filters by learner, cohort, qualification, outcome and
sign-off date; *Export results sheet (CSV)* — one row per released result with mark,
percentage, outcome, assessor and FPTStaff status (ID last four only).

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

Delivered in four parts. **5a — sitting codes and check-in (delivered 9 Sep 2026).**
Every learner on a roster gets a one-time sitting code (`XXXX-XXXX-XXXX`, no look-alike
characters) issued from the roster and printed as a list or cut-out slips (`Print
codes`, audited). At `/sit` the learner enters the code with their own 13-digit ID
number — both must match — from 45 minutes before the start; the code works once, and
the invigilator can *Allow re-entry* after a drop-out. Check-in: the conditions (identity
check, camera and screen captures, live invigilation, 12-month retention, the right to
see one's own recordings) accepted and recorded with version and time; camera and
microphone check; an identity photo taken from the webcam and stored as evidence
(visible to the Administrator and the sitting's invigilator on the roster); then the
waiting room with a countdown. The paper opens only after check-in and only inside the
window — the server enforces this for every sign-in path. A code sign-in is scoped to
that one exam: it cannot read results or other sittings. Roster shows code issued/used,
consent, photo, camera, and the check-in / writing / submitted state.
**5b — the locked paper (delivered 9 Sep 2026).** After check-in the learner presses
*Begin*: the exam goes full screen, the camera stays on, and the browser asks for the
**entire screen** to be shared (a window or tab is refused). One question at a time with a
question map, answers saved as typed, the clock is the server's (time allocation from the
moment the paper opened, plus any extra time, never past the sitting's end). Copy, cut,
paste, the context menu, print/save shortcuts and developer-tools shortcuts are blocked
and recorded. **Leaving the exam window, hiding the tab or leaving full screen locks the
paper** — a dark overlay states it has been recorded and the invigilator alerted; the
learner may return twice themselves, the third lock needs the invigilator (*Resume paper*
on the roster). Every lock also triggers a flagged photo and screen capture. Scheduled
captures: a webcam photo every 45 s and a screen still every 2 min (server-throttled),
stored as evidence. Submission **seals** the paper: a SHA-256 over the answers, the
submission time and every evidence hash in order; shown to the learner and on the roster.
Time-up is enforced by the server (a sweep every minute submits any paper still open past
its deadline). Roster: lock state, focus losses, paste attempts, capture counts, screen
share scope, seal; actions *Resume paper*, *Extra time* (minutes + reason, audited),
*Submit for them* (reason, audited). Stated limit stands: a browser detects and locks; it
cannot physically stop the operating system switching apps.
**5c — the invigilator console and integrity engine (delivered 10 Sep 2026).** An
invigilator signs in to *My sittings* — the sittings they are assigned to, live ones
first, with checked-in / writing / locked / submitted counts refreshing on their own —
and opens the **live console** for a sitting (the Administrator reaches the same console
from the roster, *Open live console*). The console shows every learner as a card with
their latest camera still, status, their own clock and flags; cards refresh every 4 s and
sort attention-first: a **red ring** means the learner needs the invigilator now (locked
beyond the self-resumes, or **no signal** — the browser has not spoken to the server for
a minute), **amber** means worth a look (sharing only a window, paste attempts, repeated
focus loss, camera dropped). A **live incidents** strip lists everything the room records
the moment it happens (newest first; click a line to open that learner). Selecting a
learner opens the side panel: the latest camera and screen stills side by side (*Watch
large* for one big view), the identity photo for comparison, when they were last seen,
and the actions — **Release the paper**, **Send a message** (appears on the learner's
screen until they press OK, with quick phrases), **Extra time**, **Capture now** (a photo
and screen still on demand), **Record what I see** (talking, unauthorised material, phone
or second device, left the seat, identity in doubt, another person present, other — with a
note, an optional on-screen warning to the learner, and an automatic capture pair),
**End the paper** (reason required; submits and seals), *Allow re-entry*, and the
**evidence timeline** (every capture as a thumbnail, every incident and staff action in
time order). Every action is recorded against the session. The **integrity engine**
runs the moment a paper is submitted — by the learner, the clock or the invigilator — and
writes a deterministic summary from the evidence: identity photo present, focus losses
and locks, paste attempts, screen-share scope, capture coverage against the expected
cadence, camera drops, developer-tools attempts, the invigilator's own observations,
re-entries, extra time and how the paper ended. Each finding has a severity
(info/low/medium/high); the overall recommendation is **Clear**, **Review** or
**Investigate**. The assessor's dossier opens with this **Sitting integrity** card — the
recommendation, the findings, the identity photo, the masked ID and student number, and
*See the evidence* for the same timeline — so an irregular sitting is never signed off
unknowingly. The assessor of record may view the console and the evidence but cannot act
on a live paper; an invigilator sees only their own sittings.
**5d — the Statement of Results and the result email (delivered 10 Sep 2026).** The
moment an assessor signs off, the learner's **Statement of Results** exists: one A4 PDF,
FPT Academy branding (green rule, blue title), confidential header and footer, a
statement number (`FPT-SR-<year>-<10 chars>`). It carries the learner's name, **full ID
number** and student number (the only document that does — everywhere else the ID is
masked), the qualification with SAQA ID and assessment type (FISA / EISA), the paper, the
sitting date, time and venue, the submission time, the **outcome**, total mark and
percentage in a highlighted box, **marks per exit-level outcome** (questions grouped by
their ELO, with totals), the assessor's overall feedback, the **sitting-integrity**
statement (what was captured, how it was submitted, any findings the assessor reviewed),
the assessor's name and sign-off time, and a verification line with the exam-record ID and
seal. The learner downloads it from their result (*Download my Statement of Results*); the
assessor has it on the signed-off dossier; the Administrator has a *Statement* link on
every Results row. Every download is audited. Only the learner themself (signed in with
their account, not a sitting code), the assessor of record and an Administrator may open
it, and never before sign-off. The **result email** is queued at sign-off and tells the
learner their result is released with a sign-in link — it never carries the result itself.
The Results page shows per learner whether they were told (*Emailed*, *Email not
connected*, *Email failed*, *Sending…*) with *Send again*; until the SMTP secrets are set
the status reads *Email not connected* and nothing is lost — *Send again* delivers once
email is connected.
**Block 5 is complete.** The end-to-end sitting — codes, check-in, locked paper,
invigilator console, integrity summary, assessor sign-off, Statement of Results — runs
and is tested in a real browser.

### Block 6 — Phase E: FPTStaff connection
*What you get:* People and cohorts pulled from FPTStaff by section; manual adds pushed
back with duplicate guard; results and Statements pushed on sign-off; moderation /
verification / certification stay in FPTStaff. Contract written for the FPTStaff side.

### Block 7 — Phase F: Curricula Builder connection live
*What you get:* the two Curricula Builder routes become usable — released QCTO papers
and other courses listed and pulled in. The contract is already written
(`curricula-builder-contract.md`); Curricula Builder has to expose it.

**FPT Exam side delivered 10 Sep 2026.** The connection line under *QCTO FISA / EISA* and
*Other course from Curricula Builder* shows what FPT Exam is connected to (never the
key) and **Test connection** runs a live probe that says exactly where it stops —
unreachable, key refused, or a response that does not match the contract (naming the
field). The list marks every release: *On FPT Exam*, *Superseded*, or **Pull new
version** when an earlier version of the same assessment is already here. Pulling a new
version **supersedes** the old paper: it stays for the sittings already written on it,
shows a banner pointing at the current version, and cannot be scheduled again (the
scheduler refuses it with a plain message). Every pull is audited. A **sample export**
ships inside FPT Exam: with the Repl secret `CURRICULA_BUILDER_MOCK=yes` it stands in for
Curricula Builder (three QCTO releases, one re-released, and one CPD assessment — every
title starts with SAMPLE) so the whole route runs today: list → pull → standard check →
schedule → sit → mark → Statement. Remove the secret and set the two real ones when
Curricula Builder is live. For the Curricula Builder side there is a **drop-in reference
implementation** (`curricula-builder-export-reference.md`): the complete Express router,
the four mapping points to fill in from Curricula Builder's data model, key issuing and
the command-line proof. What remains for Block 7 is on Curricula Builder: expose the
export, issue the key, set the two secrets on FPT Exam, press *Test connection*.

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
