import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { accountSetupTokens, users } from "../db/schema.js";
import { sendMail, accountSetupEmail, isMailConfigured } from "../email/mailer.js";
import type { UserRole } from "../types.js";

// Set-up links: how a newly registered person gets their sign-in. One-use,
// 48 hours, only the hash stored. The authenticator secret never travels in
// the email - the person sees the QR code on the set-up page itself.

export const SETUP_LINK_HOURS = 48;

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

// The public address links are built on. APP_BASE_URL when it is set to a real
// address; otherwise the address the Administrator's own browser used to reach
// the server (so a Repl works without any extra configuration).
export function appBaseUrl(req?: { protocol: string; get(name: string): string | undefined }): string {
  const env = process.env.APP_BASE_URL?.replace(/\/+$/, "");
  if (env && !/localhost|127\.0\.0\.1/.test(env)) return env;
  if (req) {
    const proto = (req.get("x-forwarded-proto") ?? req.protocol).split(",")[0].trim();
    const host = req.get("x-forwarded-host") ?? req.get("host");
    if (host) return `${proto}://${host}`;
  }
  return env ?? "http://localhost:5173";
}

export function roleWord(roles: UserRole[]): string {
  const names: Record<UserRole, string> = {
    administrator: "an Administrator",
    assessor: "an Assessor",
    invigilator: "an Invigilator",
    learner: "a learner",
  } as Record<UserRole, string>;
  return roles.map((r) => names[r] ?? r).join(" and ");
}

export interface SetupIssue {
  setupUrl: string;
  expiresAt: string;
  emailSent: boolean;
  emailConfigured: boolean;
  emailError?: string;
}

export async function issueSetupLink(p: { userId: string; name: string; email: string; roles: UserRole[]; createdBy: string; baseUrl: string }): Promise<SetupIssue> {
  // One live link per person: older unused ones stop working.
  await db
    .update(accountSetupTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(accountSetupTokens.userId, p.userId), isNull(accountSetupTokens.usedAt)));

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SETUP_LINK_HOURS * 3600 * 1000);
  await db.insert(accountSetupTokens).values({ userId: p.userId, tokenHash: hashToken(token), expiresAt, createdBy: p.createdBy });

  const setupUrl = `${p.baseUrl}/setup/${token}`;
  const needsAuthenticator = !(p.roles.length === 1 && p.roles[0] === "learner");
  const mail = accountSetupEmail({ name: p.name, roleWord: roleWord(p.roles), setupUrl, expiresAt, needsAuthenticator });
  const result = await sendMail({ to: p.email, ...mail });
  return {
    setupUrl,
    expiresAt: expiresAt.toISOString(),
    emailSent: result.sent,
    emailConfigured: isMailConfigured(),
    emailError: result.sent ? undefined : result.reason,
  };
}

// Looks a token up; null when unknown, used or expired.
export async function findLiveSetupToken(token: string) {
  const [row] = await db.select().from(accountSetupTokens).where(eq(accountSetupTokens.tokenHash, hashToken(token)));
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) return null;
  const [user] = await db.select().from(users).where(eq(users.id, row.userId));
  if (!user) return null;
  return { token: row, user };
}

export async function markSetupTokenUsed(id: string) {
  await db.update(accountSetupTokens).set({ usedAt: new Date() }).where(eq(accountSetupTokens.id, id));
}
