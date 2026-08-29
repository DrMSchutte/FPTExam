// Creates the first Administrator account if one doesn't exist yet.
// There is no public sign-up in this system (Section 3 of the spec), so this
// script is the one deliberate bootstrap exception - run it once after the
// first migration.
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db, pool } from "./index.js";
import { users, userRoles } from "./schema.js";
import { hashPassword } from "../auth/password.js";

async function main() {
  const name = process.env.ADMIN_NAME ?? "FPT Academy Admin";
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must be set (see server/.env.example).");
  }

  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) {
    console.log(`Administrator ${email} already exists - nothing to do.`);
    await pool.end();
    return;
  }

  const passwordHash = await hashPassword(password);
  const [created] = await db
    .insert(users)
    .values({ name, email, passwordHash })
    .returning();

  await db.insert(userRoles).values({ userId: created.id, role: "administrator" });

  console.log(`Bootstrap administrator created: ${email}`);
  console.log(
    "No MFA secret was generated for this bootstrap account so the first login can succeed " +
      "without a prior enrolment step. Add an MFA-enrolment endpoint before go-live and " +
      "enrol this account immediately after first login."
  );
  await pool.end();
}

main().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
