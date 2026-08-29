import { authenticator } from "otplib";

/** Generates a new TOTP secret for a user enrolling in MFA. */
export function generateMfaSecret(): string {
  return authenticator.generateSecret();
}

/** Builds an otpauth:// URI a user can scan into an authenticator app. */
export function buildMfaOtpAuthUrl(email: string, secret: string): string {
  return authenticator.keyuri(email, "FPT Exam Centre", secret);
}

export function verifyMfaToken(token: string, secret: string): boolean {
  try {
    return authenticator.verify({ token, secret });
  } catch {
    return false;
  }
}
