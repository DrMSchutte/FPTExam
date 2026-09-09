import { authenticator } from "otplib";

/** Generates a new TOTP secret for a user enrolling in MFA. */
export function generateMfaSecret(): string {
  return authenticator.generateSecret();
}

/** Builds an otpauth:// URI a user can scan into an authenticator app. */
export function buildMfaOtpAuthUrl(email: string, secret: string): string {
  return authenticator.keyuri(email, "FPT Exam", secret);
}

export function verifyMfaToken(token: string, secret: string): boolean {
  try {
    return authenticator.verify({ token, secret });
  } catch {
    return false;
  }
}

// Build-phase switch. Until the Secret MFA_REQUIRED=yes is set, sign-in is
// password only and the set-up page skips the authenticator step, so nobody is
// locked out while the platform is being built and tested. Set MFA_REQUIRED=yes
// before real sittings: every Administrator, Assessor and Invigilator then needs
// password + 6-digit code, and anyone without an authenticator enrolled gets a
// set-up link from the Administrator.
export const mfaEnforced = () => /^(yes|true|1)$/i.test(process.env.MFA_REQUIRED ?? "");
