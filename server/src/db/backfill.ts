import { and, isNotNull, isNull, eq } from "drizzle-orm";
import { db } from "./index.js";
import { users } from "./schema.js";
import { decryptField, hashIdentifier } from "../auth/crypto.js";

// Block 2 made the ID number the unique student identifier, matched through
// id_number_hash. People registered before that have the encrypted number but
// no hash; this fills it in once at start-up. A duplicate ID number among
// existing people is logged, not fatal - the Administrator sorts it out on the
// People page.
export async function backfillIdNumberHashes(): Promise<number> {
  const rows = await db
    .select({ id: users.id, enc: users.idNumberEnc })
    .from(users)
    .where(and(isNotNull(users.idNumberEnc), isNull(users.idNumberHash)))
    .limit(50000);
  let done = 0;
  for (const r of rows) {
    if (!r.enc) continue;
    try {
      const hash = hashIdentifier(decryptField(r.enc));
      await db.update(users).set({ idNumberHash: hash }).where(eq(users.id, r.id));
      done++;
    } catch (err) {
      console.warn(`ID-number index skipped for user ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return done;
}
