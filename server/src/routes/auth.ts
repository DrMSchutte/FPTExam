import { Router } from "express";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, userRoles, auditLog } from "../db/schema.js";
import { verifyPassword, hashPassword } from "../auth/password.js";
import { verifyMfaToken, buildMfaOtpAuthUrl, mfaEnforced } from "../auth/mfa.js";
import { findLiveSetupToken, markSetupTokenUsed } from "../auth/setupLinks.js";
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
  if (row.status === "suspended" || row.status === "archived") {
    return res.status(403).json({ error: "This account is not active. Contact the FPT Academy Administrator." });
  }
  if (row.status === "invited") {
    await db.update(users).set({ status: "active", activatedAt: row.activatedAt ?? new Date() }).where(eq(users.id, row.id));
  }

  if (row.mfaSecret && mfaEnforced()) {
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

// ---- Account set-up via a one-use link (no sign-in yet) -----------------------

// What the set-up page needs to show: who this is for, and the authenticator QR
// for supervisory roles. The token in the URL is the only credential here.
authRouter.get("/setup/:token", async (req, res) => {
  const live = await findLiveSetupToken(req.params.token);
  if (!live || live.user.status === "suspended" || live.user.status === "archived") return res.status(404).json({ error: "This set-up link is not valid any more.", detail: "It may have been used already or expired. Ask the Administrator to send a new one." });
  const roleRows = await db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, live.user.id));
  return res.json({
    name: live.user.name,
    email: live.user.email,
    roles: roleRows.map((r) => r.role),
    mfaOtpAuthUrl: live.user.mfaSecret && mfaEnforced() ? buildMfaOtpAuthUrl(live.user.email, live.user.mfaSecret) : null,
    expiresAt: live.token.expiresAt.toISOString(),
  });
});

const setupSchema = z.object({
  password: z.string().min(10, "Password must be at least 10 characters."),
  mfaCode: z.string().regex(/^\d{6}$/).optional(),
});

// Completes set-up: the person's own password, and for supervisory roles a
// first code from the authenticator to prove it is enrolled correctly.
authRouter.post("/setup/:token", async (req, res) => {
  const parsed = setupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.issues.map((i) => i.message).join(" ") });
  const live = await findLiveSetupToken(req.params.token);
  if (!live || live.user.status === "suspended" || live.user.status === "archived") return res.status(404).json({ error: "This set-up link is not valid any more.", detail: "Ask the Administrator to send a new one." });
  if (live.user.mfaSecret && mfaEnforced()) {
    if (!parsed.data.mfaCode) return res.status(400).json({ error: "Enter the 6-digit code from your authenticator app to confirm it is set up." });
    if (!verifyMfaToken(parsed.data.mfaCode, live.user.mfaSecret)) return res.status(400).json({ error: "That code is not right. Check the app shows FPT Exam and try the current code." });
  }
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(parsed.data.password), status: live.user.status === "invited" ? "active" : live.user.status, activatedAt: live.user.activatedAt ?? new Date() })
    .where(eq(users.id, live.user.id));
  await markSetupTokenUsed(live.token.id);
  await db.insert(auditLog).values({ actorId: live.user.id, action: "account_setup_completed", targetType: "user", targetId: live.user.id });
  return res.json({ ok: true, email: live.user.email });
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
