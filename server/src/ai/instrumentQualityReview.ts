import Anthropic from "@anthropic-ai/sdk";
import type {
  Question,
  BloomLevel,
  InstrumentProfile,
  InstrumentQualityReview,
  CoverageEntry,
  QuestionAlignmentIssue,
  StandardVerdict,
} from "../types.js";
import { BLOOM_LEVELS } from "../types.js";
import { expectedHigherOrderShare, HIGHER_ORDER } from "./bloom.js";

// Assessment Standard Check (build brief §5.10).
//
// Answers the Administrator's question "does this paper meet the full
// requirement of the assessment standard?" in two layers:
//
//  1. profileInstrument() - facts computed from the paper itself, no AI:
//     marks and counts by Bloom's level, by question type, by outcome; the
//     higher-order share against the NQF band; minutes per mark.
//  2. reviewInstrumentAgainstStandard() - the AI reads the paper against the
//     qualification's Exit Level Outcomes and Assessment Criteria and returns
//     a coverage matrix (every ELO and AC → covered / partial / not covered,
//     with the questions that evidence it), a judgement on cognitive demand,
//     per-question alignment issues, recommendations and a verdict.
//
// The result is stored on the instrument (quality_review) and shown to the
// Administrator, who decides what to change - it is advice, not a gate.

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set - required for the assessment standard check.");
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

export interface QualityReviewInput {
  qualificationTitle: string;
  qctoRegistrationType: "fisa" | "eisa";
  nqfLevel: number | null;
  exitLevelOutcomes: string[]; // may be empty when the paper has no source extract
  assessmentCriteria: string[];
  sourceOfOutcomes: "saqa" | "qcto_upload" | "paper_only";
  questions: Question[];
  timeAllocationMinutes: number;
  passRule: string;
}

export function profileInstrument(questions: Question[], timeAllocationMinutes: number, nqfLevel: number | null): InstrumentProfile {
  const byBloom = Object.fromEntries(BLOOM_LEVELS.map((l) => [l, { count: 0, marks: 0 }])) as Record<BloomLevel, { count: number; marks: number }>;
  const byType: Record<string, { count: number; marks: number }> = {};
  const byEloRef: Record<string, { count: number; marks: number }> = {};
  let totalMarks = 0;
  let unlabelledBloom = 0;
  let higher = 0;
  for (const q of questions) {
    totalMarks += q.maxMark;
    byType[q.type] ??= { count: 0, marks: 0 };
    byType[q.type].count++;
    byType[q.type].marks += q.maxMark;
    const elo = q.eloRef?.trim() || "(no outcome reference)";
    byEloRef[elo] ??= { count: 0, marks: 0 };
    byEloRef[elo].count++;
    byEloRef[elo].marks += q.maxMark;
    if (q.bloomLevel && BLOOM_LEVELS.includes(q.bloomLevel)) {
      byBloom[q.bloomLevel].count++;
      byBloom[q.bloomLevel].marks += q.maxMark;
      if (HIGHER_ORDER.includes(q.bloomLevel)) higher += q.maxMark;
    } else {
      unlabelledBloom++;
    }
  }
  return {
    totalMarks,
    questionCount: questions.length,
    minutesPerMark: totalMarks ? Math.round((timeAllocationMinutes / totalMarks) * 100) / 100 : 0,
    byType,
    byBloom,
    higherOrderMarkShare: totalMarks ? Math.round((higher / totalMarks) * 1000) / 10 : 0,
    expectedHigherOrderShare: expectedHigherOrderShare(nqfLevel),
    byEloRef,
    unlabelledBloom,
  };
}

