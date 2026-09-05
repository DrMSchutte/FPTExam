import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
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
          AND job_type IN ('ai_response_review', 'fptstaff_push')
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

async function runOne(job: { id: string; job_type: string; payload: Record<string, unknown>; attempts: number }) {
  try {
    let result: Record<string, unknown>;
    if (job.job_type === "ai_response_review") {
      result = await runAiResponseReview(job.payload as { sessionId: string });
    } else if (job.job_type === "fptstaff_push") {
      result = await runFptstaffPush(job.payload as { pushId: string });
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
        sql`${backgroundJobs.jobType} IN ('ai_response_review', 'fptstaff_push')`,
        lte(backgroundJobs.attempts, MAX_ATTEMPTS)
      )
    )
    .catch((err) => console.error("Could not requeue orphaned jobs:", err));
  timer = setInterval(() => void tick(), POLL_MS);
  void tick();
  console.log("Background job runner started.");
}
