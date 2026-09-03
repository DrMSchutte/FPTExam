# FPT Exam

FPT Academy's Secure Online Exam Centre

## Functional & Technical Specification — Proctored FISA / Final Exams Platform

Prepared for: FPT Academy
Date: 29 August 2026
Status: Draft v1 — for internal review before build (target platform: Replit)

---

## 1. Purpose and Scope

FPT Academy requires a secure, proctored online exam centre to administer **Final Integrated Summative Assessments (FISA)** and other final/certificational exams for QCTO-registered occupational qualifications, built and completed entirely online. The platform must let assessors and invigilators supervise learners remotely in real time, capture visual evidence of the exam session (webcam + periodic screen captures, with optional full recording), store that evidence securely, and automatically assess each learner's submission — generating a mark/competency recommendation and per-question feedback — with **only the Assessor and Moderator** required to sign off before a result (and its feedback) becomes official and visible to the learner. No third approval layer sits in that chain: Head QA has organisation-wide oversight and hold authority, but is not a required gate on any individual result (Section 3).

This document is a build specification, not code. It is written so it can be handed to a developer (or to Replit's Agent/Assistant) as a build brief, and so FPT Academy's team has a single reference for what the system must do, who is allowed to do what, and which regulatory obligations shape those decisions.

Because "FISA" is FPT Academy's working term, a regulatory note up front: QCTO's own terminology splits this by qualification type — **FISA (Final Integrated Summative Assessment)** applies to legacy/historically registered qualifications, while **EISA (External Integrated Summative Assessment)** applies to qualifications registered directly under QCTO's occupational framework. Confirm with your AQP (Assessment Quality Partner) which term applies to each qualification you run through this platform — the workflow below works for both; the document uses "FISA/EISA" or just "the final assessment" throughout.

## 2. Regulatory Foundation (what the design is constrained by)

The platform's role model, invigilation rules, and sign-off flow are built around QCTO's Assessment Policy and the FISA/EISA writing guidelines, plus South Africa's POPIA for anything involving recorded video, screen capture, or biometric-adjacent data. Three points from that research drive specific design decisions below:

- **QCTO's assessment policy has no provision for remote/online invigilation** — it was written assuming physical assessment centres. This means FPT Academy is not implementing a QCTO-mandated remote process; it is building a platform that must *reproduce, in a defensible and auditable way*, the identity-verification and no-fraudulent-activity guarantees the policy expects of an in-person invigilator. Treat every proctoring feature below as evidence you can show an AQP auditor, not as a QCTO-specified feature.
- **QCTO/AQP practice separates roles by function and by independence**: Assessment Specialists (assessors) develop/conduct/moderate; Moderators check that the process was fair, valid, reliable and unbiased; invigilators are procedural (identity + no fraudulent activity), not subject-matter roles, and guidelines for INSETA's FISA/EISA process explicitly require invigilators **not be employees of the assessment centre** for external assessments. Your platform's role/permission design should make this separation enforceable (e.g., an Invigilator account cannot also be the Assessor of record on the same exam sitting), and should let the Administrator flag a given exam as requiring an *independent* (non-FPT-employed) invigilator.
- **POPIA governs everything captured**: webcam video and screen recordings of a learner are personal information, and video capturing a person's face is treated as sensitive/biometric-adjacent processing requiring explicit, specific, informed consent, data minimisation, a defined retention period, and honouring access/correction/deletion requests. This is addressed throughout Sections 6, 9 and 10, and must be signed off by whoever handles compliance for FPT Academy before go-live — this document is not legal advice.

Sources consulted: [QCTO Assessment Policy for Qualifications and Part Qualifications](https://www.qcto.org.za/assets/qctos_-policy-on-assessment-of-qualifications-(3).pdf), [Guidelines for Writing of FISA & EISA (INSETA, 2018)](https://www.inseta.org.za/occupational-qualifications/wp-content/uploads/2019/06/Guidelines-For-Writing-of-FISA-and-EISA-2018.pdf), [QCTO: External Integrated Summative Assessment (EISA) — TrainYouCan](https://trainyoucan.co.za/qcto-external-integrated-summative-assessment-eisa/), [POPIA compliance essentials — Secure Privacy](https://secureprivacy.ai/blog/south-africa-popia-compliance).

## 3. Roles and Permissions

Six roles are in scope at launch. All roles other than Learner are created by an Administrator — there is no public sign-up.

**Administrator**
Full system configuration authority. Fetches/imports the FISA/EISA assessment instrument (question paper, marking guide, rubric, time allocation) from Curricula Builder — treated in this build as an external content source with no confirmed API yet (see Section 5) — and attaches it to an exam record. Registers and manages all other user accounts and roles (Learner, Invigilator, Assessor, Moderator, Head QA). Creates exam sittings: qualification, cohort, date/time window, assigned invigilator(s), assigned assessor, proctoring settings (capture interval, recording on/off, lockdown level). Assigns learners to sittings. Views system-wide audit logs, integrity dashboards, and recording storage status. Cannot mark exams or override an assessor's sign-off — Administrator is an operations/configuration role, not an academic one, to keep the "who can influence a result" line clean for auditors.

**Learner**
Registers for / is enrolled into an assigned exam sitting. Completes mandatory pre-exam steps: identity verification, device/environment check, POPIA consent capture, and a systems check (camera, mic, screen-share permission, bandwidth). Sits the exam inside the locked-down exam environment. Can raise an in-exam flag to the invigilator (e.g. "technical issue", "need a break" per the qualification's reasonable-accommodation rules). Has POPIA data-subject rights: can request a copy of their own recording/log, request correction of factual account data, and request deletion once the retention period and any dispute window has passed (Section 10).

**Invigilator**
Independent of the marking process. Monitors one or more live exam sessions in real time (video wall of learner webcams, live flag feed). Verifies learner identity at session start (ID document vs. webcam vs. registered photo). Can pause, message, or terminate a learner's session for a policy breach; logs every such action with a timestamp and reason (creates an immutable incident record). Does **not** see exam questions/answers and cannot be the Assessor of record for the same sitting — enforced by the permission system, not just convention, per Section 2. Where an exam is flagged "independent invigilation required," only accounts marked `employment_relationship = external` can be assigned.

**Assessor**
Subject-matter role. Receives, per learner, the submitted responses, the AI Integrity Report, and the AI Response-Review Report (Section 7) once the exam window closes. Marks or confirms marks against the qualification's marking guide, records a competent / not-yet-competent (or numeric mark, per qualification) outcome per assessment criterion, and either accepts, edits, or overrides every AI-generated flag or suggested mark before signing off — the system must make it structurally impossible to publish a result the Assessor has not personally reviewed and signed. Assessor sign-off is a hard gate; nothing becomes an official result before it.

**Moderator**
Reviews a sample (or all, per the qualification's moderation policy) of Assessor-signed results plus the underlying integrity evidence, to confirm the process was fair, valid, reliable and unbiased, and confirms or refers back to the Assessor. Cannot edit a mark directly — moderation is a check-and-refer function, not a re-marking function, matching how INSETA describes external moderation.

**Head QA** (internal Quality Assurance lead / the FPT-side equivalent of liaising with the AQP/QCTO) — **oversight only, not a sign-off gate**
Organisation-wide oversight: visibility into every exam's full audit trail (invigilation log, recordings metadata, AI reports, assessor and moderator decisions), and the ability to place a result on hold pending investigation. Manages the escalation path when an integrity flag is serious enough to require a formal enquiry, and can pull together the results-submission package for the AQP when needed. To be explicit, since this is a common point of confusion: **a result becomes official as soon as the Assessor signs off and the Moderator confirms — Head QA does not need to act on it.** Head QA's value is audit visibility and the ability to intervene (hold/escalate), not routine approval.

| Role | Sees exam content | Can mark | Can invigilate live | Can register users | Result sign-off? |
|---|---|---|---|---|---|
| Administrator | No (config only) | No | No | Yes | No |
| Learner | Own paper only | No | No | No | No |
| Invigilator | No | No | Yes | No | No |
| Assessor | Yes | Yes | No | No | Yes — required |
| Moderator | Yes (read) | No (refer only) | No | No | Yes — required, finalises the result |
| Head QA | Yes (read), full audit trail | No | No | No | No — oversight/hold only, not required |

## 4. Exam Lifecycle

1. **Instrument intake** — Administrator pulls the FISA/EISA package (paper, marking guide, time allocation, allowed materials) from Curricula Builder into the platform and attaches it to a new Exam record. Until Curricula Builder has a confirmed export/API, intake is a manual upload (PDF/DOCX/structured JSON) against a defined schema, so the pipeline is a drop-in replacement once an API exists (Section 5).
2. **Sitting setup** — Administrator configures the sitting: cohort, date/time window, duration, proctoring profile (capture cadence, full recording on/off, lockdown level, breaks allowed), assigned Invigilator(s) and Assessor, and whether independent invigilation is required.
3. **Enrolment & pre-checks** — Learners are assigned to the sitting. Ahead of the exam, each learner completes identity verification (ID document capture + liveness selfie compared against their registered profile photo), a device/browser check, and explicit POPIA consent for recording (Section 10) — a learner cannot enter the exam without all three.
4. **Check-in** — On the day, learner joins a virtual "waiting room," invigilator verifies identity live, confirms environment (room pan via webcam, desk clear), and admits the learner.
5. **Live sitting** — Learner works inside the locked-down exam environment (Section 6). Webcam stream is live to the invigilator throughout; screen captures are taken at a configurable interval (default: every 30–60 seconds) plus event-triggered captures (tab switch, paste event, window blur); full session recording (webcam + screen) is optional per sitting and, if enabled, streamed to encrypted storage continuously rather than buffered locally, so nothing is lost if the learner's device fails.
6. **Submission** — Learner submits or time expires (auto-submit). Session and recording are sealed (write-once) and the incident log for that learner is finalised.
7. **AI review** — The two AI engines (Section 7) run against the sealed session: the Integrity Engine produces a flagged-events report; the Response-Review Engine produces a suggested mark/competency recommendation per criterion against the marking guide. Both are attached to the learner's record as *recommendations*, clearly watermarked as AI-generated and not yet a result.
8. **Assessor review & sign-off** — Assessor sees the learner's submission, the Integrity Report, and the Response-Review Report side by side, marks (accepting/editing/overriding AI suggestions as needed), and signs off. This produces a provisional result.
9. **Moderation & release** — Moderator reviews the sampled/required results plus evidence, and confirms or refers back to the Assessor. **Moderator confirmation is the final step** — as soon as it's recorded, the result (mark/competency outcome plus the AI-generated per-question feedback) becomes official and visible to the Learner, and is ready for submission to the AQP/QCTO. No separate Head QA release action is required; Head QA can view every result and the evidence behind it at any time, and can place a hold on one before or after release if something needs investigating, but doesn't have to act for a result to go out.
10. **Retention & disposal** — Recordings and logs are retained per the policy in Section 10 and then disposed of automatically, unless a dispute or audit hold is active.

## 5. Curricula Builder Integration (placeholder interface)

Curricula Builder does not yet exist as a system with a confirmed API, so this build should define — and depend only on — a stable internal contract, so the eventual integration is additive rather than a rewrite:

- **Import contract**: an `AssessmentInstrument` object with fields: `qualification_id`, `qualification_title`, `assessment_type` (FISA / EISA / other), `version`, `questions[]` (each with id, type [MCQ / short-answer / long-answer / practical-upload], prompt, max_mark, model_answer/rubric_criteria), `time_allocation_minutes`, `permitted_materials[]`, `pass_mark_or_competency_rule`.
- **v1 intake**: Administrator-facing upload screen accepting a structured JSON/CSV per the schema above, or a guided form for manual entry, with validation against the schema before an instrument can be attached to an exam.
- **v2 (when Curricula Builder exists)**: a "Fetch from Curricula Builder" action on the same screen, authenticated via API key/OAuth, that lists available instruments for a qualification and imports the selected one into the same internal `AssessmentInstrument` object — no downstream code changes required.

## 6. Proctoring, Security & Invigilation Architecture

- **Identity verification**: ID-document capture + liveness check at enrolment, re-verified at check-in against the live webcam feed; mismatch blocks entry and alerts the invigilator.
- **Continuous presence check**: lightweight face-presence detection on the client (runs locally in-browser, not server-side, to minimise data sent) flags "face not visible," "multiple faces visible," or "different face detected" events to the invigilator's live dashboard and to the Integrity Engine.
- **Screen capture cadence**: default periodic screenshot every 30–60 seconds (configurable per sitting), plus event-triggered captures on tab/window blur, copy/paste, and (where feasible) detection of a second monitor or virtual machine.
- **Full session recording (optional per sitting)**: continuous webcam + screen video, streamed directly to encrypted object storage in chunks (not stored client-side) so a crash or forced shutdown doesn't destroy evidence; sealed and hashed on submission to prove it wasn't altered afterward.
- **Lockdown behaviour** (browser-based, since this runs on Replit rather than a native lockdown client): full-screen enforcement with exit-attempt detection, new-tab/new-window blocking where the browser API allows it, clipboard monitoring, and a configurable allow-list of permitted URLs/apps for practical/open-book components. Be explicit with stakeholders that browser-based lockdown cannot guarantee the same level of control as a dedicated native lockdown client (e.g. a learner using a second physical device is not detectable) — this is a known, documented limitation to disclose to QCTO/AQP auditors, not something to overclaim.
- **Live invigilation console**: grid view of all live webcams in a sitting, real-time flag feed (presence, tab-switch, paste, noise-threshold, network drop), one-click pause/message/terminate per learner, and a running incident log per learner that timestamps every invigilator action.
- **Chain of custody**: every recording, screenshot, and log entry is immutable once written (append-only storage, cryptographic hash recorded at seal time) so that evidence produced for an AQP audit or a dispute can be shown not to have been altered after the fact.

## 7. AI Assessment Bot

Two distinct engines feed one combined recommendation dossier per learner, and together they do the actual assessment automatically — a suggested mark/competency outcome plus per-question feedback for every submission, without an assessor manually marking from a blank slate. Neither engine has authority to finalise a result on its own, though: QCTO's model puts that authority with humans, and this platform limits the required chain to exactly two people — the Assessor, then the Moderator. Every AI output is explicitly labelled a *recommendation* until the Assessor actively accepts, edits, or rejects it and signs off, and the Moderator confirms. Nothing beyond those two steps is required (Head QA has oversight/hold authority, not a sign-off role — Section 3). This is a deliberate design constraint, not a limitation to fix later: an AQP auditing your process needs to see a human decision trail, not a fully automated one, but that trail should be as short as QCTO's model actually requires.

**7.1 Integrity Engine** — reviews the sealed screen captures, recording (if enabled), and the live-session event log for a learner's sitting, and produces a written findings report: which flags fired, at what timestamp, with the supporting screenshot/clip attached, and a plain-language summary (e.g. "3 tab-switch events between 00:12–00:14, no face-visibility issues, no multiple-face detections"). Optionally proposes an overall integrity recommendation ("no concerns" / "minor — note only" / "flag for investigation") based on FPT Academy's configurable thresholds, but always shows its reasoning and the underlying evidence rather than a bare verdict.

**7.2 Response-Review Engine** — yes, the actual submitted assessment responses are reviewed, not just the proctoring feed. This engine takes the learner's submitted answers plus the marking guide/rubric from the attached `AssessmentInstrument` (Section 5) and produces, per question/criterion: a suggested mark or competent/not-yet-competent judgement, the rubric criteria it matched or missed, and a confidence indicator. For practical/portfolio-style uploads (documents, images, code, etc.) it extracts and summarises the submission against the rubric rather than marking blind. This output is explicitly a *marking aid*, presented to the Assessor next to the learner's actual submission — never released to a Learner or Moderator as a mark in its own right.

**7.3 Combined dossier** — the Assessor's review screen shows, per learner: original submission, Response-Review suggestions inline against each answer, Integrity Engine findings with evidence, and a sign-off panel that logs the Assessor's final decision on every AI suggestion (accepted / edited / overridden, with an optional reason). This log is itself part of the audit trail Moderator and Head QA see.

**7.4 Feedback to the Learner** — once the Assessor has signed off and the Moderator has confirmed (Section 4, step 9), the per-question feedback from the Response-Review Engine — what was correct, what was missed against the rubric, and the final mark/competency outcome — is released to the Learner alongside their result. The Learner never sees AI output before that point; what they see afterward is the human-confirmed version of it (the Assessor's edits/overrides, if any, take precedence over the AI's original suggestion).

## 8. Data Model (core entities)

`User` (id, name, id_number_hash, email, role[], employment_relationship, photo_reference)
`Qualification` (id, title, qcto_registration_type: FISA/EISA, aqp_reference)
`AssessmentInstrument` (id, qualification_id, version, questions[], marking_guide, time_allocation, source: manual/curricula_builder)
`ExamSitting` (id, qualification_id, instrument_id, cohort_id, start_time, end_time, proctoring_profile, assigned_invigilators[], assigned_assessor, independent_invigilation_required: bool)
`LearnerSession` (id, sitting_id, learner_id, check_in_time, submission_time, status, consent_record_id)
`CaptureEvent` (id, session_id, type: screenshot/full_recording/system_event, storage_ref, timestamp, hash)
`IncidentLog` (id, session_id, raised_by: system/invigilator, type, timestamp, evidence_ref, action_taken)
`AIIntegrityReport` (id, session_id, findings[], overall_recommendation, generated_at)
`AIResponseReview` (id, session_id, per_question_suggestions[], generated_at)
`AssessorDecision` (id, session_id, per_criterion_marks[], ai_suggestions_accepted/edited/overridden[], sign_off_time)
`ModerationRecord` (id, session_id or cohort_id, decision: confirmed/referred, notes, moderator_id, timestamp)
`ResultRelease` (id, session_id — set automatically the moment Assessor sign-off + Moderator confirmation both hold true for that session, no separate human action; cohort_id — set only for an optional Head QA batch export/rollup for the AQP, not a gate; released_by: null for the automatic path, or the Head QA user id for an export event; released_at)
`ConsentRecord` (id, learner_id, sitting_id, consent_text_version, accepted_at, ip_address)

## 9. Suggested Technical Architecture (Replit-oriented)

- **Frontend**: React (Vite) SPA for Learner exam UI, Invigilator console, and Assessor/Moderator/Head QA dashboards, served from the same Replit app or split into role-specific bundles.
- **Backend**: Node.js/Express (or Python/FastAPI, either runs well on Replit) exposing REST/WebSocket APIs; WebSocket channel specifically for the live invigilation feed (flags, presence status) so the console updates in real time without polling.
- **Database**: PostgreSQL (Replit's built-in Postgres, or an external managed instance such as Neon/Supabase if you want a longer-lived database independent of the Repl's lifecycle) for all relational data in Section 8.
- **Media capture**: browser `getUserMedia`/`MediaRecorder` APIs for webcam+screen capture; `getDisplayMedia` for screen share; chunks uploaded over WebSocket or chunked HTTP to object storage as they're recorded, not buffered fully client-side.
- **Object storage for recordings/screenshots**: Replit's own storage is not designed for large video volumes at exam scale — use an S3-compatible bucket (AWS S3, Cloudflare R2, or Backblaze B2) with server-side encryption, a documented South African-or-adequate-jurisdiction region choice for POPIA cross-border rules, and lifecycle rules matching the retention policy in Section 10.
- **AI engines**: implemented as backend jobs (queued, not inline with the request) that run once a session is sealed, calling an LLM/vision API for the two review engines described in Section 7; results are written to `AIIntegrityReport`/`AIResponseReview` and never touch the Learner-facing UI.
- **Background jobs**: a lightweight queue (e.g. BullMQ over Redis, or a simple Postgres-backed job table if you want to avoid another moving part) for AI review jobs, retention/disposal jobs, and notification jobs.
- **Auth**: role-based accounts with mandatory MFA for Administrator, Assessor, Moderator, Head QA, and Invigilator roles (result-affecting or oversight roles); Learner accounts can use a lighter flow but still require the identity-verification step at enrolment.

## 10. POPIA & Data Governance

- **Consent**: a specific, plain-language consent screen presented before enrolment is complete, explaining exactly what is captured (webcam, screen, ID document image), why (exam integrity, QCTO/AQP evidentiary requirement), how long it's kept, and who can access it. Recorded as a `ConsentRecord` with a timestamped, versioned copy of the text the learner agreed to — not just a checkbox flag.
- **Minimisation**: capture only what the integrity/marking use case needs — no microphone-always-on audio recording unless a specific qualification requires it; no capture of the learner's surroundings beyond what identity/environment checks require.
- **Retention**: define a default retention period (commonly 6–12 months, aligned with the qualification's remark/dispute window and any AQP audit cycle) after which recordings and screenshots are automatically deleted by a scheduled job — with an audit-hold flag that can suspend deletion for a specific session under investigation or dispute.
- **Access control**: recordings are visible only to the assigned Invigilator (own sessions), Assessor/Moderator/Head QA (for review), and the Learner themself (own recording, on request) — never Administrator by default (Administrator manages accounts and exam setup, not evidentiary content), unless a specific investigation role is granted.
- **Data subject rights**: a documented process for a Learner to request access to, correction of, or deletion of their own data, honoured within a reasonable time as POPIA requires, with deletion requests checked against any active retention/dispute hold before being carried out.
- **Cross-border storage**: if using a cloud region outside South Africa, confirm the provider/region offers protection adequate under POPIA (or use a South African region where available) — this is a legal sign-off item, not a purely technical one.

This section is a design framework, not legal advice — have FPT Academy's compliance/legal function review and formally approve the consent text, retention periods, and storage jurisdiction before go-live.

## 11. Non-Functional Requirements

- **Availability during exam windows**: the platform must treat scheduled exam windows as its highest-priority uptime commitment — alerting, on-call coverage, and capacity headroom should be planned around exam dates, not general traffic patterns.
- **Graceful degradation**: a learner's connection drop should not lose captured evidence up to that point (continuous streaming upload, not end-of-session upload) and should let the invigilator resume/extend the session rather than forcing a restart.
- **Auditability**: every privileged action (role change, exam creation, sign-off, override, deletion) is logged with actor, timestamp, and reason where applicable — this log is itself evidence for an AQP audit.
- **Scalability**: architecture should handle concurrent sittings (multiple cohorts at once) without the live invigilation WebSocket channel degrading — plan capacity per concurrent learner, not just total registered learners.

## 12. Suggested Build Phases

1. **Phase 1 — Core roles & exam setup**: Administrator, Learner, Assessor accounts; manual instrument intake; basic exam creation and scheduling; learner exam-taking UI without proctoring.
2. **Phase 2 — Proctoring MVP**: identity verification, periodic screen capture, live invigilator console with presence flags, incident logging, POPIA consent flow.
3. **Phase 3 — Recording & storage**: full optional recording, object storage integration, retention/disposal automation, chain-of-custody hashing.
4. **Phase 4 — AI engines**: Integrity Engine, then Response-Review Engine, both as recommendation-only outputs into the Assessor's review screen.
5. **Phase 5 — Moderation & release workflow**: Moderator role, sign-off gating (Assessor + Moderator finalise a result automatically — no separate release step), and the Head QA oversight dashboard (audit trail viewer, hold capability) as a read/intervene-only role.
6. **Phase 6 — Curricula Builder integration**: replace manual instrument intake with the live API once Curricula Builder exists.

## 13. Open Questions for FPT Academy to Confirm

- Which qualifications on your books are FISA (legacy) vs. EISA (QCTO-registered), since the AQP contract and moderation requirements can differ.
- Target retention period for recordings/screenshots, and who at FPT Academy owns the POPIA sign-off.
- Whether any qualification requires audio recording, and if so, the added consent/POPIA handling that implies.
- Expected concurrent-sitting scale (how many learners at once, worst case) — this drives the storage and WebSocket capacity planning in Section 9 and 11.
- Whether "Head QA" in your organisation is purely internal, or also acts as the liaison of record to a specific AQP — affects what the final release step needs to produce (e.g. an auto-generated results submission package).

---

*Sources referenced in this document: [QCTO Assessment Policy for Qualifications and Part Qualifications](https://www.qcto.org.za/assets/qctos_-policy-on-assessment-of-qualifications-(3).pdf) · [Guidelines for Writing of FISA & EISA (INSETA, 2018)](https://www.inseta.org.za/occupational-qualifications/wp-content/uploads/2019/06/Guidelines-For-Writing-of-FISA-and-EISA-2018.pdf) · [QCTO: External Integrated Summative Assessment (EISA) — TrainYouCan](https://trainyoucan.co.za/qcto-external-integrated-summative-assessment-eisa/) · [POPIA compliance essentials — Secure Privacy](https://secureprivacy.ai/blog/south-africa-popia-compliance)*
