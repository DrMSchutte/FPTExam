import type { Request, Response, NextFunction } from "express";
import { verifySessionToken } from "./jwt.js";
import type { UserRole } from "../types.js";

export interface AuthedRequest extends Request {
  auth?: { userId: string; roles: UserRole[] };
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
  try {
    const payload = verifySessionToken(token);
    req.auth = { userId: payload.sub, roles: payload.roles };
    next();
  } catch {
    return res.status(401).json({ error: "Session invalid or expired." });
  }
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
