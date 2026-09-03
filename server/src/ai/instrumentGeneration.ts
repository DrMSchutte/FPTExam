import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import type { Question, QuestionType } from "../types.js";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set - required for AI instrument generation.");
    }
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

export interface GenerateInstrumentInput {
  qualificationTitle: string;
  qctoRegistrationType: "fisa" | "eisa";
  exitLevelOutcomes: string[];
  assessmentCriteria: string[];
  timeAllocationMinutes: number;
  permittedMaterials: string[];
}

export interface GeneratedInstrument {
  questions: Question[];
  passMarkOrCompetencyRule: string;
  coverageNotes: string;
}

const SUBMIT_TOOL = {
  name: "submit_instrument",
  description: "Submit the drafted assessment instrument mapped to the qualification's ELOs/ACs.",
  input_schema: {
    type: "object" as const,
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["mcq", "short_answer", "long_answer", "practical_upload"],
            },
            prompt: { type: "string" },
            maxMark: { type: "number" },
            options: {
              type: "array",
              items: { type: "string" },
              description: "Only for type = mcq: the answer options, one of which is correct.",
            },
            modelAnswerOrRubric: {
              type: "string",
              description: "The model answer (for mcq/short_answer) or rubric criteria (for long_answer/practical_upload). Never shown to the learner.",
            },
            eloRef: {
              type: "string",
              description: "Plain-language reference to which Exit Level Outcome / Assessment Criterion this question addresses.",
            },
          },
          required: ["type", "prompt", "maxMark", "modelAnswerOrRubric", "eloRef"],
        },
      },
      passMarkOrCompetencyRule: {
        type: "string",
        description: "Plain-language pass mark or competency rule for this paper, e.g. '50% overall' or 'Competent in every criterion'.",
      },
      coverageNotes: {
        type: "string",
        description:
          "Plain language: which ELOs/ACs are covered by the drafted questions, and any the model could not confidently write a question for.",
      },
    },
    required: ["questions", "passMarkOrCompetencyRule", "coverageNotes"],
  },
};

function buildPrompt(input: GenerateInstrumentInput): string {
  const registrationLabel = input.qctoRegistrationType === "eisa" ? "EISA" : "FISA";
  return `You are drafting a QCTO ${registrationLabel} final assessment paper for the qualification "${input.qualificationTitle}".

The paper must be built directly from this qualification's registered Exit Level Outcomes (ELOs) and Associated Assessment Criteria (ACs), as published by SAQA. Draft a full assessment instrument: a mix of question types (multiple choice, short answer, long answer, practical/portfolio upload) appropriate to what each outcome actually requires a learner to demonstrate - don't force every outcome into the same question type. Every question must be traceable to a specific ELO/AC via its eloRef field. Aim for enough questions to cover every ELO at least once within the given time allocation; it's fine to leave a gap uncovered rather than write a weak or unsupported question - note any gap in coverageNotes instead.

Time allocation for the whole paper: ${input.timeAllocationMinutes} minutes.
Permitted materials: ${input.permittedMaterials.length > 0 ? input.permittedMaterials.join(", ") : "none specified"}.

EXIT LEVEL OUTCOMES (as published by SAQA):
${input.exitLevelOutcomes.map((elo, i) => `${i + 1}. ${elo}`).join("\n")}

ASSOCIATED ASSESSMENT CRITERIA (as published by SAQA):
${input.assessmentCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n")}

Write a real model answer or rubric for every question - this is what an Assessor and an AI marking engine will use to mark real learner submissions, so it needs to be specific and usable, not a placeholder. Call submit_instrument with the result.`;
}

export async function generateInstrumentFromSaqa(
  input: GenerateInstrumentInput
): Promise<GeneratedInstrument> {
  const anthropic = getClient();

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8000,
    tools: [SUBMIT_TOOL],
    tool_choice: { type: "tool", name: "submit_instrument" },
    messages: [{ role: "user", content: buildPrompt(input) }],
  });

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolUse) {
    throw new Error("The AI did not return a structured instrument (no tool_use block in the response).");
  }

  const raw = toolUse.input as {
    questions: Array<{
      type: QuestionType;
      prompt: string;
      maxMark: number;
      options?: string[];
      modelAnswerOrRubric: string;
      eloRef: string;
    }>;
    passMarkOrCompetencyRule: string;
    coverageNotes: string;
  };

  if (!raw.questions || raw.questions.length === 0) {
    throw new Error("The AI returned an instrument with no questions.");
  }

  const questions: Question[] = raw.questions.map((q) => ({
    id: randomUUID(),
    type: q.type,
    prompt: q.prompt,
    maxMark: q.maxMark,
    options: q.type === "mcq" ? q.options : undefined,
    modelAnswerOrRubric: q.modelAnswerOrRubric,
    eloRef: q.eloRef,
  }));

  return {
    questions,
    passMarkOrCompetencyRule: raw.passMarkOrCompetencyRule,
    coverageNotes: raw.coverageNotes,
  };
}
