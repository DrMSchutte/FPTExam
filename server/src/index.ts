import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authRouter } from "./routes/auth.js";
import { usersRouter } from "./routes/users.js";
import { qualificationsRouter } from "./routes/qualifications.js";
import { instrumentsRouter } from "./routes/instruments.js";
import { sittingsRouter } from "./routes/sittings.js";
import { sessionsRouter } from "./routes/sessions.js";
import { runMigrations, ensureBootstrapAdmin } from "./db/bootstrap.js";
import { assessorRouter } from "./routes/assessor.js";
import { startJobRunner } from "./jobs/runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(
  cors({
    origin: process.env.APP_BASE_URL ?? "http://localhost:5173",
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/qualifications", qualificationsRouter);
app.use("/api/instruments", instrumentsRouter);
app.use("/api/sittings", sittingsRouter);
// sessionsRouter's own paths already start with /sessions or /me, so it
// mounts at the API root rather than under an extra prefix.
app.use("/api", sessionsRouter);
// Assessor marking routes (/assessor/queue, /sessions/:id/dossier, ...).
app.use("/api", assessorRouter);

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
    else if (admin === "skipped")
      console.warn("ADMIN_EMAIL / ADMIN_PASSWORD not set - no bootstrap administrator created.");
  } catch (err) {
    console.error("Start-up bootstrap failed:", err);
    process.exit(1);
  }

  app.listen(port, () => {
    console.log(`FPT Exam API listening on port ${port}`);
    startJobRunner();
  });
}

start();
