import Anthropic from "@anthropic-ai/sdk";
import type { Question, AiQuestionSuggestion, GapMapEntry, Outcome } from "../types.js";

// Response-Review Engine (build brief §6, Phase C).
//
// Reads a learner's submitted answers against the instrument's questions,
// model answers / rubrics and ELO references, and produces a *suggested* mark
// per question, what each answer got right and missed, a depth note, a
// confidence level and a rationale - plus an ELO-level gap map and a
// suggested overall outcome. It advises the Assessor; it never decides. The
// Assessor's own marks live in assessor_decisions and are the only thing
// that becomes the learner's result (§5.1).

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set - required for AI response review.");
    }
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

export interface ReviewInput {
  qualificationTitle: string;
  qctoRegistrationType: "fisa" | "eisa";
  passRule: string;
  questions: Question[];
  answers: Record<string, string>;
}

export interface ReviewOutput {
  perQuestion: AiQuestionSuggestion[];
  gapMap: GapMapEntry[];
  suggestedOutcome: Outcome;
  summary: string;
}

const SUBMIT_TOOL = {
  name: "submit_review",
  description: "Submit the marking suggestions, gap map and overall recommendation for this learner's script.",
  input_schema: {
    type: "object" as const,
    properties: {
      perQuestion: {
        type: "array",
        items: {
          type: "object",
          properties: {
            questionId: { type: "string" },
            suggestedMark: { type: "number", description: "Whole or half marks, 0..maxMark." },
            criteriaMatched: {
              type: "array",
              items: { type: "string" },
              description: "Specific points from the model answer / rubric the learner demonstrated.",
            },
            criteriaMissed: {
              type: "array",
              items: { type: "string" },
              description: "Specific points from the model answer / rubric the learner did not demonstrate.",
            },
            depthNote: {
              type: "string",
              description: "One sentence on depth of understanding, e.g. 'Correct but no justification given' or 'Applies the concept to the scenario well'.",
            },
            confidence: { type: "string", enum: ["low", "medium", "high"] },
            rationale: {
              type: "string",
              description: "2-3 sentences for the Assessor explaining the suggested mark, quoting the learner where useful.",
            },
          },
          required: ["questionId", "suggestedMark", "criteriaMatched", "criteriaMissed", "depthNote", "confidence", "rationale"],
        },
      },
      gapMap: {
        type: "array",
        description: "One entry per distinct Exit Level Outcome / criterion referenced by the paper's questions.",
        items: {
          type: "object",
          properties: {
            eloRef: { type: "string" },
            demonstrated: { type: "boolean" },
            evidenceQuestionIds: { type: "array", items: { type: "string" } },
            note: {
              type: "string",
              description: "Plain-language: what the learner showed, or what is still lacking, for this outcome.",
            },
          },
          required: ["eloRef", "demonstrated", "evidenceQuestionIds", "note"],
        },
      },
      suggestedOutcome: { type: "string", enum: ["competent", "not_yet_competent"] },
      summary: {
        type: "string",
        description: "One plain-language paragraph for the Assessor: overall standard of the script, main strengths, main gaps.",
      },
    },
    required: ["perQuestion", "gapMap", "suggestedOutcome", "summary"],
  },
};

function fmtAnswer(q: Question, answer: string | undefined): string {
  if (answer === undefined || answer === null || String(answer).trim() === "") return "(no answer given)";
  return String(answer);
}

