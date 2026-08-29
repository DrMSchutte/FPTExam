// Runs pending migrations from ./drizzle against DATABASE_URL.
// Also ensures the pgcrypto extension is present, since the schema relies on
// gen_random_uuid() for primary keys.
import "dotenv/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./index.js";

async function main() {
  await pool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied successfully.");
  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
