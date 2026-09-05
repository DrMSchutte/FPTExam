import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, userRoles, auditLog } from "../db/schema.js";
import { hashPassword } from "../auth/password.js";
import { generateMfaSecret, buildMfaOtpAuthUrl } from "../auth/mfa.js";
import { requireAuth, requireRole, type AuthedRequest } from "../auth/middleware.js";
import type { UserRole } from "../types.js";

export const usersRouter = Router();

// The four roles FPT Exam actually has. Moderation and QA live in the separate
// FPTStaff application, so "moderator" / "head_qa" are no longer assignable
// here (the DB enum still lists them - dropping enum values in Postgres is
// destructive for no benefit, so they are simply never offered).
const ROLE_VALUES = ["administrator", "learner", "invigilator", "assessor"] as const;

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(10, "Password must be at least 10 characters."),
  roles: z.array(z.enum(ROLE_VALUES)).min(1),
  employmentRelationship: z.enum(["internal", "external"]).optional(),
  // FPTStaff hooks. Until FPTStaff is connected every registration is
  // "manual"; once it is, a person picked from the FPTStaff dropdown arrives
  // with source = "fptstaff" and their FPTStaff ID.
  source: z.enum(["manual", "fptstaff"]).optional(),
  fptstaffId: z.string().min(1).optional(),
});

// Only an Administrator can create accounts - there is no public sign-up,
// per the platform's role model (Section 3 of the spec).
usersRouter.post(
  "/",
  requireAuth,
  requireRole("administrator"),
  async (req: AuthedRequest, res) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body.", detail: parsed.error.message });
    }
    const { name, email, password, roles, employmentRelationship, source, fptstaffId } = parsed.data;

    const [existing] = await db.select().from(users).where(eq(users.email, email));
    if (existing) {
      return res.status(409).json({ error: "A user with that email already exists." });
    }

    // Enforce role independence: an Invigilator on a given exam cannot also
    // be its Assessor. At the account level we only block the most common
    // mistake - one account holding both roles at all - which is the safe
    // default; per-sitting assignment still needs its own check (Phase 3).
    if (roles.includes("invigilator") && roles.includes("assessor")) {
      return res.status(400).json({
        error: "An account cannot be both Invigilator and Assessor.",
        detail: "QCTO/AQP practice requires invigilation to be independent of marking.",
      });
    }

    const passwordHash = await hashPassword(password);
    const mfaSecret = roles.includes("learner") && roles.length === 1 ? null : generateMfaSecret();

    const [created] = await db
      .insert(users)
      .values({
        name,
        email,
        passwordHash,
        mfaSecret,
        employmentRelationship: employmentRelationship ?? null,
        source: source ?? "manual",
        fptstaffId: fptstaffId ?? null,
      })
      .returning();

    await db.insert(userRoles).values(roles.map((role: UserRole) => ({ userId: created.id, role })));

    await db.insert(auditLog).values({
      actorId: req.auth!.userId,
      action: "user_created",
      targetType: "user",
      targetId: created.id,
    });

    return res.status(201).json({
      id: created.id,
      name: created.name,
      email: created.email,
      roles,
      mfaOtpAuthUrl: mfaSecret ? buildMfaOtpAuthUrl(email, mfaSecret) : null,
    });
  }
);

usersRouter.get("/", requireAuth, requireRole("administrator"), async (_req, res) => {
  const rows = await db.select().from(users);
  const roleRows = await db.select().from(userRoles);
  const rolesByUser = new Map<string, UserRole[]>();
  for (const r of roleRows) {
    const list = rolesByUser.get(r.userId) ?? [];
    list.push(r.role as UserRole);
    rolesByUser.set(r.userId, list);
  }

  return res.json(
    rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      roles: rolesByUser.get(u.id) ?? [],
      employmentRelationship: u.employmentRelationship,
      source: u.source,
      fptstaffId: u.fptstaffId,
      createdAt: u.createdAt.toISOString(),
    }))
  );
});

usersRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const [u] = await db.select().from(users).where(eq(users.id, req.auth!.userId));
  if (!u) return res.status(404).json({ error: "User not found." });
  return res.json({
    id: u.id,
    name: u.name,
    email: u.email,
    roles: req.auth!.roles,
    employmentRelationship: u.employmentRelationship,
    source: u.source,
    fptstaffId: u.fptstaffId,
    createdAt: u.createdAt.toISOString(),
  });
});

// Authenticator (MFA) setup for a supervisory account. Every Administrator,
// Assessor and Invigilator signs in with password + 6-digit code; the secret
// is minted when the account is created, but the person still has to scan it
// into their authenticator app. This lets the Administrator (re)issue that
// setup - e.g. when the QR wasn't captured at creation, or the person changed
// phones. Issuing a new secret invalidates the old one, so it is audited.
usersRouter.post(
  "/:id/mfa/reset",
  requireAuth,
  requireRole("administrator"),
  async (req: AuthedRequest, res) => {
    const [user] = await db.select().from(users).where(eq(users.id, req.params.id));
    if (!user) return res.status(404).json({ error: "User not found." });
    const roles = (await db.select().from(userRoles).where(eq(userRoles.userId, user.id))).map((r) => r.role);
    if (roles.length === 1 && roles[0] === "learner") {
      return res.status(400).json({ error: "Learners sign in with a password only - no authenticator to set up." });
    }
    const secret = generateMfaSecret();
    await db.update(users).set({ mfaSecret: secret }).where(eq(users.id, user.id));
    await db.insert(auditLog).values({
      actorId: req.auth!.userId,
      action: "user_mfa_reset",
      targetType: "user",
      targetId: user.id,
    });
    return res.json({ id: user.id, email: user.email, mfaOtpAuthUrl: buildMfaOtpAuthUrl(user.email, secret) });
  }
);
