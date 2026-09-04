import { Router } from "express";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, userRoles } from "../db/schema.js";
import { verifyPassword } from "../auth/password.js";
import { verifyMfaToken } from "../auth/mfa.js";
import { issueSessionToken, issuePendingMfaToken, verifyPendingMfaToken } from "../auth/jwt.js";
import type { UserRole } from "../types.js";

export const authRouter = Router();

const COOKIE_NAME = "fpt_session";
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  maxAge: 8 * 60 * 60 * 1000,
};

async function loadUserWithRoles(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return null;
  const roleRows = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, userId));
  return { user, roles: roleRows.map((r) => r.role) as UserRole[] };
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body." });
  }
  const { email, password } = parsed.data;

  const [row] = await db.select().from(users).where(eq(users.email, email));
  if (!row) {
    // Same error as a bad password - don't reveal whether the email exists.
    return res.status(401).json({ error: "Invalid email or password." });
  }

  const ok = await verifyPassword(password, row.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  if (row.mfaSecret) {
    const pendingToken = issuePendingMfaToken(row.id);
    return res.json({ mfaRequired: true, pendingToken });
  }

  // No MFA configured yet (e.g. brand-new bootstrap admin on first run) -
  // every non-Learner role should enrol in MFA immediately after this.
  const loaded = await loadUserWithRoles(row.id);
  const sessionToken = issueSessionToken({ sub: row.id, roles: loaded!.roles });
  res.cookie(COOKIE_NAME, sessionToken, COOKIE_OPTS);
  return res.json({
    mfaRequired: false,
    user: publicUser(loaded!.user, loaded!.roles),
  });
});

const mfaVerifySchema = z.object({
  pendingToken: z.string(),
  token: z.string().length(6),
});

authRouter.post("/mfa/verify", async (req, res) => {
  const parsed = mfaVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body." });
  }
  let userId: string;
  try {
    ({ sub: userId } = verifyPendingMfaToken(parsed.data.pendingToken));
  } catch {
    return res.status(401).json({ error: "MFA session expired, please log in again." });
  }

  const loaded = await loadUserWithRoles(userId);
  if (!loaded || !loaded.user.mfaSecret) {
    return res.status(401).json({ error: "MFA is not configured for this account." });
  }

  const valid = verifyMfaToken(parsed.data.token, loaded.user.mfaSecret);
  if (!valid) {
    return res.status(401).json({ error: "Incorrect MFA code." });
  }

  const sessionToken = issueSessionToken({ sub: userId, roles: loaded.roles });
  res.cookie(COOKIE_NAME, sessionToken, COOKIE_OPTS);
  return res.json({ mfaRequired: false, user: publicUser(loaded.user, loaded.roles) });
});

authRouter.post("/logout", async (_req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

function publicUser(user: typeof users.$inferSelect, roles: UserRole[]) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roles,
    employmentRelationship: user.employmentRelationship,
    source: user.source,
    fptstaffId: user.fptstaffId,
    createdAt: user.createdAt.toISOString(),
  };
}
