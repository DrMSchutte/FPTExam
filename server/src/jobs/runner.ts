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

// Block 8e: two lanes, drained independently. An AI review can take minutes;
// an email or an FPTStaff push must not wait behind it, and a queue of twenty
// submissions must not hold up tomorrow's reminders. Each lane claims only its
// own job types, so the atomic claim still guarantees one runner per job.
const LANES = {
  slow: ["ai_response_review"],
  quick: ["fptstaff_push", "result_email", "fptstaff_learner_push", "reminder_sweep", "send_notifications", "retention_sweep"],
} as const;
const ALL_JOB_TYPES = [...LANES.slow, ...LANES.quick];

export async function enqueueJob(jobType: string, payload: Record<string, unknown>): Promise<string> {
  const [job] = await db.insert(backgroundJobs).values({ jobType, payload, status: "pending" }).returning();
  return job.id;
}

async function claimNext(types: readonly string[]) {
  // Claim the oldest due pending job of a type this lane runs.
  const rows = await db.execute(sql`
    UPDATE background_jobs
       SET status = 'running', attempts = attempts + 1
     WHERE id = (
       SELECT id FROM background_jobs
        WHERE status = 'pending'
          AND run_after <= now()
          AND job_type IN (${sql.join(types.map((t) => sql`${t}`), sql`, `)})
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

// Block 6: delivered to FPTStaff with the Statement of Results
// (integrations/fptstaff/sync.ts). Not connected = deferred, sent later with Push now.
async function runFptstaffPush(payload: { pushId: string }) {
  const { runResultPush } = await import("../integrations/fptstaff/sync.js");
  return runResultPush(payload);
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
    } else if (job.job_type === "fptstaff_learner_push") {
      const { runLearnerPush } = await import("../integrations/fptstaff/sync.js");
      result = await runLearnerPush(job.payload as { userId: string });
    } else if (job.job_type === "reminder_sweep") {
      const { runReminderSweep } = await import("../notify/index.js");
      result = { ...(await runReminderSweep(job.payload as { force?: boolean })) };
    } else if (job.job_type === "send_notifications") {
      const { sendPending } = await import("../notify/index.js");
      result = await sendPending();
    } else if (job.job_type === "retention_sweep") {
      const { runRetentionSweep } = await import("../retention/index.js");
      result = { ...(await runRetentionSweep(job.payload as { dryRun?: boolean })) };
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

const timers: NodeJS.Timeout[] = [];
const busy: Record<string, boolean> = {};

async function tick(lane: keyof typeof LANES) {
  if (busy[lane]) return;
  busy[lane] = true;
  try {
    // Drain everything that's due in this lane, one at a time.
    for (;;) {
      const job = await claimNext(LANES[lane]);
      if (!job) break;
      await runOne(job);
    }
  } catch (err) {
    console.error(`Job runner (${lane} lane) tick failed:`, err);
  } finally {
    busy[lane] = false;
  }
}

export function startJobRunner() {
  if (timers.length) return;
  // Anything left 'running' by a process that died mid-job goes back to the
  // queue on start so it is picked up again rather than stuck forever.
  db.update(backgroundJobs)
    .set({ status: "pending" })
    .where(
      and(
        eq(backgroundJobs.status, "running"),
        sql`${backgroundJobs.jobType} IN (${sql.join(ALL_JOB_TYPES.map((t) => sql`${t}`), sql`, `)})`,
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
  for (const lane of Object.keys(LANES) as (keyof typeof LANES)[]) {
    timers.push(setInterval(() => void tick(lane), POLL_MS));
    void tick(lane);
  }
  // Block 5b: papers still open past their deadline are submitted as they stand.
  timers.push(setInterval(() => {
    autoSubmitExpired().then((n) => { if (n) console.log(`Auto-submitted ${n} paper(s) at time-up.`); }).catch((err) => console.error("Auto-submit sweep failed:", err));
  }, 60_000));
  // Block 8e: on the hour, work out which reminders are due and send whatever
  // is waiting. Also the nightly retention sweep (Block 8a). Both are ordinary
  // jobs, so they are recorded, retried and visible like everything else.
  timers.push(setInterval(() => void hourly(), 5 * 60_000));
  void hourly();
  console.log("Background job runner started (slow and quick lanes).");
}

// Block 8e: the hourly work, enqueued as ordinary jobs so it is recorded,
// retried and visible like everything else. The poll runs more often than
// hourly, so the hour key keeps it to once an hour; anything queued in
// between (a reminder written by hand) is still sent on the next poll.
let lastHourRun = "";
async function hourly() {
  const hourKey = new Date().toISOString().slice(0, 13);
  if (lastHourRun === hourKey) {
    await enqueueJob("send_notifications", {}).catch(() => undefined);
    return;
  }
  lastHourRun = hourKey;
  try {
    await enqueueJob("reminder_sweep", {});
    await enqueueJob("send_notifications", {});
    // 03:00 SAST: the retention sweep.
    if (new Date().getUTCHours() === 1) await enqueueJob("retention_sweep", {});
  } catch (err) {
    console.error("Could not enqueue the hourly work:", err);
  }
}
