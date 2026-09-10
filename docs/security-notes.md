# FPT Exam: security notes

Written 10 September 2026 with Block 8a. Confidential — FPT Academy (Pty) Ltd.

This page says what protects the exam, what the dependency audit reports, and what is
deliberately left alone with the reason. It is meant to be readable by whoever asks the
question — an auditor, the QCTO, or Jacques.

## What protects a sitting

| Concern | What stops it |
|---|---|
| Someone else writing the paper | Sitting code issued per learner, checked against the registered 13-digit ID number, identity photograph taken at check-in and shown to the invigilator, live invigilation throughout |
| Guessing a sitting code | Codes are 12 characters from a 31-letter alphabet without look-alikes, hashed in the database, one use per learner, and rate-limited to 60 failed attempts per address per 10 minutes |
| Guessing a password | 20 failed attempts per account and address per 10 minutes; successful sign-ins are not counted, so a real user is never locked out by someone else's guessing |
| A stolen password | Authenticator app required for every supervisory role when `MFA_REQUIRED=yes` |
| Getting help during the paper | Full screen enforced, leaving the window locks the paper, paste blocked and recorded, camera and screen captured at intervals (and continuously when the sitting is fully recorded), every event on the invigilator's console live |
| Changing an answer afterwards | The seal: SHA-256 over the session, the submission time, the answers as submitted and every capture hash, in order. Re-computing it proves nothing changed |
| Changing the record afterwards | Marks and sign-off are append-only in effect; every action is in the audit trail, which the application cannot edit or delete |
| The exam page being framed or embedded | `frame-ancestors 'none'` and `X-Frame-Options: DENY` |
| Another site using the camera through us | `Permissions-Policy: camera=(self), microphone=(self), display-capture=(self)` — this origin only |
| Evidence kept longer than promised | The 12-month retention sweep, with a hold for anything under appeal |
| Evidence deleted too early | The hold, and the sweep's dry run; every purge is audited with counts |

## Secrets

Never in the repository, never in a bundle: `server/.env` is git-ignored. On Replit they are
Secrets. The ones that matter:

- `DATABASE_URL`, `SESSION_SECRET`, `FIELD_KEY` (encrypts ID numbers and sitting codes at rest)
- `ADMIN_EMAIL`, `ADMIN_PASSWORD` — the bootstrap administrator. `ADMIN_RECOVER=yes` resets
  that one account's password on start; **remove it again straight after use.**
- `MFA_REQUIRED=yes` — authenticator app for every supervisory sign-in
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` — without these nothing is
  emailed; reminders and result notices are kept on screen instead
- `RECORDINGS_STORAGE=replit` (+ `RECORDINGS_BUCKET`) for full recording
- `CURRICULA_BUILDER_BASE_URL` / `_API_KEY`, `FPTSTAFF_BASE_URL` / `_API_KEY`
- `RATE_LIMITS=on|off` (on by default in production), `REMINDERS=off` to silence reminders
- Remove `CURRICULA_BUILDER_MOCK`, `FPTSTAFF_MOCK` and `ENABLE_PAPER_AUTHORING` before the
  first real sitting: the first two serve sample data, the third allows a paper to be typed
  in without a standard check.

## Dependency audit — 10 September 2026

`npm audit --omit=dev` on the production tree. Non-breaking fixes applied. What remains:

| Package | Severity | Why it is left | Plan |
|---|---|---|---|
| `drizzle-orm` 0.33 | high | The advisory is SQL injection **through table and column identifiers**. Every identifier in this codebase is a literal in our own source; no user input ever reaches one. The fix is a twelve-minor-version jump across the layer that talks to the database, days before go-live | Upgrade to 0.45.x after the first real sitting, with the full test suite green |
| `vite` 5 | high | Vite builds the client and never serves traffic; the advisory is in its development server, which does not run on Replit. Production is served by Express from `client/dist` | Upgrade with the next front-end work |
| `xlsx` (SheetJS) 0.18.5 | high | Prototype pollution and ReDoS while parsing a hostile spreadsheet. There is no fixed version on npm (the maintained build is only on the vendor's CDN, which would make `npm install` depend on that CDN staying up — a worse risk for a live exam). Only an authenticated **administrator** can reach the one route that parses a file, and parsing is now capped at 20 000 rows; the parsed keys are read, never merged into objects | Replace with a maintained reader (or the CDN tarball, vendored into the repo) when the people-import screen is next touched |
| `react-router-dom` 6 | moderate | The advisory needs the framework's data-router features, which this client does not use | Upgrade with the next front-end work |
| `@google-cloud/storage` chain (`gaxios`, `retry-request`, `teeny-request`, `uuid`) | moderate | Pulled in by `@replit/object-storage`, used only for recording segments, and only when `RECORDINGS_STORAGE=replit`. No fix published upstream | Watch for a `@replit/object-storage` release |
| `qs` (via express 4) | moderate | Express 4.22 pins `~6.15.1`; the patched `qs` is 6.16. Forcing it with an npm override made npm drop the package altogether, which breaks the server — so it is left. Query strings here are short and validated by zod before use | Resolves itself with an express upgrade |

Re-run `npm audit --omit=dev` after any dependency change, and before each go-live.

## What is deliberately *not* built

- **No password reset by email link.** An administrator re-issues a set-up link instead, so a
  mailbox alone can never take over an assessor's account.
- **No "remember this device".** Every supervisory sign-in asks for the authenticator code.
- **No learner access to anyone else's anything.** A learner can see their own result, their
  own Statement and their own recordings, and nothing else; the checks are on the session, not
  on the URL.
- **No delete of the audit trail, marks or statements**, from any screen, by any role.
- **No AI decision.** The AI suggests marks and flags gaps; a registered assessor signs off,
  and the analytics show anyone who is rubber-stamping.

## If something goes wrong

1. **System → Needs attention** is the first place to look; it is the same list the daily
   digest is built from.
2. A learner locked out mid-paper: the invigilator releases the paper from the live console.
   Nothing is lost — answers are saved as they are typed.
3. A sitting that must not be deleted: **Evidence Archive → the sitting → Hold this
   evidence**, with a reason.
4. Suspected tampering: take the **Portfolio of Evidence** for the sitting and re-hash the
   files against `manifest.json`; the seal in each evidence pack covers the answers and the
   captures together.
5. The administrator account is locked out: set the Secret `ADMIN_RECOVER=yes`, Stop, Run,
   sign in with `ADMIN_PASSWORD`, then **remove the Secret**.