const SUBMIT_TOOL = {
  name: "submit_standard_check",
  description: "Submit the assessment-standard check for this paper.",
  input_schema: {
    type: "object" as const,
    properties: {
      coverage: {
        type: "array",
        description: "One entry for EVERY Exit Level Outcome and EVERY Assessment Criterion listed (or, if none were listed, one per distinct outcome the paper itself references).",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["elo", "ac"] },
            ref: { type: "string", description: "The outcome/criterion text as listed, verbatim or closely abbreviated with its number." },
            status: { type: "string", enum: ["covered", "partial", "not_covered"] },
            questionIds: { type: "array", items: { type: "string" }, description: "ids of the questions that genuinely evidence it." },
            note: { type: "string", description: "Why covered / partial / not covered - one sentence." },
          },
          required: ["kind", "ref", "status", "questionIds", "note"],
        },
      },
      bloomAssessment: {
        type: "string",
        description: "2-4 sentences: is the cognitive demand right for the NQF level? Are the per-question Bloom's labels honest (flag any mislabelled)? Is there enough analysis/evaluation/creation to evidence competence rather than recall?",
      },
      questionIssues: {
        type: "array",
        items: {
          type: "object",
          properties: {
            questionId: { type: "string" },
            severity: { type: "string", enum: ["info", "warning", "critical"] },
            issue: { type: "string" },
            suggestion: { type: "string" },
          },
          required: ["questionId", "severity", "issue", "suggestion"],
        },
        description: "Only real problems: rubric too vague to mark consistently, question doesn't actually measure the criterion it claims, ambiguous MCQ options, mark allocation out of proportion, Bloom's label wrong, etc.",
      },
      recommendations: {
        type: "array",
        items: { type: "string" },
        description: "Specific, actionable changes to bring the paper to standard, most important first. Include the question to add if an outcome/criterion is uncovered.",
      },
      verdict: { type: "string", enum: ["meets_standard", "meets_with_minor_gaps", "does_not_meet"] },
      summary: { type: "string", description: "One plain-language paragraph for the Administrator." },
    },
    required: ["coverage", "bloomAssessment", "questionIssues", "recommendations", "verdict", "summary"],
  },
};

function buildPrompt(input: QualityReviewInput, profile: InstrumentProfile): string {
  const label = input.qctoRegistrationType === "eisa" ? "EISA" : "FISA";
  const outcomesBlock =
    input.exitLevelOutcomes.length > 0
      ? `EXIT LEVEL OUTCOMES (${input.sourceOfOutcomes === "saqa" ? "from the SAQA record" : "from the uploaded QCTO document"}):
${input.exitLevelOutcomes.map((e, i) => `ELO ${i + 1}: ${e}`).join("\n")}

ASSOCIATED ASSESSMENT CRITERIA:
${input.assessmentCriteria.map((a, i) => `AC ${i + 1}: ${a}`).join("\n")}`
      : `No source list of outcomes/criteria is on record for this paper (it was entered manually). Build the coverage list from the outcome references the questions themselves carry, and say clearly that coverage could only be judged against the paper's own references, not the registered qualification.`;

  const questionsBlock = input.questions
    .map(
      (q, i) => `--- Q${i + 1} (id ${q.id}) · ${q.type} · ${q.maxMark} marks · Bloom's: ${q.bloomLevel ?? "not labelled"}
Outcome ref: ${q.eloRef ?? "-"} | Criterion ref: ${q.acRef ?? "-"}
Prompt: ${q.prompt}${q.type === "mcq" && q.options ? `\nOptions: ${q.options.join(" | ")}` : ""}
Model answer / rubric: ${q.modelAnswerOrRubric ?? "(none)"}`
    )
    .join("\n\n");

  const bloomLine = BLOOM_LEVELS.map((l) => `${l} ${profile.byBloom[l].marks}`).join(", ");

  return `You are a QCTO assessment moderator checking whether a ${label} final assessment paper for "${input.qualificationTitle}" (${input.nqfLevel ? `NQF Level ${input.nqfLevel}` : "NQF level not recorded"}) meets the full requirement of the assessment standard.

The standard means: every registered Exit Level Outcome AND every Associated Assessment Criterion is assessed by at least one question that genuinely evidences it; the cognitive demand (revised Bloom's taxonomy) matches the NQF level - competence is shown by application, analysis and evaluation, not recall alone; each question has a rubric an assessor can mark consistently; marks are weighted in proportion to importance; the paper is answerable in the time.

Facts already computed from the paper (use them, don't recompute):
- ${profile.questionCount} questions, ${profile.totalMarks} marks, ${input.timeAllocationMinutes} minutes (${profile.minutesPerMark} min/mark).
- Marks by Bloom's level: ${bloomLine}. Higher-order share (analyse+evaluate+create): ${profile.higherOrderMarkShare}% against an expected ${profile.expectedHigherOrderShare.min}-${profile.expectedHigherOrderShare.max}% (${profile.expectedHigherOrderShare.basis}).
- Questions with no Bloom's label: ${profile.unlabelledBloom}.
- Pass rule: ${input.passRule || "50% overall"}.

${outcomesBlock}

THE PAPER:
${questionsBlock}

Judge it honestly and specifically. Verdict rules: "meets_standard" only if every ELO and every AC is covered and cognitive demand is within or above the band; "meets_with_minor_gaps" if at most a few criteria are partial and demand is close to the band; otherwise "does_not_meet". Use British/South African English. Call submit_standard_check.`;
}

