# FPT Exam

FPT Academy's secure online exam centre.

The proctored FISA/EISA exam platform described in `docs/exam-centre-spec.md`
and `docs/exam-centre-build-brief.md`. Where those two documents and the
project's `moderation-signoff-policy.md` / `build-roadmap.md` disagree, the
latter two are current.

**Built so far (Phases A and B):** login with MFA and role-based access; the
Administrator area (qualifications, assessment instruments via manual entry /
AI-from-SAQA / AI-from-uploaded-QCTO-document, exam sittings, learner
assignment, user registration with the FPTStaff pull-through designed in); the
Learner exam-taking flow (start → answer → autosave → submit). Four roles:
Administrator, Learner, Assessor, Invigilator - moderation and QA live in the
separate FPTStaff application.

**Next (Phase C onward):** the Assessor marking screen and AI marking/gap
engine, then proctoring, then switching on the FPTStaff and Curricula Builder
integrations. See `build-roadmap.md` in the project for the full phase plan.

## Running locally

Requirements: Node 20+, PostgreSQL 16 (a local install, or point `DATABASE_URL`
at a hosted instance such as Neon/Supabase).

```bash
npm install

# create server/.env from the example and fill in real values
cp server/.env.example server/.env

# create the database referenced by DATABASE_URL, e.g.:
#   createdb fpt_exam_centre

npm run db:generate   # generate SQL migration from the schema (already committed under server/drizzle/)
npm run db:migrate    # apply it
npm run db:seed       # create the bootstrap Administrator from ADMIN_EMAIL/ADMIN_PASSWORD in server/.env

npm run dev           # runs the API (port 4000) and the Vite client (port 5173) together
```

Open http://localhost:5173 and log in with the bootstrap admin credentials
from `server/.env`. The bootstrap admin has no MFA enrolled yet — add an
enrolment endpoint before go-live and enrol it immediately after first login
(see the comment in `server/src/db/seed.ts`).

## Production build (this is what Replit runs)

```bash
npm run build   # builds the client, then the server
npm start       # single Express process serves the built client AND the API on one port
```

## Repository layout

```
client/    React + Vite + TypeScript + Tailwind frontend
server/    Node + Express + TypeScript backend, Drizzle ORM schema/migrations
shared/    Types shared with the client (server derives its own copy from the DB schema - see server/src/types.ts)
docs/      The functional spec and engineering build brief this scaffold was built from
```

## Deploying

This repo is built to run on Replit (`.replit` sets the build/run commands and
provisions Postgres), but nothing about it is Replit-specific — `npm run
build && npm start` with a `DATABASE_URL` pointed at any Postgres instance
works anywhere (a VM, Render, Railway, Fly.io, etc.). Object storage (R2/S3)
is not wired up yet, so there are no other required secrets beyond what's in
`server/.env.example` (the AI engines' secret, `ANTHROPIC_API_KEY`, *is*
wired up as of Phase 5).

### Getting this onto Replit

1. Go to [replit.com/import](https://replit.com/import), choose **ZIP**, and
   upload this project's zip file. If Replit's Agent asks what to do with the
   import, choose **"Get it running on Replit"**.
2. Open the **Secrets** tool and add: `JWT_SECRET`, `ADMIN_NAME`,
   `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ANTHROPIC_API_KEY` (and `APP_BASE_URL`
   once you have a final domain). `DATABASE_URL` is normally set for you by
   Replit's built-in Postgres; add it only if it's missing.
3. Click **Run**. That's it - on start the server applies the database
   migrations and creates the Administrator from the `ADMIN_*` secrets
   automatically, so there are no Shell commands to run. Log in with
   `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

If you ever change `ADMIN_PASSWORD` *after* the account exists, the start-up
step deliberately won't overwrite a live credential - run
`npm run db:reset-admin-password` in the Shell once to apply the new value.

## Next steps

See `build-roadmap.md` (project) - Phase C (Assessor marking & the AI
Response-Review engine) is next, then Phase D (proctoring & invigilation).
