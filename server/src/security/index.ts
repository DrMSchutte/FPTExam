import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import helmet from "helmet";
import type { Express, Request } from "express";

// Block 8a: the lock-down. Three things:
//
//  1. Rate limits where guessing would pay: signing in, verifying an
//     authenticator code, and entering a sitting with a code. Generous enough
//     that a whole room typing at once is never affected, tight enough that a
//     script cannot work through a keyspace.
//  2. Security headers, including the one that matters most here: cameras and
//     screen capture are allowed for this origin (the exam room needs them)
//     and for nobody it embeds.
//  3. The exam room is never framed by another site, and nothing it loads
//     comes from anywhere but this origin.
//
// Behind Replit's proxy the client address arrives in X-Forwarded-For, so the
// app trusts one proxy hop - without that every learner would look like the
// same address and one room would exhaust the other's limit.

const isProd = () => process.env.NODE_ENV === "production";
// Tests drive the API as fast as they can; a limit that refuses them would
// only be measuring itself. Off unless NODE_ENV=production, or forced on.
const limitsOn = () => isProd() || /^(yes|true|1|on)$/i.test(process.env.RATE_LIMITS ?? "");

// One key per address, IPv6-safe (an IPv6 client gets a /56 bucket, so a
// single machine cannot rotate through addresses it already owns).
const byAddress = (req: Request) => ipKeyGenerator(req.ip ?? "unknown");
// Sign-in attempts are counted per address AND per email, so one person
// hammering one account cannot lock out a whole venue, and a spread attack on
// many accounts from one address is still stopped.
const byAddressAndEmail = (req: Request) => `${byAddress(req)}|${String((req.body as { email?: string })?.email ?? "").toLowerCase().slice(0, 120)}`;

const message = (what: string) => ({ error: `Too many ${what}. Wait a minute and try again.` });

export const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: limitsOn() ? 20 : 0, // 0 = no limit
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: byAddressAndEmail,
  skipSuccessfulRequests: true, // only wrong guesses count
  message: message("sign-in attempts for this account"),
});

export const mfaLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: limitsOn() ? 12 : 0,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: byAddress,
  skipSuccessfulRequests: true,
  message: message("authenticator codes"),
});

// A room of thirty learners typing a twelve-character code, some of them
// twice: this has to be roomy. It is here to stop a script trying codes, not
// to police typing.
export const sittingEntryLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: limitsOn() ? 60 : 0,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: byAddress,
  skipSuccessfulRequests: true,
  message: message("attempts to enter with a sitting code"),
});

// Account set-up and password reset links: the token is long and random, but a
// limit keeps anyone from walking the space.
export const setupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: limitsOn() ? 30 : 0,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: byAddress,
  message: message("attempts to use a set-up link"),
});

// Everything else, as a backstop against a runaway client.
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: limitsOn() ? 600 : 0,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: byAddress,
  message: message("requests"),
});

export function applySecurity(app: Express) {
  // Replit terminates TLS in front of the app; one hop is trusted so rate
  // limits and audit entries see the real client address.
  app.set("trust proxy", 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // The client is built by Vite into plain files served from here.
          scriptSrc: ["'self'"],
          // Tailwind's built stylesheet plus the few inline styles React sets
          // for progress bars and video sizing.
          styleSrc: ["'self'", "'unsafe-inline'"],
          // Identity photos and stills are served as data from this origin;
          // captures are taken from the camera as blobs before upload.
          imgSrc: ["'self'", "data:", "blob:"],
          mediaSrc: ["'self'", "blob:"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", "data:"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"], // the exam room is never framed
          baseUri: ["'self'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: isProd() ? [] : null,
        },
      },
      // The exam room opens the camera and shares the screen; both are needed
      // on this origin. Helmet does not set this one, so it is added below.
      crossOriginEmbedderPolicy: false,
      // Recording playback and stills are fetched by the page itself.
      crossOriginResourcePolicy: { policy: "same-origin" },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      hsts: isProd() ? { maxAge: 15552000, includeSubDomains: true } : false,
      // Match the CSP: never framed, by anyone, including this origin.
      frameguard: { action: "deny" },
    })
  );

  app.use((_req, res, next) => {
    // Camera, microphone and screen capture: this origin only, never anything
    // it embeds. Everything else off.
    res.setHeader("Permissions-Policy", [
      "camera=(self)",
      "microphone=(self)",
      "display-capture=(self)",
      "geolocation=()",
      "payment=()",
      "usb=()",
      "serial=()",
      "bluetooth=()",
      "midi=()",
      "idle-detection=()",
    ].join(", "));
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });
}

export const rateLimitsEnabled = limitsOn;
