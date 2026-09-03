# FPT Exam

FPT Academy's secure online exam centre.

Phase 1 scaffold: repo structure, full database schema, and authentication
(login, MFA, RBAC) for the proctored exam platform described in
`docs/exam-centre-spec.md` and `docs/exam-centre-build-brief.md`.

**What's implemented:** Administrator-only user registration (with the
Invigilator/Assessor role-independence rule enforced), login, TOTP-based MFA,
JWT sessions, RBAC middleware, the full 17-table schema for the whole
platform (not just auth), and a minimal React client with role-routed
dashboards (Administrator's is functional — create/list users; the other five
are placeholders proving the login → RBAC → routing loop end to end).

**Not yet implemented** (see the build brief's phased list): qualification /
instrument intake, exam sitting setup, the learner exam-taking UI, proctoring
capture, recording/storage, the two AI engines, and the moderation/release
workflow.

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
and the AI engines from the build brief are not wired up yet, so there are no
other required secrets beyond what's in `server/.env.example`.

## Next steps

Follow the phased build order in `docs/exam-centre-build-brief.md` (Section
7): qualification/instrument intake next, then exam sitting setup and the
learner exam-taking UI, before layering on proctoring capture and the AI
engines.
