// One-shot fix for a specific bootstrap problem: db:seed only creates the
// administrator account if none exists yet (see seed.ts), so if the account
// was created earlier from a since-changed ADMIN_PASSWORD secret, no amount
// of updating the secret afterward changes the actual stored password - the
// row already exists, so seed silently does nothing. Run this once to force
// the existing administrator's password to match the current ADMIN_PASSWORD
// secret (creates the account instead, if somehow none exists yet).
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
    throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must be set.");
  }

  const passwordHash = await hashPassword(password);
  const [existing] = await db.select().from(users).where(eq(users.email, email));

  if (existing) {
    await db.update(users).set({ passwordHash }).where(eq(users.id, existing.id));
    console.log(`Password reset for ${email} to match the current ADMIN_PASSWORD secret.`);
  } else {
    const [created] = await db.insert(users).values({ name, email, passwordHash }).returning();
    await db.insert(userRoles).values({ userId: created.id, role: "administrator" });
    console.log(`Administrator ${email} did not exist - created fresh.`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Reset failed:", err);
  process.exit(1);
});
