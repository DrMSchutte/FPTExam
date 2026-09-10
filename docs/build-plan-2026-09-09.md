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

**FPT Exam side delivered 10 Sep 2026.** *Register People* has **Pull from FPTStaff**: the
connection line (never the key) with **Test connection**, FPTStaff's sections with learner
counts and the cohort here that mirrors each, tick the sections and **Pull into cohorts** —
each section becomes one cohort named after it (linked to the qualification when the SAQA
ID is known), learners are registered or updated, matched by ID number so nobody is ever
duplicated, and a re-pull picks up new learners without touching the rest. **Pull assessors
& invigilators** brings staff across with both roles where FPTStaff has both. Every learner
registered on FPT Exam by hand or by file import is **pushed to FPTStaff** automatically
when it is connected and gets its FPTStaff reference back; a **Push N added here** button
sends across everyone registered before the link existed. On sign-off the result goes to
FPTStaff **with the Statement of Results PDF**, the integrity recommendation, the assessor
and the sitting; *Results* shows the connection line, *Sent* with the time or *Failed* with
the reason and *Retry*, and **Push now** for everything that queued while FPTStaff was not
connected. Every movement is audited. A **sample FPTStaff** ships inside FPT Exam
(`FPTSTAFF_MOCK=yes`: three sections, 29 learners marked SAMPLE, four staff, and a receiving
end that shows what arrived) so the whole route runs today. For the FPTStaff side there is a
**drop-in reference implementation** (`fptstaff-sync-reference.md`) and the contract
(`fptstaff-contract.md`). What remains for Block 6 is on FPTStaff: expose the five routes,
issue the key, set the two secrets on FPT Exam, press *Test connection*, then *Push now*.

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

### Block 8 — Go-live hardening (added 10 Sep 2026)
Order agreed with Melanie: 8b full recording → 8c evidence archive, packs and learner self-view →
8d analytics → 8e automations → 8a security last (so testing is not hampered).

Block 8 is complete: 8b, 8c, 8d, 8e and 8a are all delivered. What remains is not building
but switching on — see *Before the first real sitting* at the end of this plan.

**8b — Full recording (delivered 10 Sep 2026).** A choice on the sitting form, *Evidence
kept*: **Stills** (as before) or **Full recording** — continuous video of the camera and
the screen for the whole sitting, in addition to the stills. Every sitting stays fully
invigilated; this is only how much is kept as evidence. The browser records self-contained
one-minute segments per stream (camera ~250 kbps, screen ~400 kbps) and uploads each as it
is made; a queue holds segments while the connection is busy and the console shows
*uploads behind* or *recording not arriving* in amber. Segments are hashed and become part
of the seal; the last ones flushed at submission are kept and marked *after submission*.
Bytes go to object storage — `RECORDINGS_STORAGE=replit` for Replit App Storage (the bucket
attached to the Repl, no secrets), otherwise the server's disk under `server/data/recordings`
(development and small venues only). Measured in a real browser: about 1 MB per minute for
both streams together (roughly 180 MB per learner-hour with a real webcam), so a
three-hour paper is about 0.5–1 GB per learner and a 30-learner room needs roughly
15–25 Mbps upstream for the sitting. The console gains **Watch video** (the newest minute
of camera and screen, about a minute behind) and **Recording** — a minute-by-minute player
of the whole sitting, both streams side by side; the assessor's dossier has *Watch the
recording*; playback is admin / the sitting's invigilators / the assessor of record only,
audited. The integrity engine measures recording coverage (segments against minutes
written) and the Statement of Results states "recorded in full".

**Papers: retire, delete, alignment matrix (delivered 10 Sep 2026).** On a paper's page:
**Retire it** (with a reason) takes a paper out of use — it stays for the sittings written
on it, shows *Retired* and is refused by the scheduler; **Delete it** removes a paper for
good, allowed only while no sitting was ever scheduled on it (otherwise the system says so
and offers retire). Retired papers are hidden from the list behind *Show N retired*.
**Alignment matrix (PDF)** — the quality-assurance record per paper: the standard-check
verdict and summary, paper shape and cognitive demand against the NQF band, the coverage
table (every outcome and criterion, status, questions, marks), the question × outcome
grid, recommendations and question issues, and the question index. Branded A4,
confidential header and footer; model answers and rubrics are never included. Every
download is audited.

