import type Anthropic from "@anthropic-ai/sdk";
import { createLongMessage, MODEL, type ProgressHook } from "./longCall.js";
import { randomUUID } from "node:crypto";
import type { Question, QuestionType, BloomLevel, InstrumentQualityReview } from "../types.js";
import { bloomGuidanceForNqf } from "./bloom.js";
import { SITTING_RULE } from "./instrumentGeneration.js";

// "Fix the gaps": takes a drafted paper together with the moderator's (standard
// check's) findings and revises the paper so that it meets the assessment
// standard - covering every outcome and criterion, labelling and lifting
// cognitive demand to the NQF band, and fixing the flagged questions - while
// keeping the paper within its time allocation. Questions that already work are
// kept as they are (same id, so their history survives); weak ones are replaced.



export interface ReviseInput {
  qualificationTitle: string;
  qctoRegistrationType: "fisa" | "eisa" | "non_qcto";
  nqfLevel: number | null;
  exitLevelOutcomes: string[];
  assessmentCriteria: string[];
  timeAllocationMinutes: number;
  permittedMaterials: string[];
  questions: Question[];
  review: InstrumentQualityReview;
  passRule: string;
}

export interface RevisedInstrument {
  questions: Question[];
  passMarkOrCompetencyRule: string;
  changeSummary: string;
  kept: number;
  replaced: number;
  added: number;
}

const SUBMIT_TOOL = {
  name: "submit_revised_instrument",
  description: "Submit the revised assessment paper that addresses the moderator's findings.",
  input_schema: {
    type: "object" as const,
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            keepId: {
              type: "string",
              description: "If this is an existing question kept unchanged OR lightly edited (same intent, same outcome), its id exactly as given. Omit for a new or replacement question.",
            },
            type: { type: "string", enum: ["mcq", "short_answer", "long_answer"] },
            prompt: { type: "string" },
            maxMark: { type: "number" },
            options: { type: "array", items: { type: "string" }, description: "Only for type = mcq." },
            modelAnswerOrRubric: { type: "string", description: "Model answer or rubric - specific enough for an assessor and an AI marker. Never shown to the learner." },
            eloRef: { type: "string", description: "The Exit Level Outcome this question evidences, quoted by number and opening words exactly as listed." },
            acRef: { type: "string", description: "The Assessment Criterion it primarily evidences, quoted by number and opening words exactly as listed." },
            bloomLevel: { type: "string", enum: ["remember", "understand", "apply", "analyse", "evaluate", "create"] },
          },
          required: ["type", "prompt", "maxMark", "modelAnswerOrRubric", "eloRef", "acRef", "bloomLevel"],
        },
      },
      passMarkOrCompetencyRule: {
        type: "string",
        description: "The pass rule in PERCENTAGES ONLY (e.g. '50% overall'). Keep the existing rule unless it is expressed in absolute marks, in which case restate it as a percentage.",
      },
      changeSummary: {
        type: "string",
        description: "Plain language for the Administrator: what was kept, what was replaced and why, which outcomes are now covered, and anything that could not be fitted within the time allocation.",
      },
    },
    required: ["questions", "passMarkOrCompetencyRule", "changeSummary"],
  },
};