function buildPrompt(input: ReviewInput): string {
  const label = input.qctoRegistrationType === "eisa" ? "EISA" : "FISA";
  const blocks = input.questions.map((q, i) => {
    const opts = q.type === "mcq" && q.options ? `\nOptions: ${q.options.join(" | ")}` : "";
    return `--- QUESTION ${i + 1}  (id: ${q.id}, type: ${q.type}, max mark: ${q.maxMark})
Outcome addressed: ${q.eloRef ?? "(not specified)"}
Prompt: ${q.prompt}${opts}
Model answer / rubric (never shown to the learner): ${q.modelAnswerOrRubric ?? "(none recorded)"}
LEARNER'S ANSWER: ${fmtAnswer(q, input.answers[q.id])}`;
  });

  return `You are assisting a registered Assessor marking a QCTO ${label} script for the qualification "${input.qualificationTitle}".

Pass / competency rule for this paper: ${input.passRule || "50% overall"}.

Mark every question against its model answer or rubric. Be exact and fair: award marks for what is demonstrably present in the learner's answer, not for what they might have meant. For multiple-choice, the mark is full or zero. For written answers, award partial marks per rubric point met. Where an answer is correct but shallow (no justification, no application to the scenario), say so in depthNote and reflect it in the mark only if the rubric asks for depth. A blank answer scores 0 with every rubric point missed.

Then build the gap map: for each distinct outcome referenced by the questions, decide whether the learner has demonstrated it across all questions that address it, cite those question ids, and write one sentence on what is still lacking if not.

Finally give a suggested outcome under the pass rule and a short summary for the Assessor. Use British/South African English. You are advising - the Assessor makes the decision.

${blocks.join("\n\n")}

Call submit_review with the result. Every question id above must appear exactly once in perQuestion.`;
}

export async function reviewSubmission(input: ReviewInput): Promise<ReviewOutput> {
  const anthropic = getClient();

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 20000,
    tools: [SUBMIT_TOOL],
    tool_choice: { type: "tool", name: "submit_review" },
    messages: [{ role: "user", content: buildPrompt(input) }],
  });

  if (message.stop_reason === "max_tokens") {
    throw new Error(
      "The AI's answer was cut off before it finished (output limit reached). Try a shorter time allocation or split the paper into two instruments."
    );
  }
  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolUse) {
    throw new Error("The AI did not return a structured review (no tool_use block in the response).");
  }

  const raw = toolUse.input as {
    perQuestion: Array<Omit<AiQuestionSuggestion, "maxMark">>;
    gapMap: GapMapEntry[];
    suggestedOutcome: Outcome;
    summary: string;
  };

  // Normalise: clamp marks into range, fill in maxMark from the instrument,
  // make sure every question has an entry (a missing one gets a low-confidence
  // zero so the Assessor sees the hole rather than nothing).
  const byId = new Map(input.questions.map((q) => [q.id, q]));
  const seen = new Set<string>();
  const perQuestion: AiQuestionSuggestion[] = [];
  for (const s of raw.perQuestion ?? []) {
    const q = byId.get(s.questionId);
    if (!q || seen.has(s.questionId)) continue;
    seen.add(s.questionId);
    const mark = Math.max(0, Math.min(q.maxMark, Number(s.suggestedMark) || 0));
    perQuestion.push({
      questionId: q.id,
      suggestedMark: Math.round(mark * 2) / 2,
      maxMark: q.maxMark,
      criteriaMatched: s.criteriaMatched ?? [],
      criteriaMissed: s.criteriaMissed ?? [],
      depthNote: s.depthNote ?? "",
      confidence: s.confidence ?? "low",
      rationale: s.rationale ?? "",
    });
  }
  for (const q of input.questions) {
    if (seen.has(q.id)) continue;
    perQuestion.push({
      questionId: q.id,
      suggestedMark: 0,
      maxMark: q.maxMark,
      criteriaMatched: [],
      criteriaMissed: [],
      depthNote: "The AI did not return a suggestion for this question - mark it manually.",
      confidence: "low",
      rationale: "",
    });
  }
  // Keep the instrument's question order.
  const order = new Map(input.questions.map((q, i) => [q.id, i]));
  perQuestion.sort((a, b) => (order.get(a.questionId) ?? 0) - (order.get(b.questionId) ?? 0));

  return {
    perQuestion,
    gapMap: (raw.gapMap ?? []).map((g) => ({
      eloRef: g.eloRef,
      demonstrated: Boolean(g.demonstrated),
      evidenceQuestionIds: (g.evidenceQuestionIds ?? []).filter((id) => byId.has(id)),
      note: g.note ?? "",
    })),
    suggestedOutcome: raw.suggestedOutcome === "competent" ? "competent" : "not_yet_competent",
    summary: raw.summary ?? "",
  };
}
