import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { autoSubmitExpired } from "../proctoring/session.js";
import {
  backgroundJobs,
  learnerSessions,
  examSittings,
  assessmentInstruments,
  qualifications,
  aiResponseReviews,
  fptstaffResultPushes,
} from "../db/schema.js";
import { reviewSubmission } from "../ai/responseReview.js";
import type { Question } from "../types.js";

// Postgres-backed background worker (build brief §5.4). One poller per server
// process; jobs are claimed with an atomic UPDATE ... WHERE status='pending'
// so two processes can never run the same job. No Redis, nothing extra to
// deploy on Replit.
//
// Job types handled here:
//   ai_response_review  { sessionId }  - runs the Response-Review engine (Phase C)
//   fptstaff_push       { pushId }     - delivers a queued result to FPTStaff (Phase E;
//                                        until the connection exists it is parked, not lost)
//
// Instrument generation jobs are *not* polled: routes/instruments.ts starts
// them as 'running' and executes them in-process (they are user-initiated and
// the client is already polling for the answer).

const POLL_MS = 5000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [30_000, 120_000, 600_000];

export async function enqueueJob(jobType: string, payload: Record<string, unknown>): Promise<string> {
  const [job] = await db.insert(backgroundJobs).values({ jobType, payload, status: "pending" }).returning();
  return job.id;
}

async function claimNext() {
  // Claim the oldest due pending job of a type we know how to run.
  const rows = await db.execute(sql`
    UPDATE background_jobs
       SET status = 'running', attempts = attempts + 1
     WHERE id = (
       SELECT id FROM background_jobs
        WHERE status = 'pending'
          AND run_after <= now()
          AND job_type IN ('ai_response_review', 'fptstaff_push', 'result_email')
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, job_type, payload, attempts
  `);
  const row = (rows.rows as Array<{ id: string; job_type: string; payload: Record<string, unknown>; attempts: number }>)[0];
  return row ?? null;
}

async function runAiResponseReview(payload: { sessionId: string }) {
  const [session] = await db.select().from(learnerSessions).where(eq(learnerSessions.id, payload.sessionId));
  if (!session) throw new Error(`Session ${payload.sessionId} not found.`);
  const [sitting] = await db.select().from(examSittings).where(eq(examSittings.id, session.sittingId));
  const [instrument] = await db
    .select()
    .from(assessmentInstruments)
    .where(eq(assessmentInstruments.id, sitting.instrumentId));
  const [qualification] = await db.select().from(qualifications).where(eq(qualifications.id, sitting.qualificationId));

  const rule = (instrument.passMarkOrCompetencyRule as { rule?: string } | null)?.rule ?? "";
  const review = await reviewSubmission({
    qualificationTitle: qualification.title,
    qctoRegistrationType: qualification.qctoRegistrationType,
    passRule: rule,
    questions: instrument.questions as Question[],
    answers: (session.answers as Record<string, string> | null) ?? {},
  });

  // One review per session: a re-run (e.g. after a failed first attempt)
  // replaces rather than duplicates.
  await db.delete(aiResponseReviews).where(eq(aiResponseReviews.sessionId, session.id));
  const [saved] = await db
    .insert(aiResponseReviews)
    .values({
      sessionId: session.id,
      perQuestionSuggestions: review.perQuestion,
      gapMap: review.gapMap,
      suggestedOutcome: review.suggestedOutcome,
      summary: review.summary,
    })
    .returning();
  return { reviewId: saved.id, questions: review.perQuestion.length };
}

async function runFptstaffPush(payload: { pushId: string }) {
  const [push] = await db.select().from(fptstaffResultPushes).where(eq(fptstaffResultPushes.id, payload.pushId));
  if (!push) throw new Error(`Result push ${payload.pushId} not found.`);
  // Phase E wires the real HTTP client here. Until FPTStaff can be reached the
  // push row stays 'pending' so it is delivered the moment the connection
  // exists; the job itself completes so it doesn't retry pointlessly.
  if (!process.env.FPTSTAFF_BASE_URL) {
    return { deferred: true, reason: "FPTStaff connection not configured (Phase E)." };
  }
  throw new Error("FPTStaff delivery is not implemented yet (Phase E).");
}

