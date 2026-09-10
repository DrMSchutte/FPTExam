import "dotenv/config";
import express from "express";
// Express 4 does not catch a rejected promise in an async route; without this
// one bad query would take the whole server down. With it, the error reaches
// the JSON error handler below and the server stays up.
import "express-async-errors";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { authRouter } from "./routes/auth.js";
import { usersRouter } from "./routes/users.js";
import { peopleRouter } from "./routes/people.js";
import { cohortsRouter } from "./routes/cohorts.js";
import { sitRouter } from "./routes/sit.js";
import { backfillIdNumberHashes } from "./db/backfill.js";
import { qualificationsRouter } from "./routes/qualifications.js";
import { instrumentsRouter } from "./routes/instruments.js";
import { sittingsRouter } from "./routes/sittings.js";
import { analyticsRouter } from "./routes/analytics.js";
import { adminRouter } from "./routes/admin.js";
import { sessionsRouter } from "./routes/sessions.js";
import { runMigrations, ensureBootstrapAdmin } from "./db/bootstrap.js";
import { assessorRouter } from "./routes/assessor.js";
import { assessmentsRouter } from "./routes/assessments.js";
import { startJobRunner } from "./jobs/runner.js";
import { sampleExportRouter, isSampleExportEnabled } from "./integrations/curriculaBuilder/sampleExport.js";
import { sampleSyncRouter, isSampleSyncEnabled } from "./integrations/fptstaff/sampleSync.js";
import { fptstaffRouter } from "./routes/fptstaff.js";
import { applySecurity, apiLimiter } from "./security/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Block 8a: security headers, the camera/screen permission policy, and the
// trusted proxy hop, before any route runs.
applySecurity(app);

app.use(
  cors({
    origin: process.env.APP_BASE_URL ?? "http://localhost:5173",
    credentials: true,
  })
);
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// A backstop against a runaway client; the tight limits are on the routes that
// need them (sign-in, authenticator, sitting entry).
app.use("/api", apiLimiter);

app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/people", peopleRouter);
app.use("/api/cohorts", cohortsRouter);
app.use("/api/sit", sitRouter);
app.use("/api/qualifications", qualificationsRouter);
app.use("/api/instruments", instrumentsRouter);
app.use("/api/assessments", assessmentsRouter);
// Block 7: the sample Curricula Builder export (CURRICULA_BUILDER_MOCK=yes only).
if (isSampleExportEnabled()) app.use("/api/exam-export", sampleExportRouter);
// Block 6: FPTStaff connection, and its sample stand-in (FPTSTAFF_MOCK=yes only).
app.use("/api/fptstaff", fptstaffRouter);
if (isSampleSyncEnabled()) app.use("/api/exam-sync", sampleSyncRouter);
app.use("/api/sittings", sittingsRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/admin", adminRouter);
// sessionsRouter's own paths already start with /sessions or /me, so it
// mounts at the API root rather than under an extra prefix.
app.use("/api", sessionsRouter);
// Assessor marking routes (/assessor/queue, /sessions/:id/dossier, ...).
app.use("/api", assessorRouter);

// Last line of defence: any error a route did not handle becomes a JSON 500
// for that one request, logged here, and the server keeps serving everyone else.
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Something went wrong on the server. The request was not completed.", detail });
});

// In production, serve the built client so a single Replit run command
// (npm run build && npm start) is enough - no separate static host needed.
if (process.env.NODE_ENV === "production") {
  const clientDist = path.resolve(__dirname, "../../client/dist");
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
}

const port = Number(process.env.PORT ?? 4000);

// Bring the database up to date and make sure an Administrator exists before
// accepting traffic. Both steps are idempotent (see db/bootstrap.ts), so a
// fresh deployment only needs its secrets set - nothing to run by hand.
async function start() {
  try {
    await runMigrations();
    console.log("Database schema is up to date.");
    const admin = await ensureBootstrapAdmin();
    if (admin === "created") console.log(`Bootstrap administrator created: ${process.env.ADMIN_EMAIL}`);
    else if (admin === "recovered") console.warn(`Administrator ${process.env.ADMIN_EMAIL} recovered - sign in with ADMIN_PASSWORD, then remove the ADMIN_RECOVER secret.`);
    else if (admin === "skipped")
      console.warn("ADMIN_EMAIL / ADMIN_PASSWORD not set - no bootstrap administrator created.");
    const hashed = await backfillIdNumberHashes();
    if (hashed) console.log(`ID-number identifiers indexed for ${hashed} existing people.`);
  } catch (err) {
    console.error("Start-up bootstrap failed:", err);
    process.exit(1);
  }

  listenTakingOver(port);
}

// A new build must be able to take over from whatever is on the port - an
// earlier instance the workflow lost track of, or one started from the Shell.
// On EADDRINUSE, stop the holder and try again, so pressing Run always wins.
function listenTakingOver(p: number, attempt = 0) {
  const server = app.listen(p, () => {
    console.log(`FPT Exam API listening on port ${p}`);
    startJobRunner();
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && attempt < 5) {
      console.warn(`Port ${p} is held by an earlier instance - stopping it and taking over (attempt ${attempt + 1}).`);
      freePort(p);
      setTimeout(() => listenTakingOver(p, attempt + 1), 1500);
    } else {
      console.error("Could not start the server:", err);
      process.exit(1);
    }
  });
}

function freePort(p: number) {
  // Whichever tool the image has; each one kills only the process on that port.
  for (const cmd of [`fuser -k ${p}/tcp`, `lsof -ti tcp:${p} | xargs -r kill`, `ss -ltnp 'sport = :${p}' | grep -o 'pid=[0-9]*' | cut -d= -f2 | xargs -r kill`]) {
    try {
      execSync(cmd, { stdio: "ignore" });
      return;
    } catch {
      /* try the next */
    }
  }
}

start();
