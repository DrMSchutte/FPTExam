import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/fpt_exam_centre";

export const pool = new pg.Pool({ connectionString });

export const db = drizzle(pool, { schema });
