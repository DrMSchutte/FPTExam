// Standalone: run pending migrations against DATABASE_URL and exit.
// The server also does this automatically on start-up (see bootstrap.ts), so
// this is only needed when you want to migrate without starting the app.
import "dotenv/config";
import { pool } from "./index.js";
import { runMigrations } from "./bootstrap.js";

runMigrations()
  .then(() => {
    console.log("Migrations applied successfully.");
    return pool.end();
  })
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