function buildPrompt(input: ReviseInput, overshoot?: { marks: number; limit: number }): string {
  const label = input.qctoRegistrationType === "eisa" ? "QCTO EISA" : input.qctoRegistrationType === "fisa" ? "QCTO FISA" : "non-QCTO summative";
  const targetMarks = Math.round(input.timeAllocationMinutes / 1.5);
  const r = input.review;
  const gaps = r.coverage.filter((c) => c.status !== "covered");
  const questionsBlock = input.questions
    .map(
      (q, i) => `--- Q${i + 1} (id ${q.id}) · ${q.type} · ${q.maxMark} marks · Bloom's: ${q.bloomLevel ?? "not labelled"}
Outcome ref: ${q.eloRef ?? "-"} | Criterion ref: ${q.acRef ?? "-"}
Prompt: ${q.prompt}${q.type === "mcq" && q.options ? `\nOptions: ${q.options.join(" | ")}` : ""}
Model answer / rubric: ${q.modelAnswerOrRubric ?? "(none)"}`
    )
    .join("\n\n");

  return `You are revising a ${label} assessment paper for "${input.qualificationTitle}" (${input.nqfLevel ? `NQF Level ${input.nqfLevel}` : "NQF level not recorded"}) so that it meets the full assessment standard. A moderator has checked the current paper and found it wanting. Your job is to fix the paper - not to write a new one from nothing.

THE STANDARD THE REVISED PAPER MUST MEET
1. Every Exit Level Outcome and every Assessment Criterion listed below is evidenced by at least one question. An ELO or AC that is only a heading or preamble with no assessable competence statement does not need a question - say so in changeSummary.
2. Every question carries the Bloom's level it genuinely demands. Cognitive demand: ${bloomGuidanceForNqf(input.nqfLevel)}
3. Every question has a specific, markable model answer or rubric.
4. The whole paper fits ${input.timeAllocationMinutes} minutes: about ${targetMarks} marks in total, and never more than ${markLimit(input.timeAllocationMinutes)} (one mark per minute is the ceiling for a written paper). This is a hard limit - the time allocation is fixed by the qualification, not by you. To make room for uncovered outcomes, remove or merge low-value recall questions and fold several criteria into one well-built application or case question (say which it primarily evidences in acRef). If something honestly cannot be fitted, leave it out and say so in changeSummary rather than exceeding the limit.
5. Permitted materials: ${input.permittedMaterials.length ? input.permittedMaterials.join(", ") : "none specified"}.
6. ${SITTING_RULE} Replace any existing question that breaks this rule with one on the same outcome that can be answered in the sitting.

HOW TO REVISE
- Keep every question that already works: return it with its keepId, unchanged or lightly edited (adding the Bloom's label, tightening the rubric, fixing the outcome reference).
- Replace questions the moderator flagged as critical or that duplicate others.
- Add questions only for outcomes and criteria not yet covered, at the cognitive level the NQF band requires.
- The paper must be complete - never stop part-way through the question list.

MODERATOR'S FINDINGS
Verdict: ${r.verdict}. ${r.summary}
Cognitive demand: ${r.bloomAssessment}
Higher-order share now ${r.profile.higherOrderMarkShare}% of marks; expected ${r.profile.expectedHigherOrderShare.min}-${r.profile.expectedHigherOrderShare.max}%.
Not covered or only partly covered (${gaps.length}):
${gaps.map((g) => `- [${g.kind.toUpperCase()} · ${g.status}] ${g.ref}${g.note ? ` — ${g.note}` : ""}`).join("\n") || "- none"}
Question issues:
${r.questionIssues.map((i) => `- Q id ${i.questionId} [${i.severity}]: ${i.issue} → ${i.suggestion}`).join("\n") || "- none"}
Recommendations:
${r.recommendations.map((x, i) => `${i + 1}. ${x}`).join("\n") || "- none"}

EXIT LEVEL OUTCOMES
${input.exitLevelOutcomes.map((e, i) => `ELO ${i + 1}: ${e}`).join("\n") || "(none on record - use the paper's own references)"}

ASSOCIATED ASSESSMENT CRITERIA
${input.assessmentCriteria.map((a, i) => `AC ${i + 1}: ${a}`).join("\n") || "(none on record)"}

CURRENT PAPER (pass rule: ${input.passRule || "50% overall"})
${questionsBlock}

${overshoot ? `\nIMPORTANT - YOUR PREVIOUS ATTEMPT WAS REJECTED: it totalled ${overshoot.marks} marks against a hard limit of ${overshoot.limit} for ${input.timeAllocationMinutes} minutes. This time the total MUST be at or under ${overshoot.limit} marks. Merge related questions into fewer, richer case questions and drop recall items; keep coverage of every outcome.\n` : ""}
Call submit_revised_instrument with the complete revised paper.`;
}

