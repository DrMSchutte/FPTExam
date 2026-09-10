import { z } from "zod";

// Block 6: FPT Exam <-> FPTStaff. FPTStaff is the system of record for people
// and for what happens after a result (moderation, verification,
// certification). FPT Exam pulls learners by section and staff from it, pushes
// people added here so FPTStaff has them too, and pushes every signed-off
// result with its Statement of Results. The contract FPTStaff exposes is in
// docs/fptstaff-contract.md; this file is its client.
//
// Configuration (Replit Secrets):
//   FPTSTAFF_BASE_URL   e.g. https://fptstaff.fptacademy.co.za
//   FPTSTAFF_API_KEY    bearer token issued by FPTStaff for FPT Exam
//   FPTSTAFF_MOCK=yes   stand-in: FPT Exam serves a sample of the contract itself

export class FptstaffError extends Error {}

export const sectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  qualificationTitle: z.string().nullable().optional(),
  saqaQualificationId: z.string().nullable().optional(),
  site: z.string().nullable().optional(),
  intake: z.string().nullable().optional(),
  learnerCount: z.number().int().nonnegative().optional(),
  status: z.enum(["active", "closed"]).optional(),
});
export const learnerSchema = z.object({
  fptstaffId: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  idNumber: z.string().regex(/^\d{13}$/).nullable(),
  studentNumber: z.string().nullable().optional(),
  sectionId: z.string().nullable().optional(),
  status: z.enum(["active", "inactive"]).optional(),
  updatedAt: z.string().optional(),
});
export const staffSchema = z.object({
  fptstaffId: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  roles: z.array(z.enum(["assessor", "invigilator"])).min(1),
  employmentRelationship: z.enum(["internal", "external"]).nullable().optional(),
  registrationNumber: z.string().nullable().optional(),
  status: z.enum(["active", "inactive"]).optional(),
});
export type FptstaffSection = z.infer<typeof sectionSchema>;
export type FptstaffLearner = z.infer<typeof learnerSchema>;
export type FptstaffStaff = z.infer<typeof staffSchema>;

export const isSampleMode = () => /^(yes|true|1)$/i.test(process.env.FPTSTAFF_MOCK ?? "");

function config(): { baseUrl: string; apiKey: string; sample: boolean } | null {
  if (isSampleMode()) return { baseUrl: `http://127.0.0.1:${process.env.PORT ?? 4000}`, apiKey: process.env.FPTSTAFF_API_KEY || "sample", sample: true };
  const baseUrl = process.env.FPTSTAFF_BASE_URL?.replace(/\/+$/, "");
  const apiKey = process.env.FPTSTAFF_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey, sample: false };
}

export const isFptstaffConfigured = () => config() !== null;

export function fptstaffConnection(): { connected: boolean; sample: boolean; host: string | null } {
  const cfg = config();
  if (!cfg) return { connected: false, sample: false, host: null };
  let host: string | null = null;
  try { host = cfg.sample ? "sample FPTStaff on this server" : new URL(cfg.baseUrl).host; } catch { host = cfg.baseUrl; }
  return { connected: true, sample: cfg.sample, host };
}

async function call<T>(method: "GET" | "POST", pathname: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  const cfg = config();
  if (!cfg) throw new FptstaffError("FPTStaff is not connected. Set FPTSTAFF_BASE_URL and FPTSTAFF_API_KEY.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    throw new FptstaffError(`Could not reach FPTStaff: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) throw new FptstaffError(`FPTStaff refused the key (${res.status}).`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new FptstaffError(`FPTStaff answered ${res.status} for ${pathname}${text ? `: ${text.slice(0, 200)}` : "."}`);
  }
  const json = await res.json().catch(() => null);
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new FptstaffError(`FPTStaff's answer to ${pathname} did not match the contract: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

export const listSections = () => call("GET", "/api/exam-sync/sections", z.object({ sections: z.array(sectionSchema) })).then((r) => r.sections);

export async function listLearners(sectionId: string): Promise<FptstaffLearner[]> {
  const out: FptstaffLearner[] = [];
  for (let page = 1; page <= 200; page++) {
    const r = await call("GET", `/api/exam-sync/learners?section=${encodeURIComponent(sectionId)}&page=${page}&pageSize=500`, z.object({ learners: z.array(learnerSchema), nextPage: z.number().int().nullable().optional() }));
    out.push(...r.learners);
    if (!r.nextPage) break;
  }
  return out;
}

export const listStaff = () => call("GET", "/api/exam-sync/staff", z.object({ staff: z.array(staffSchema) })).then((r) => r.staff);

// A person registered on FPT Exam is pushed across; FPTStaff matches on ID
// number (learners) or email and answers with its own id.
export const pushLearner = (p: { examRef: string; name: string; email: string; idNumber: string | null; studentNumber: string | null }) =>
  call("POST", "/api/exam-sync/learners", z.object({ fptstaffId: z.string().min(1), outcome: z.enum(["created", "matched", "updated"]) }), p);

export interface ResultPush {
  examRef: string;
  learner: { fptstaffId: string | null; name: string; email: string; idNumber: string | null; studentNumber: string | null };
  qualification: { title: string; type: string; saqaQualificationId: string | null };
  paper: { version: string; source: string; externalRef: string | null };
  sitting: { id: string; startTime: string; venue: string | null };
  result: { outcome: string; totalMark: number; totalMax: number; percentage: number; signedOffAt: string; assessor: { name: string; fptstaffId: string | null } };
  integrity: { recommendation: string; headline: string } | null;
  statement: { number: string; filename: string; pdfBase64: string };
}
export const pushResult = (p: ResultPush) => call("POST", "/api/exam-sync/results", z.object({ received: z.literal(true), fptstaffResultId: z.string().min(1), duplicate: z.boolean().optional() }), p);

export interface ProbeResult { ok: boolean; step: "reach" | "auth" | "contract" | "done"; message: string; sections?: number; staff?: number; ms: number }
export async function probeFptstaff(): Promise<ProbeResult> {
  const t0 = Date.now();
  const cfg = config();
  if (!cfg) return { ok: false, step: "reach", message: "Not connected: FPTSTAFF_BASE_URL and FPTSTAFF_API_KEY are not set.", ms: 0 };
  try {
    const sections = await listSections();
    let staff = 0;
    try { staff = (await listStaff()).length; } catch { /* sections alone prove the connection */ }
    return { ok: true, step: "done", message: cfg.sample ? "Sample FPTStaff answering on this server." : `Connected to ${new URL(cfg.baseUrl).host}.`, sections: sections.length, staff, ms: Date.now() - t0 };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    const step: ProbeResult["step"] = /refused the key/.test(m) ? "auth" : /did not match the contract/.test(m) ? "contract" : "reach";
    return { ok: false, step, message: m, ms: Date.now() - t0 };
  }
}
