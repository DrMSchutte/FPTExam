import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { verifySessionToken } from "./jwt.js";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import type { UserRole } from "../types.js";

// A suspended or archived account must stop working at once, not when its
// 8-hour session runs out. One indexed lookup per request, cached for a minute
// per user so busy screens (polling) don't hammer the table.
const statusCache = new Map<string, { status: string; at: number }>();
async function accountBlocked(userId: string): Promise<boolean> {
  const hit = statusCache.get(userId);
  if (hit && Date.now() - hit.at < 60_000) return hit.status === "suspended" || hit.status === "archived";
  const [row] = await db.select({ status: users.status }).from(users).where(eq(users.id, userId));
  const status = row?.status ?? "archived";
  statusCache.set(userId, { status, at: Date.now() });
  return status === "suspended" || status === "archived";
}
export const forgetAccountStatus = (userId: string) => statusCache.delete(userId);

export interface AuthedRequest extends Request {
  auth?: { userId: string; roles: UserRole[]; sittingSession?: string };
}

/**
 * Verifies the session JWT (from the `fpt_session` cookie) and attaches the
 * caller's identity/roles to the request. Every route other than /auth/*
 * should sit behind this.
 */
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.fpt_session;
  if (!token) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  let payload;
  try {
    payload = verifySessionToken(token);
  } catch {
    return res.status(401).json({ error: "Session invalid or expired." });
  }
  accountBlocked(payload.sub)
    .then((blocked) => {
      if (blocked) return res.status(403).json({ error: "This account is not active. Contact the FPT Academy Administrator." });
      req.auth = { userId: payload.sub, roles: payload.roles, sittingSession: payload.sittingSession };
      next();
    })
    .catch(next);
}

/**
 * RBAC gate. Pass the roles allowed to call this route. Head QA is treated
 * as read-only oversight, NOT an automatic bypass of every gate - callers
 * that want Head QA to also have access must list it explicitly, so a
 * route that shouldn't be visible to Head QA (there aren't many, but the
 * point is this stays a deliberate decision per-route, not a default).
 */
export function requireRole(...allowed: UserRole[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const roles = req.auth?.roles ?? [];
    const ok = roles.some((r) => allowed.includes(r));
    if (!ok) {
      return res.status(403).json({
        error: "Forbidden.",
        detail: `Requires one of: ${allowed.join(", ")}.`,
      });
    }
    next();
  };
}