// The most marks a paper of this length may carry: one mark per minute. Papers are
// sized towards ~1.5 minutes per mark; this is the ceiling, not the target.
export const markLimit = (minutes: number) => Math.round(minutes);

export async function reviseInstrumentToStandard(input: ReviseInput, onProgress?: ProgressHook): Promise<RevisedInstrument> {
  const limit = markLimit(input.timeAllocationMinutes);
  let attempt = await reviseOnce(input, onProgress);
  const total = (qs: Question[]) => qs.reduce((s, q) => s + q.maxMark, 0);
  // The time allocation is a hard constraint the model sometimes overruns when
  // many outcomes are missing. One corrective pass, told exactly by how much.
  if (total(attempt.questions) > limit) {
    // A short, fast decision call: which questions to keep and at what marks. The
    // arithmetic is checked here, not trusted from the model.
    const trimmed = await trimToBudget(input, attempt.questions, limit);
    if (trimmed) {
      const before = total(attempt.questions);
      attempt = {
        ...attempt,
        questions: trimmed.questions,
        changeSummary: `${attempt.changeSummary}\n\nTrimmed to the time allocation: ${before} marks → ${total(trimmed.questions)} marks over ${trimmed.questions.length} questions (limit ${limit} for ${input.timeAllocationMinutes} minutes). ${trimmed.rationale}`,
      };
    } else {
      attempt.changeSummary += `\n\nNote: the revised paper totals ${total(attempt.questions)} marks, above the ${limit}-mark guide for ${input.timeAllocationMinutes} minutes, and could not be trimmed without losing coverage. Either extend the time allocation or remove some questions on the assessment page.`;
    }
  }
  return attempt;
}

const TRIM_TOOL = {
  name: "submit_trim",
  description: "Choose which questions stay in the paper, and at what marks, so the total fits the time allocation while every outcome stays covered.",
  input_schema: {
    type: "object" as const,
    properties: {
      keep: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            maxMark: { type: "number", description: "The mark this question carries after trimming - the same or lower, never higher. Lower a mark only when the rubric can honestly be applied at the lower mark (e.g. fewer items required)." },
          },
          required: ["id", "maxMark"],
        },
      },
      rationale: { type: "string", description: "One or two sentences for the Administrator: what was dropped or reduced and why coverage is intact." },
    },
    required: ["keep", "rationale"],
  },
};