**8c — Evidence archive, evidence packs and the learner's own view (delivered 10 Sep
2026).** Melanie's question: *where do the reports live once an exam has been pulled
through, aligned, completed and implemented — to go with the portfolio of evidence for the
governing body?* Answer: the database is the archive, and **Evidence Archive** (new
administrator page) is the register of it. Nothing is copied into folders: every report is
rendered from the sealed record at the moment it is downloaded, so it can never drift from
what was written and signed off, and every download is written to the audit trail.

*Evidence Archive page.* Every sitting whose window has closed, newest first: who sat, results
(complete / released / being marked), the integrity calls (clear / review / investigate),
evidence held (stills or full recording, size), kept-until date, and how many times its
portfolio has been taken. Opening a sitting shows the sitting reports (register, alignment
matrix of the paper, the console as it was, the paper) and every learner with their
integrity call, result, and links: **Evidence pack (PDF)**, **Files (ZIP)**, *…with video*,
**Statement of Results**. Search and filters (complete / still being marked / fully recorded).

*Portfolio of Evidence (ZIP, per sitting, administrator only).* One download for QCTO, the
SETA, an external moderator or verifier: `00-README.txt` (contents, how to verify hashes,
retention), `01-Sitting-Register.pdf` (landscape: qualification, paper, cohort, venue,
staff, and per learner check-in / opened / submitted / integrity / result / statement number /
pack number), `02-Alignment-Matrix.pdf`, `03-Question-Paper.pdf` (sections A, B, C in exam
order), `04-Marking-Guideline.pdf` (with model answers — assessor copy), `05-Results.csv`,
`06-Incidents.csv`, `07-Audit-Trail.csv`, and `learners/<Name - ID>/` with `Evidence-Pack.pdf`,
`Statement-of-Results.pdf` (once released), `captures/*.jpg` (identity photo and every
still, numbered in time order), `recording/*.webm` (only with `?video=1` — large) and
`manifest.json` (every file with its SHA-256, the seal, the integrity call and result). The
ZIP is streamed, so a sitting with video never has to fit in memory.

*Evidence pack (PDF, per learner).* Numbered `FPT-EP-<year>-<10 chars>`. Sections: 1 the
sitting (learner with full ID number, qualification, paper, sitting, venue, staff, evidence
kept); 2 integrity summary (verdict box, counts, coverage, findings table by severity);
3 consent, identity photo and device check; 4 what happened in order (every staff action,
system and invigilator incident); 5 captures (thumbnail grid in the standalone PDF; listed
with hashes when the ZIP carries the files); 6 full recording manifest (every segment, hash,
sealed / after seal); 7 the seal and every capture hash, with how to re-compute it; 8 the
result and statement number once signed off. Available from the console panel (submitted
learners), the assessor's dossier, and the archive. Admin / the sitting's invigilators / the
assessor of record.

*Learner's own view.* The consent text promises "you may ask to see your own recordings":
on the learner's dashboard a submitted sitting gains **What was recorded of me** — identity
photo, every camera and screen still, the full recording minute by minute, the kept-until
date and the seal. Only after submission, only their own, only signed in with their account
(never with a sitting code), and never the integrity findings or marks. Viewing is audited.

*Retention rule stated everywhere:* captures and recordings kept 12 months after the sitting
unless placed on hold; statements, evidence-pack records, marks and the audit trail kept
permanently. The sweep and the hold flag are 8a.

*Also fixed:* an FPTStaff learner push that comes back with an id already held by another
person here is recorded as a conflict (possible duplicate person) instead of retrying; the
sample sync issues stable ids across restarts.

