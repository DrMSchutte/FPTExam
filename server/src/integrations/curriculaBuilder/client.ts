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

function config(): { baseUrl: string; apiKey: string } | null {
  const baseUrl = process.env.CURRICULA_BUILDER_BASE_URL?.replace(/\/+$/, "");
  const apiKey = process.env.CURRICULA_BUILDER_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

export function isCurriculaBuilderConfigured(): boolean {
  return config() !== null;
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

export async function fetchCurriculaBuilderAssessment(id: string): Promise<CurriculaBuilderAssessment> {
  const body = await call(`/api/exam-export/assessments/${encodeURIComponent(id)}`);
  const parsed = fullSchema.safeParse(body);
  if (!parsed.success) throw new CurriculaBuilderError(`Curricula Builder's assessment did not match the contract: ${parsed.error.message}`);
  return parsed.data;
}
