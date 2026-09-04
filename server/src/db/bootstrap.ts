// Start-up bootstrap: bring the database to the current schema and make sure
// a bootstrap Administrator exists. Both steps are idempotent, so running them
// on every server start is safe - and it means a fresh Replit import needs
// nothing beyond its secrets: no Shell commands, no "did I run migrate?".
//
// Also used by the standalone `db:migrate` and `db:seed` scripts so there is
// exactly one implementation of each step.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./index.js";
import { users, userRoles } from "./schema.js";
import { hashPassword } from "../auth/password.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolves to server/drizzle whether we run from src/ (tsx) or dist/ (node).
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../../drizzle");

export async function runMigrations(): Promise<void> {
  await pool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

export type BootstrapAdminResult = "created" | "exists" | "skipped";

// Creates the Administrator named by ADMIN_EMAIL / ADMIN_PASSWORD if that
// account doesn't exist yet. Never updates an existing account's password -
// that's `db:reset-admin-password`'s job, deliberately separate so a routine
// restart can't silently change a live credential.
export async function ensureBootstrapAdmin(): Promise<BootstrapAdminResult> {
  const name = process.env.ADMIN_NAME ?? "FPT Academy Admin";
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return "skipped";

  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) return "exists";

  const passwordHash = await hashPassword(password);
  const [created] = await db.insert(users).values({ name, email, passwordHash }).returning();
  await db.insert(userRoles).values({ userId: created.id, role: "administrator" });
  return "created";
}