**8d — Analytics (delivered 10 Sep 2026).** New administrator page, filtered by a date
window over the *sitting* date and optionally one qualification. Headline: sittings, papers
written, pass rate, average mark, average hours to mark a script, share flagged for a look.
*Who actually sat* — the funnel from registered to released, naming where learners fall out
(never arrived, checked in but never opened, opened but never submitted, still being marked).
*Results by…* — the same measures cut by qualification, cohort, paper, venue, sitting or
month. *Are the questions doing their job?* — item analysis per paper: marks, average,
**facility** (share of available marks earned) and **discrimination** (strongest third minus
weakest third), zeroes, full marks, blanks, and plain-language flags ("almost everyone got it
— separates nobody", "the strongest learners did no better than the weakest — review this
question"); nothing is flagged below five marked scripts and the page says so. *Marking
consistency* — per assessor: scripts signed off, time to mark, average awarded, and how their
marks sat against the AI suggestion (accepted unchanged %, mean difference in marks, above /
below, outcome differed, suggestions overridden) — the AI is a mirror, not an authority, and
the page says so. *What the proctoring caught* — how often each integrity finding fires, so a
rule that fires on everyone or never fires can be questioned. Every table exports to CSV.
Administrator only; assessors may see the item analysis of a paper they mark.

**8e — Reminders and two job lanes (delivered 10 Sep 2026).** Nobody has to remember to look:
assessors are told each morning what is waiting (and firmly, once a script passes the
five-day rule); everyone working a sitting — invigilators and the assessor of record — is
told the afternoon before, with the venue, the roster size, how many still need codes and
what evidence is being kept; the Administrator gets a daily digest (yesterday, today, what is
stuck) and an alert when something needs attention now. Every reminder is written to a log
first with a dedupe key carrying the day or the sitting, so a restart, a second server or a
hand-run can never send it twice. **Until SMTP is set, nothing is lost**: each reminder is
kept as *held back — email not connected* and the exact text is on screen to send by hand.
*System* page (new): **Needs attention** (jobs that gave up, results not reaching FPTStaff,
blocked papers, sittings without codes, overdue scripts, recordings that never arrived, email
not connected), **Reminders sent** with *Run the reminders now*, plus the retention and audit
screens below. The same attention list appears on the Overview. The job runner now drains two
independent lanes — slow (AI marking review) and quick (emails, FPTStaff pushes, sweeps) — so
a queue of marking reviews never holds up an email again. `REMINDERS=off` switches reminders
off.

**8a — Security and retention (delivered 10 Sep 2026, deliberately last).**
*Rate limits* where guessing would pay, counted only against failures: signing in (20 per
account+address per 10 min), authenticator codes (12), entering with a sitting code (60 — a
room of thirty typing twice is unaffected), set-up links (30/hour), and a 600/min backstop.
Off outside production unless `RATE_LIMITS=on`, so tests are never measuring themselves.
*Security headers* (helmet): content-security-policy locked to this origin with
`frame-ancestors 'none'`, `X-Frame-Options: DENY`, nosniff, HSTS, strict referrer, no
`X-Powered-By`, `noindex`. The one that matters here is
`Permissions-Policy: camera=(self), microphone=(self), display-capture=(self)` with
geolocation, payment, USB, serial, Bluetooth, MIDI and idle-detection switched off — the exam
room may use the camera and share the screen; nothing it embeds can. One proxy hop is trusted
so limits and the audit trail see the real client address behind Replit.
*Evidence retention*, as the consent text promises: captures and recordings are deleted 12
months after the sitting, nightly and on demand. What goes is the image and video bytes; what
stays for good is **every SHA-256 hash**, the seal, the integrity report, the marks, the
Statement of Results and the audit trail — a purged sitting can still be shown to have been
run properly and verified, it just no longer holds anyone's picture. A player asked for purged
video says so rather than failing. **Hold**: a sitting (or one learner) under appeal or
investigation is never swept — set from the Evidence Archive with a reason, released the same
way. *What would go?* runs the sweep as a dry run.
*Audit trail* screen: every recorded action, newest first, searchable and filterable by
action, paged, exportable to CSV — and taking the export is itself recorded. Nothing in the
trail can be edited or deleted through the application.
*Dependency audit:* `npm audit` run and the non-breaking fixes applied. What is left, and why
it is left, is in `docs/security-notes.md` — the four remaining advisories are all
major-version upgrades or have no fix, none is reachable from a learner's browser, and each
has a stated plan.

## Decisions taken 9 Sep 2026 (were the open decisions)

*Added 10 Sep 2026:* **the shape of a paper.** A Final Integrated Summative Assessment is an
examination: at least **20 multiple-choice** questions (1 mark each), **6 knowledge-and-depth**
questions (identify, list, explain, describe; short answers, 4–6 marks) and **6 comprehensive**
questions (evaluate, advise, make the connection, apply to a scenario, fuller written answer —
analysis and critical thinking; 8–12 marks). No practical activities, uploads or workplace
tasks — practicals are assessed in the workplace. About 110 marks; 180 minutes recommended,
110 the minimum. Drafting builds to this shape; the standard check measures every paper
against it (a QCTO paper short of the shape does not meet the standard and is blocked; a
non-QCTO paper is flagged); *Fix the gaps* restructures towards it; the instrument page shows
*Paper shape* with the counts against the standard. Delivered 10 Sep 2026.

*Added 10 Sep 2026:* **one proctoring level only.** Every sitting is fully invigilated as
built (full screen, camera and screen captures, locks, live invigilator at 1:30). A lighter
"recorded" mode was considered and declined.

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

## Before the first real sitting (10 Sep 2026 — nothing left to build, only to switch on)

On the Repl's **Secrets**:

1. `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` — until these are
   set nothing is emailed. Set-up links, result notices and every reminder are kept on
   screen instead (*System → Reminders sent*), so nothing is lost, but every one has to be
   sent by hand. This is the single most valuable switch left.
2. `MFA_REQUIRED=yes` — authenticator app for every administrator, assessor and invigilator.
3. `RECORDINGS_STORAGE=replit` and a bucket in **App Storage**, for any sitting kept as a
   full recording. Roughly 1 MB per minute for both streams: a three-hour paper is about
   0.5–1 GB per learner, and a 30-learner room wants 15–25 Mbps upstream.
4. **Remove** `CURRICULA_BUILDER_MOCK`, `FPTSTAFF_MOCK` and `ENABLE_PAPER_AUTHORING`. The
   first two serve sample data; the third lets a paper be typed in without a standard check.
5. **Remove** `ADMIN_RECOVER` if it is still set.
6. `DATA_ENCRYPTION_KEY` / `FIELD_KEY` set before real ID numbers go in (see
   `security-notes.md`).
7. Optional: `REMINDERS=off` silences the reminder emails; `RATE_LIMITS` is on by default in
   production.

Then, in the app:

8. **Rehearsal.** One sitting, three or four staff as learners, one fully recorded: enter with
   a code, check in, write, lock the paper by leaving the window, have the invigilator release
   it, submit, mark and sign off, and read the result as the learner. Then take the
   **Portfolio of Evidence** and open one **evidence pack** — that is what a verifier sees.
9. **Papers.** Retire anything that cannot be fixed (*Set up an Assessment → the paper →
   Retire it*), and check every live paper's **Alignment matrix** and **Paper shape** card.
10. **People.** Pull assessors, invigilators and learners from FPTStaff once its side is
    built, or import the spreadsheet; every learner needs their 13-digit ID number.
11. **Jacques' side.** `curricula-builder-contract.md` + `curricula-builder-export-reference.md`
    for the Curricula Builder export; `fptstaff-contract.md` + `fptstaff-sync-reference.md`
    for the FPTStaff sync. FPT Exam validates both and names the field that is wrong.