export async function trimToBudget(input: ReviseInput, questions: Question[], limit: number): Promise<{ questions: Question[]; rationale: string } | null> {
  const list = questions
    .map((q, i) => `${q.id} | Q${i + 1} | ${q.type} | ${q.maxMark} marks | ${q.bloomLevel ?? "-"} | ${q.eloRef ?? "-"} / ${q.acRef ?? "-"} | ${q.prompt.slice(0, 110).replace(/\s+/g, " ")}`)
    .join("\n");
  const total = questions.reduce((s, q) => s + q.maxMark, 0);
  const prompt = `A ${input.timeAllocationMinutes}-minute assessment paper for "${input.qualificationTitle}" currently totals ${total} marks over ${questions.length} questions. The hard limit is ${limit} marks (about ${Math.round(input.timeAllocationMinutes / 1.5)} is ideal). Decide which questions stay and at what marks so that THE SUM OF THE MARKS YOU KEEP IS AT OR UNDER ${limit} - add them up before you answer - while every Exit Level Outcome and Assessment Criterion that is currently covered stays covered by at least one question, higher-order questions (analyse/evaluate/create) are protected, and duplicates or low-value recall items go first. Marks may be lowered, never raised.

Each line: id | number | type | marks | Bloom's | outcome / criterion | start of prompt
${list}

Call submit_trim.`;
  let lastSum = total;
  for (let attempt = 0; attempt < 3; attempt++) {
    const message = await createLongMessage({
      model: MODEL,
      max_tokens: 4000,
      tools: [TRIM_TOOL],
      tool_choice: { type: "tool", name: "submit_trim" },
      messages: [{ role: "user", content: attempt === 0 ? prompt : `${prompt}\n\nYour previous answer did not fit: it kept ${lastSum} marks against the limit of ${limit}. Add up the marks you keep before answering, and cut further - dropping whole questions is better than shaving marks.` }],
    });
    const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const raw = toolUse?.input as { keep: Array<{ id: string; maxMark: number }>; rationale: string } | undefined;
    if (!raw?.keep?.length) continue;
    const byId = new Map(questions.map((q) => [q.id, q]));
    const kept: Question[] = [];
    for (const k of raw.keep) {
      const q = byId.get(k.id);
      if (!q || kept.some((x) => x.id === q.id)) continue;
      const mark = Number.isFinite(k.maxMark) && k.maxMark > 0 ? Math.min(k.maxMark, q.maxMark) : q.maxMark;
      kept.push({ ...q, maxMark: mark });
    }
    const sum = kept.reduce((s, q) => s + q.maxMark, 0);
    lastSum = sum;
    console.log(`trimToBudget attempt ${attempt + 1}: ${kept.length}/${questions.length} questions kept, ${sum} marks (limit ${limit})`);
    // Sanity: within budget, and still a real paper (at least a third of the questions).
    if (sum <= limit && kept.length >= Math.ceil(questions.length / 3)) {
      // Keep the original order.
      const order = new Map(questions.map((q, i) => [q.id, i]));
      kept.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      return { questions: kept, rationale: raw.rationale };
    }
  }
  return null;
}

async function reviseOnce(input: ReviseInput, onProgress?: ProgressHook, overshoot?: { marks: number; limit: number }): Promise<RevisedInstrument> {
  const message = await createLongMessage({
    model: MODEL,
    max_tokens: 20000,
    tools: [SUBMIT_TOOL],
    tool_choice: { type: "tool", name: "submit_revised_instrument" },
    messages: [{ role: "user", content: buildPrompt(input, overshoot) }],
  }, onProgress);
  if (message.stop_reason === "max_tokens") {
    throw new Error("The AI's revision was cut off before it finished (output limit reached). Try again, or split the paper into two instruments.");
  }
  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) throw new Error("The AI did not return a revised paper.");

  const raw = toolUse.input as {
    questions: Array<{
      keepId?: string;
      type: QuestionType;
      prompt: string;
      maxMark: number;
      options?: string[];
      modelAnswerOrRubric: string;
      eloRef: string;
      acRef?: string;
      bloomLevel?: BloomLevel;
    }>;
    passMarkOrCompetencyRule: string;
    changeSummary: string;
  };
  if (!raw.questions?.length) throw new Error("The AI returned a revised paper with no questions.");

  const existing = new Set(input.questions.map((q) => q.id));
  let kept = 0;
  const seen = new Set<string>();
  const questions: Question[] = raw.questions.map((q) => {
    const keep = q.keepId && existing.has(q.keepId) && !seen.has(q.keepId);
    if (keep) {
      kept++;
      seen.add(q.keepId!);
    }
    return {
      id: keep ? q.keepId! : randomUUID(),
      type: q.type,
      prompt: q.prompt,
      maxMark: q.maxMark,
      options: q.type === "mcq" ? q.options : undefined,
      modelAnswerOrRubric: q.modelAnswerOrRubric,
      eloRef: q.eloRef,
      acRef: q.acRef,
      bloomLevel: q.bloomLevel,
    };
  });
  const replaced = input.questions.length - kept;
  const added = Math.max(0, questions.length - kept - replaced);

  return { questions, passMarkOrCompetencyRule: raw.passMarkOrCompetencyRule, changeSummary: raw.changeSummary, kept, replaced, added };
}