// Block 5d: tell the learner their result is out. Not configured email is a
// completed job with sent:false (shown on Results), not a failure to retry.
async function runResultEmail(payload: { sessionId: string; baseUrl?: string }) {
  const { sendMail, resultReleasedEmail, isMailConfigured } = await import("../email/mailer.js");
  const { learnerSessions, examSittings, qualifications, users } = await import("../db/schema.js");
  const [row] = await db
    .select({ name: users.name, email: users.email, qualificationTitle: qualifications.title })
    .from(learnerSessions)
    .innerJoin(users, eq(users.id, learnerSessions.learnerId))
    .innerJoin(examSittings, eq(examSittings.id, learnerSessions.sittingId))
    .innerJoin(qualifications, eq(qualifications.id, examSittings.qualificationId))
    .where(eq(learnerSessions.id, payload.sessionId));
  if (!row) return { sent: false, reason: "Session not found." };
  if (!isMailConfigured()) return { sent: false, to: row.email, reason: "Email is not connected yet (SMTP secrets not set)." };
  const base = (payload.baseUrl ?? process.env.APP_BASE_URL ?? "").replace(/\/+$/, "");
  const mail = resultReleasedEmail({ name: row.name, qualificationTitle: row.qualificationTitle, loginUrl: `${base}/login` });
  const r = await sendMail({ to: row.email, ...mail });
  if (!r.sent) throw new Error(r.reason ?? "Email failed.");
  return { sent: true, to: row.email, at: new Date().toISOString() };
}

async function runOne(job: { id: string; job_type: string; payload: Record<string, unknown>; attempts: number }) {
  try {
    let result: Record<string, unknown>;
    if (job.job_type === "ai_response_review") {
      result = await runAiResponseReview(job.payload as { sessionId: string });
    } else if (job.job_type === "fptstaff_push") {
      result = await runFptstaffPush(job.payload as { pushId: string });
    } else if (job.job_type === "result_email") {
      result = await runResultEmail(job.payload as { sessionId: string; baseUrl?: string });
    } else {
      throw new Error(`Unknown job type ${job.job_type}`);
    }
    await db.update(backgroundJobs).set({ status: "done", result }).where(eq(backgroundJobs.id, job.id));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const retry = job.attempts < MAX_ATTEMPTS;
    const delay = BACKOFF_MS[Math.min(job.attempts - 1, BACKOFF_MS.length - 1)];
    console.error(`Job ${job.id} (${job.job_type}) attempt ${job.attempts} failed: ${detail}${retry ? ` - retrying in ${delay / 1000}s` : ""}`);
    await db
      .update(backgroundJobs)
      .set({
        status: retry ? "pending" : "failed",
        runAfter: retry ? new Date(Date.now() + delay) : undefined,
        result: { error: `${job.job_type} failed.`, detail, attempts: job.attempts },
      })
      .where(eq(backgroundJobs.id, job.id));
  }
}

let timer: NodeJS.Timeout | null = null;
let busy = false;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    // Drain everything that's due, one at a time.
    for (;;) {
      const job = await claimNext();
      if (!job) break;
      await runOne(job);
    }
  } catch (err) {
    console.error("Job runner tick failed:", err);
  } finally {
    busy = false;
  }
}

export function startJobRunner() {
  if (timer) return;
  // Anything left 'running' by a process that died mid-job goes back to the
  // queue on start so it is picked up again rather than stuck forever.
  db.update(backgroundJobs)
    .set({ status: "pending" })
    .where(
      and(
        eq(backgroundJobs.status, "running"),
        sql`${backgroundJobs.jobType} IN ('ai_response_review', 'fptstaff_push', 'result_email')`,
        lte(backgroundJobs.attempts, MAX_ATTEMPTS)
      )
    )
    .catch((err) => console.error("Could not requeue orphaned jobs:", err));
  // In-process jobs (drafting, revising, checking, reading a paper, Curricula
  // Builder imports) cannot be resumed after a restart: mark them failed with a
  // plain reason so the Administrator's screen stops waiting and says why, and
  // put any paper left mid-check back to 'blocked' rather than 'checking' forever.
  db.execute(sql`
    UPDATE background_jobs
       SET status = 'failed',
           result = jsonb_build_object('error', 'The server restarted while this was running.', 'detail', 'Start it again from the assessment page.')
     WHERE status = 'running'
       AND job_type NOT IN ('ai_response_review', 'fptstaff_push')
  `)
    .then(() =>
      db.execute(sql`UPDATE assessment_instruments SET intake_status = 'blocked' WHERE intake_status = 'checking' AND created_at < now() - interval '1 minute'`)
    )
    .catch((err) => console.error("Could not fail orphaned in-process jobs:", err));
  timer = setInterval(() => void tick(), POLL_MS);
  void tick();
  // Block 5b: papers still open past their deadline are submitted as they stand.
  setInterval(() => {
    autoSubmitExpired().then((n) => { if (n) console.log(`Auto-submitted ${n} paper(s) at time-up.`); }).catch((err) => console.error("Auto-submit sweep failed:", err));
  }, 60_000);
  console.log("Background job runner started.");
}