export async function reviewInstrumentAgainstStandard(input: QualityReviewInput): Promise<InstrumentQualityReview> {
  const profile = profileInstrument(input.questions, input.timeAllocationMinutes, input.nqfLevel);
  const anthropic = getClient();
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 20000,
    tools: [SUBMIT_TOOL],
    tool_choice: { type: "tool", name: "submit_standard_check" },
    messages: [{ role: "user", content: buildPrompt(input, profile) }],
  });
  if (message.stop_reason === "max_tokens") {
    throw new Error(
      "The AI's answer was cut off before it finished (output limit reached). Try a shorter time allocation or split the paper into two instruments."
    );
  }
  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) throw new Error("The AI did not return a structured standard check.");

  const raw = toolUse.input as {
    coverage: Array<Omit<CoverageEntry, "marks">>;
    bloomAssessment: string;
    questionIssues: QuestionAlignmentIssue[];
    recommendations: string[];
    verdict: StandardVerdict;
    summary: string;
  };
  const qById = new Map(input.questions.map((q) => [q.id, q]));
  const coverage: CoverageEntry[] = (raw.coverage ?? []).map((c) => {
    const ids = (c.questionIds ?? []).filter((id) => qById.has(id));
    return {
      kind: c.kind === "ac" ? "ac" : "elo",
      ref: c.ref,
      status: ids.length === 0 ? "not_covered" : c.status,
      questionIds: ids,
      marks: ids.reduce((s, id) => s + (qById.get(id)?.maxMark ?? 0), 0),
      note: c.note ?? "",
    };
  });

  // Make the verdict consistent with the coverage the AI itself reported.
  let verdict: StandardVerdict = raw.verdict;
  const uncovered = coverage.filter((c) => c.status === "not_covered").length;
  const partial = coverage.filter((c) => c.status === "partial").length;
  if (coverage.length > 0) {
    if (uncovered > 0 && verdict === "meets_standard") verdict = uncovered > 2 ? "does_not_meet" : "meets_with_minor_gaps";
    if (partial > 0 && verdict === "meets_standard") verdict = "meets_with_minor_gaps";
  }

  return {
    verdict,
    summary: raw.summary ?? "",
    profile,
    coverage,
    bloomAssessment: raw.bloomAssessment ?? "",
    questionIssues: (raw.questionIssues ?? []).filter((i) => qById.has(i.questionId)),
    recommendations: raw.recommendations ?? [],
    sourceOfOutcomes: input.sourceOfOutcomes,
    nqfLevel: input.nqfLevel,
    generatedAt: new Date().toISOString(),
    model: MODEL,
  };
}
