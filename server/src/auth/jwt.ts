import jwt from "jsonwebtoken";
import type { UserRole } from "../types.js";

export interface SessionTokenPayload {
  sub: string; // user id
  roles: UserRole[];
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET must be set (see server/.env.example).");
}
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? "8h";

export function issueSessionToken(payload: SessionTokenPayload): string {
  return jwt.sign(payload, JWT_SECRET as string, { expiresIn: JWT_EXPIRES_IN as any });
}

export function verifySessionToken(token: string): SessionTokenPayload {
  return jwt.verify(token, JWT_SECRET as string) as SessionTokenPayload;
}

/**
 * Short-lived token issued after password verification, before MFA is checked.
 * Kept separate from the full session token so a partially-authenticated
 * request can never be mistaken for a real session by other routes.
 */
export function issuePendingMfaToken(userId: string): string {
  return jwt.sign({ sub: userId, stage: "mfa_pending" }, JWT_SECRET as string, {
    expiresIn: "5m",
  });
}

export function verifyPendingMfaToken(token: string): { sub: string } {
  const decoded = jwt.verify(token, JWT_SECRET as string) as any;
  if (decoded.stage !== "mfa_pending") {
    throw new Error("Not a valid pending-MFA token.");
  }
  return { sub: decoded.sub };
}
