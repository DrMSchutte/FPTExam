import { z } from "zod";

// Curricula Builder → FPT Exam: the only way a QCTO FISA/EISA paper (and any CPD /
// other course built on Curricula Builder) enters FPT Exam. FPT Exam pulls; nothing
// is authored here. The contract Curricula Builder must expose is written up in
// docs/curricula-builder-contract.md - this file is its client.
//
// Configuration (Replit Secrets):
//   CURRICULA_BUILDER_BASE_URL   e.g. https://curriculabuilder.fptacademy.co.za
//   CURRICULA_BUILDER_API_KEY    bearer token issued by Curricula Builder for FPT Exam
// Until both are set, isCurriculaBuilderConfigured() is false and the two Curricula
// Builder routes show "not connected yet" - by design no QCTO paper can enter before then.

export class CurriculaBuilderError extends Error {}

export type CurriculaBuilderKind = "qcto" | "other";

const summarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  qualificationTitle: z.string().min(1),
  kind: z.enum(["qcto", "other"]),
  qctoRegistrationType: z.enum(["fisa", "eisa"]).nullable().optional(),
  saqaQualificationId: z.string().nullable().optional(),
  nqfLevel: z.number().int().min(1).max(10).nullable().optional(),
  version: z.string().min(1),
  updatedAt: z.string().optional(),
});

const questionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["mcq", "short_answer", "long_answer", "practical_upload"]),
  prompt: z.string().min(1),
  maxMark: z.number().nonnegative(),
  options: z.array(z.string()).optional(),
  modelAnswerOrRubric: z.string().optional(),
  eloRef: z.string().optional(),
  acRef: z.string().optional(),
  bloomLevel: z.enum(["remember", "understand", "apply", "analyse", "evaluate", "create"]).optional(),
});

const fullSchema = summarySchema.extend({
  timeAllocationMinutes: z.number().int().positive(),
  permittedMaterials: z.array(z.string()).default([]),
  passMarkOrCompetencyRule: z.string().nullable().optional(),
  exitLevelOutcomes: z.array(z.string()).default([]),
  assessmentCriteria: z.array(z.string()).default([]),
  questions: z.array(questionSchema).min(1),
});

export type CurriculaBuilderSummary = z.infer<typeof summarySchema>;
export type CurriculaBuilderAssessment = z.infer<typeof fullSchema>;

// Block 7: with CURRICULA_BUILDER_MOCK=yes the sample export FPT Exam serves
// itself stands in for Curricula Builder (sampleExport.ts), so the whole route
// can be exercised before the real export exists.
export const isSampleMode = () => /^(yes|true|1)$/i.test(process.env.CURRICULA_BUILDER_MOCK ?? "");

function config(): { baseUrl: string; apiKey: string; sample: boolean } | null {
  if (isSampleMode()) return { baseUrl: `http://127.0.0.1:${process.env.PORT ?? 4000}`, apiKey: process.env.CURRICULA_BUILDER_API_KEY || "sample", sample: true };
  const baseUrl = process.env.CURRICULA_BUILDER_BASE_URL?.replace(/\/+$/, "");
  const apiKey = process.env.CURRICULA_BUILDER_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey, sample: false };
}

export function isCurriculaBuilderConfigured(): boolean {
  return config() !== null;
}

// What the Administrator sees about the connection (never the key).
export function curriculaBuilderConnection(): { connected: boolean; sample: boolean; host: string | null } {
  const cfg = config();
  if (!cfg) return { connected: false, sample: false, host: null };
  let host: string | null = null;
  try { host = cfg.sample ? "sample export on this server" : new URL(cfg.baseUrl).host; } catch { host = cfg.baseUrl; }
  return { connected: true, sample: cfg.sample, host };
}

// A live test of the connection: reachable, key accepted, list matches the contract.
export interface ProbeResult { ok: boolean; step: "reach" | "auth" | "contract" | "done"; message: string; qcto?: number; other?: number; ms: number }
export async function probeCurriculaBuilder(): Promise<ProbeResult> {
  const t0 = Date.now();
  const cfg = config();
  if (!cfg) return { ok: false, step: "reach", message: "Not connected: CURRICULA_BUILDER_BASE_URL and CURRICULA_BUILDER_API_KEY are not set.", ms: 0 };
  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    res = await fetch(`${cfg.baseUrl}/api/exam-export/assessments?kind=qcto`, { headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: "application/json" }, signal: controller.signal });
    clearTimeout(timer);
  } catch (err) {
    return { ok: false, step: "reach", message: `Could not reach ${cfg.sample ? "the sample export" : cfg.baseUrl}: ${err instanceof Error ? err.message : String(err)}. Check CURRICULA_BUILDER_BASE_URL and that Curricula Builder is running.`, ms: Date.now() - t0 };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, step: "auth", message: `Curricula Builder refused the key (${res.status}). Check CURRICULA_BUILDER_API_KEY matches the key issued to FPT Exam.`, ms: Date.now() - t0 };
  if (!res.ok) return { ok: false, step: "reach", message: `Curricula Builder answered ${res.status} for /api/exam-export/assessments. The export is not exposed at that address yet.`, ms: Date.now() - t0 };
  const body = await res.json().catch(() => null);
  const parsed = z.object({ assessments: z.array(summarySchema) }).safeParse(body);
  if (!parsed.success) return { ok: false, step: "contract", message: `Reached and authorised, but the list does not match the contract: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}.`, ms: Date.now() - t0 };
  let other = 0;
  try { other = (await listCurriculaBuilderAssessments("other")).length; } catch { /* the qcto list is enough to call it connected */ }
  return { ok: true, step: "done", message: cfg.sample ? "Sample export answering on this server." : `Connected to ${new URL(cfg.baseUrl).host}.`, qcto: parsed.data.assessments.length, other, ms: Date.now() - t0 };
}

async function call(pathname: string): Promise<unknown> {
  const cfg = config();
  if (!cfg) throw new CurriculaBuilderError("Curricula Builder is not connected. Set CURRICULA_BUILDER_BASE_URL and CURRICULA_BUILDER_API_KEY.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}${pathname}`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    throw new CurriculaBuilderError(`Could not reach Curricula Builder: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new CurriculaBuilderError(`Curricula Builder answered ${res.status} for ${pathname}.`);
  return res.json();
}

export async function listCurriculaBuilderAssessments(kind: CurriculaBuilderKind): Promise<CurriculaBuilderSummary[]> {
  const body = await call(`/api/exam-export/assessments?kind=${kind}`);
  const parsed = z.object({ assessments: z.array(summarySchema) }).safeParse(body);
  if (!parsed.success) throw new CurriculaBuilderError(`Curricula Builder's assessment list did not match the contract: ${parsed.error.message}`);
  return parsed.data.assessments;
}

export async function fetchCurriculaBuilderAssessment(id: string, version?: string): Promise<CurriculaBuilderAssessment> {
  const body = await call(`/api/exam-export/assessments/${encodeURIComponent(id)}${version ? `?version=${encodeURIComponent(version)}` : ""}`);
  const parsed = fullSchema.safeParse(body);
  if (!parsed.success) throw new CurriculaBuilderError(`Curricula Builder's assessment did not match the contract: ${parsed.error.message}`);
  return parsed.data;
}
