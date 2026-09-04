// Standalone: create the bootstrap Administrator (from ADMIN_EMAIL /
// ADMIN_PASSWORD) if none exists yet, then exit. The server also does this
// automatically on start-up (see bootstrap.ts). There is no public sign-up in
// this system, so this is the one deliberate bootstrap exception.
//
// If the account already exists this does nothing - to change its password
// use `npm run db:reset-admin-password`.
import "dotenv/config";
import { pool } from "./index.js";
import { ensureBootstrapAdmin } from "./bootstrap.js";

ensureBootstrapAdmin()
  .then((result) => {
    const email = process.env.ADMIN_EMAIL;
    if (result === "skipped") {
      throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must be set (see server/.env.example).");
    }
    console.log(
      result === "created"
        ? `Bootstrap administrator created: ${email}`
        : `Administrator ${email} already exists - nothing to do.`
    );
    return pool.end();
  })
  .catch((err) => {
    console.error("Seeding failed:", err);
    process.exit(1);
  });
