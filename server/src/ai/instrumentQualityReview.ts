import type Anthropic from "@anthropic-ai/sdk";
import { createLongMessage, MODEL, type ProgressHook } from "./longCall.js";
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



export interface QualityReviewInput {
  qualificationTitle: string;
  qctoRegistrationType: "fisa" | "eisa" | "non_qcto";
  nqfLevel: number | null;
  exitLevelOutcomes: string[]; // may be empty when the paper has no source extract
  assessmentCriteria: string[];
  sourceOfOutcomes: "saqa" | "qcto_upload" | "own_outcomes" | "curricula_builder" | "paper_only";
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
  const label = input.qctoRegistrationType === "eisa" ? "QCTO EISA" : input.qctoRegistrationType === "fisa" ? "QCTO FISA" : "non-QCTO summative";
  const outcomesBlock =
    input.exitLevelOutcomes.length > 0
      ? `EXIT LEVEL OUTCOMES (${input.sourceOfOutcomes === "saqa" ? "from the SAQA record" : input.sourceOfOutcomes === "qcto_upload" ? "from the uploaded document" : input.sourceOfOutcomes === "curricula_builder" ? "as supplied by Curricula Builder" : "as stated by the Administrator who set the assessment up"}):
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

  return `You are an assessment moderator working to QCTO standards, checking whether a ${label} assessment paper for "${input.qualificationTitle}" (${input.nqfLevel ? `NQF Level ${input.nqfLevel}` : "NQF level not recorded"}) meets the full requirement of the assessment standard.

The paper is sat as a proctored, closed-book examination in one timed session on a locked screen, and every answer is TYPED TEXT in an answer box: no internet, no sources, no files or uploads, no workplace or interview tasks, nothing done over days, and nothing drawn, sketched or plotted (a chart, diagram, organogram or graph cannot be produced in a text box - ask the learner to describe or list it instead). Any question that cannot be fully answered there and then, typed, from the learner's own knowledge plus what the question supplies, is not an exam question - report it as a critical questionIssue.

The standard means: every registered Exit Level Outcome AND every Associated Assessment Criterion is assessed by at least one question that genuinely evidences it; the cognitive demand (revised Bloom's taxonomy) matches the NQF level - competence is shown by application, analysis and evaluation, not recall alone; each question has a rubric an assessor can mark consistently; marks are weighted in proportion to importance; the paper is answerable in the time.

Facts already computed from the paper (use them, don't recompute):
- ${profile.questionCount} questions, ${profile.totalMarks} marks, ${input.timeAllocationMinutes} minutes (${profile.minutesPerMark} min/mark).
- Marks by Bloom's level: ${bloomLine}. Higher-order share (analyse+evaluate+create): ${profile.higherOrderMarkShare}% against an expected ${profile.expectedHigherOrderShare.min}-${profile.expectedHigherOrderShare.max}% (${profile.expectedHigherOrderShare.basis}).
- Questions with no Bloom's label: ${profile.unlabelledBloom}.
- Pass rule: ${input.passRule || "50% overall"}.

${outcomesBlock}

THE PAPER:
${questionsBlock}

An ELO or AC that is only a heading, preamble or general introduction with no assessable competence statement (e.g. "General introduction") is not a gap: list it with status "covered", no questions, 0 marks, and a note saying it is not assessable, so it never blocks a paper.

Judge it honestly and specifically. Verdict rules: "meets_standard" only if every ELO and every AC is covered and cognitive demand is within or above the band; "meets_with_minor_gaps" if at most a few criteria are partial and demand is close to the band; otherwise "does_not_meet". Use British/South African English. Call submit_standard_check.`;
}

export async function reviewInstrumentAgainstStandard(input: QualityReviewInput, onProgress?: ProgressHook): Promise<InstrumentQualityReview> {
  const profile = profileInstrument(input.questions, input.timeAllocationMinutes, input.nqfLevel);
  const message = await createLongMessage({
    model: MODEL,
    max_tokens: 20000,
    tools: [SUBMIT_TOOL],
    tool_choice: { type: "tool", name: "submit_standard_check" },
    messages: [{ role: "user", content: buildPrompt(input, profile) }],
  }, onProgress);
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

  // Deterministic time rule: under a minute per mark is not an answerable paper,
  // whatever the AI's reading. Never a full pass at that density; the fix is
  // stated plainly so "Fix the gaps" and the Administrator both see it.
  const recommendations = [...(raw.recommendations ?? [])];
  if (profile.totalMarks > input.timeAllocationMinutes) {
    if (verdict === "meets_standard") verdict = "meets_with_minor_gaps";
    recommendations.unshift(
      `Time: ${profile.totalMarks} marks in ${input.timeAllocationMinutes} minutes is under a minute per mark. Extend the time allocation to at least ${Math.ceil(profile.totalMarks / 10) * 10} minutes, or reduce the paper to at most ${input.timeAllocationMinutes} marks.`
    );
  }

  // Deterministic sitting rule: a question that needs research, a workplace,
  // other people or an upload cannot be answered in a proctored sitting. It is
  // an assignment task, and the paper is blocked until it is replaced.
  const questionIssues = (raw.questionIssues ?? []).filter((i) => qById.has(i.questionId));
  const assignmentLike = input.questions.filter((q) => looksLikeAssignmentTask(q));
  for (const q of assignmentLike) {
    const idx = input.questions.indexOf(q) + 1;
    if (!questionIssues.some((i) => i.questionId === q.id && /sitting|assignment|research|upload/i.test(i.issue))) {
      questionIssues.unshift({
        questionId: q.id,
        severity: "critical",
        issue: `Q${idx} is an assignment task, not an exam question: it asks the learner to ${assignmentVerb(q)}, which cannot be done in a proctored, closed-book sitting.`,
        suggestion: "Replace it with a scenario, case study or worked task on the same outcome that the learner answers in writing during the sitting.",
      });
    }
  }
  if (assignmentLike.length) {
    verdict = "does_not_meet";
    recommendations.unshift(
      `${assignmentLike.length === 1 ? "One question" : `${assignmentLike.length} questions`} (${assignmentLike.map((q) => `Q${input.questions.indexOf(q) + 1}`).join(", ")}) cannot be answered in a proctored sitting - ${assignmentLike.length === 1 ? "it asks" : "they ask"} for research, outside sources, a workplace task or a document upload. Replace with in-sitting tasks on the same outcomes (Fix the gaps does this).`
    );
  }

  return {
    verdict,
    summary: raw.summary ?? "",
    profile,
    coverage,
    bloomAssessment: raw.bloomAssessment ?? "",
    questionIssues,
    recommendations,
    sourceOfOutcomes: input.sourceOfOutcomes,
    nqfLevel: input.nqfLevel,
    generatedAt: new Date().toISOString(),
    model: MODEL,
  };
}

// ---- Sitting rule --------------------------------------------------------------------------

const ASSIGNMENT_PATTERNS: [RegExp, string][] = [
  [/\b(conduct|carry out|do|undertake)\b[^.]{0,40}\bresearch\b|\bresearch (on|into|about)\b/i, "do research"],
  [/\b(upload|attach|submit)\b[^.]{0,60}\b(document|file|report|portfolio|evidence|spreadsheet|presentation|video|photo|photograph|recording)/i, "upload a document or file"],
  [/\b(portfolio of evidence|PoE)\b/i, "compile a portfolio of evidence"],
  [/\b(collect|gather|obtain|source|find|request|get|bring)\b[^.]{0,50}\b(from|at|in) your (workplace|organisation|organization|company|place of work|employer)\b/i, "gather workplace information"],
  [/\b(interview|survey|shadow)\b[^.]{0,40}\b(colleague|manager|supervisor|customer|client|employee|staff|people|learner|worker)/i, "interview or survey other people"],
  [/\b(use|search|consult|browse|visit|refer to)\b[^.]{0,30}\b(internet|online sources|websites?|web|library|textbooks?|google)\b/i, "use the internet or other sources"],
  [/\bover (the next|a period of|the coming) (\d+|few|several|two|three|four) (days?|weeks?|months?)\b|\bwithin (\d+|two|three|four) (weeks?|days?) of\b/i, "work over days or weeks"],
  [/\b(record|film|video) (yourself|a demonstration)\b|\btake (a )?photographs?\b/i, "make a recording or photographs"],
  // The answer box is typed text: nothing can be drawn, sketched or plotted.
  [/\b(draw|sketch|plot|illustrate|construct|design)\b[^.]{0,40}\b(chart|diagram|flow ?chart|organogram|organisational structure|mind ?map|graph|drawing|sketch|flow diagram|process map|layout)\b/i, "draw a chart or diagram"],
];

function looksLikeAssignmentTask(q: { type: string; prompt: string }): boolean {
  if (q.type === "practical_upload") return true;
  return ASSIGNMENT_PATTERNS.some(([re]) => re.test(q.prompt));
}

function assignmentVerb(q: { type: string; prompt: string }): string {
  const hit = ASSIGNMENT_PATTERNS.find(([re]) => re.test(q.prompt));
  return hit ? hit[1] : "produce and upload a document";
}
