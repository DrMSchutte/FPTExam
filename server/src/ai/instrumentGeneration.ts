import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import type { Question, QuestionType, BloomLevel } from "../types.js";
import { bloomGuidanceForNqf } from "./bloom.js";

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
  // Where the ELOs/ACs above came from, for the prompt's own wording - e.g.
  // "as published by SAQA" or "as extracted from the uploaded QCTO
  // Assessment Specifications document". Defaults to a SAQA-shaped phrasing
  // for backward compatibility with the existing SAQA intake path.
  sourceDescription?: string;
  // NQF level of the qualification, when known - sets the expected cognitive
  // demand (Bloom's) of the paper.
  nqfLevel?: number | null;
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
              description: "The Exit Level Outcome this question addresses - quote it by its number and opening words exactly as listed, e.g. 'ELO 3: Complete statutory returns…'.",
            },
            acRef: {
              type: "string",
              description: "The Associated Assessment Criterion this question evidences - quote it by its number and opening words exactly as listed, e.g. 'AC 3.2: IRP5 certificates are issued…'.",
            },
            bloomLevel: {
              type: "string",
              enum: ["remember", "understand", "apply", "analyse", "evaluate", "create"],
              description: "The cognitive demand of the question on the revised Bloom's taxonomy - what the learner must actually DO with the knowledge to answer.",
            },
          },
          required: ["type", "prompt", "maxMark", "modelAnswerOrRubric", "eloRef", "acRef", "bloomLevel"],
        },
      },
      passMarkOrCompetencyRule: {
        type: "string",
        description: "Plain-language pass mark or competency rule for this paper, expressed in PERCENTAGES ONLY (e.g. '50% overall' or '50% overall and at least 40% in every Exit Level Outcome'). Never quote absolute mark totals - the system computes those from the paper.",
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
  const sourceDescription = input.sourceDescription ?? "as published by SAQA";
  return `You are drafting a QCTO ${registrationLabel} final assessment paper for the qualification "${input.qualificationTitle}".

The paper must be built directly from this qualification's registered Exit Level Outcomes (ELOs) and Associated Assessment Criteria (ACs), ${sourceDescription}. Draft a full assessment instrument: a mix of question types (multiple choice, short answer, long answer, practical/portfolio upload) appropriate to what each outcome actually requires a learner to demonstrate - don't force every outcome into the same question type. Every question must be traceable to a specific ELO/AC via its eloRef field. Aim for enough questions to cover every ELO at least once within the given time allocation; it's fine to leave a gap uncovered rather than write a weak or unsupported question - note any gap in coverageNotes instead.

Cognitive demand: ${bloomGuidanceForNqf(input.nqfLevel ?? null)} Label every question with the Bloom's level it genuinely demands (a recall question is "remember" even if the topic is advanced), and do not let recall-only questions dominate a paper at this level. Cover every Assessment Criterion, not only every Exit Level Outcome; where one question can honestly evidence several criteria, say which one it primarily evidences in acRef.

Time allocation for the whole paper: ${input.timeAllocationMinutes} minutes. Size the paper to that time: roughly one mark per 1.5-2 minutes of writing time, so about ${Math.round(input.timeAllocationMinutes / 1.75)} marks in total across ${Math.max(8, Math.min(40, Math.round(input.timeAllocationMinutes / 6)))} or so questions. Keep rubrics specific but compact (3-6 marking points each) - the paper must be complete; never stop part-way through the question list.
Permitted materials: ${input.permittedMaterials.length > 0 ? input.permittedMaterials.join(", ") : "none specified"}.

EXIT LEVEL OUTCOMES (${sourceDescription}):
${input.exitLevelOutcomes.map((elo, i) => `${i + 1}. ${elo}`).join("\n")}

ASSOCIATED ASSESSMENT CRITERIA (${sourceDescription}):
${input.assessmentCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n")}

Write a real model answer or rubric for every question - this is what an Assessor and an AI marking engine will use to mark real learner submissions, so it needs to be specific and usable, not a placeholder. Call submit_instrument with the result.`;
}

// Drafts a full instrument from a set of Exit Level Outcomes / Assessment
// Criteria, regardless of where they came from - a SAQA qualification page
// (input.sourceDescription left as the default) or an uploaded QCTO document
// (pass a sourceDescription describing that instead). Kept under its
// original name for the existing SAQA call site; genuinely source-agnostic.
export async function generateInstrumentFromSaqa(
  input: GenerateInstrumentInput
): Promise<GeneratedInstrument> {
  const anthropic = getClient();

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 20000,
    tools: [SUBMIT_TOOL],
    tool_choice: { type: "tool", name: "submit_instrument" },
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
      acRef?: string;
      bloomLevel?: BloomLevel;
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
    acRef: q.acRef,
    bloomLevel: q.bloomLevel,
  }));

  return {
    questions,
    passMarkOrCompetencyRule: raw.passMarkOrCompetencyRule,
    coverageNotes: raw.coverageNotes,
  };
}

// Alias used by the QCTO-document-upload intake path (routes/instruments.ts)
// - same engine, just named for what it actually does rather than the first
// source it was built for.
export const generateInstrumentFromOutcomes = generateInstrumentFromSaqa;
