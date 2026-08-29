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

const ROLE_VALUES = [
  "administrator",
  "learner",
  "invigilator",
  "assessor",
  "moderator",
  "head_qa",
] as const;

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(10, "Password must be at least 10 characters."),
  roles: z.array(z.enum(ROLE_VALUES)).min(1),
  employmentRelationship: z.enum(["internal", "external"]).optional(),
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
    const { name, email, password, roles, employmentRelationship } = parsed.data;

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

usersRouter.get("/", requireAuth, requireRole("administrator", "head_qa"), async (_req, res) => {
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
    createdAt: u.createdAt.toISOString(),
  });
});
