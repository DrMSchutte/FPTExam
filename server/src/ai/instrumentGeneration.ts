import type Anthropic from "@anthropic-ai/sdk";
import { createLongMessage, MODEL, type ProgressHook } from "./longCall.js";
import { randomUUID } from "node:crypto";
import type { Question, QuestionType, BloomLevel } from "../types.js";
import { BLUEPRINT, BLUEPRINT_TEXT } from "./paperBlueprint.js";
import { bloomGuidanceForNqf } from "./bloom.js";



export interface GenerateInstrumentInput {
  qualificationTitle: string;
  qctoRegistrationType: "fisa" | "eisa" | "non_qcto";
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
              enum: ["mcq", "short_answer", "long_answer"],
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
              description: "The model answer (for mcq/short_answer) or rubric criteria (for long_answer). Never shown to the learner.",
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

// Every question is answered inside a proctored sitting: closed-book, no
// internet, no files, no leaving the exam screen, a fixed clock. Anything that
// needs research, a workplace, other people or an upload is an assignment, not
// an exam question, and is refused here and caught by the standard check.
export const SITTING_RULE = `This is a PROCTORED, CLOSED-BOOK EXAMINATION sat in one timed session on a locked screen. Every question must be fully answerable there and then from the learner's own knowledge and the information given in the question. Never set a question that requires research, the internet, textbooks or other sources; workplace observation, interviews or data from the learner's employer; producing, uploading or attaching a document, file, portfolio or artefact; or work over days or weeks. Every answer is typed into a text box, so never ask the learner to draw, sketch or plot anything (a chart, diagram, organogram, graph) - ask them to describe, list or tabulate it in words and figures instead. Practical competence is assessed through scenarios, case studies, worked calculations, given data sets and "explain how you would..." tasks the learner writes up in the answer box. A question that breaks this rule is an assignment, not an exam question, and fails the paper.`;

function buildPrompt(input: GenerateInstrumentInput): string {
  const sourceDescription = input.sourceDescription ?? "as published by SAQA";
  const opening =
    input.qctoRegistrationType === "non_qcto"
      ? `You are drafting a summative assessment paper for "${input.qualificationTitle}". This assessment falls outside the QCTO's regulated FISA/EISA rules, but it is a formal proctored assessment and must be built to the same professional standard: valid, fair, reliable and traceable to its outcomes.

The paper must be built directly from the assessment's stated outcomes and assessment criteria, ${sourceDescription}.`
      : `You are drafting a QCTO ${input.qctoRegistrationType === "eisa" ? "EISA" : "FISA"} final assessment paper for the qualification "${input.qualificationTitle}".

The paper must be built directly from this qualification's registered Exit Level Outcomes (ELOs) and Associated Assessment Criteria (ACs), ${sourceDescription}.`;
  const shortTime = input.timeAllocationMinutes < BLUEPRINT.minimumMinutes;
  return `${opening} Draft the full examination paper.

${BLUEPRINT_TEXT}

${SITTING_RULE} Every question must be traceable to a specific ELO/AC via its eloRef field. Spread the ${BLUEPRINT.mcq.min}+ multiple-choice questions so that every ELO is touched; use Section B to check depth of knowledge on the criteria that matter most; use Section C to make the learner integrate outcomes - a scenario that pulls two or three ELOs together is exactly what a final integrated assessment is for. Cover every Assessment Criterion, not only every Exit Level Outcome; where one question honestly evidences several criteria, say which one it primarily evidences in acRef. Note any outcome you could not evidence in coverageNotes rather than writing a weak question for it.

Cognitive demand: ${bloomGuidanceForNqf(input.nqfLevel ?? null)} Label every question with the Bloom's level it genuinely demands (a recall question is "remember" even if the topic is advanced).

Time allocation for the whole paper: ${input.timeAllocationMinutes} minutes. The paper shape above comes to about 110 marks (20 + 6×5 + 6×10), which suits ${BLUEPRINT.recommendedMinutes} minutes.${shortTime ? ` ${input.timeAllocationMinutes} minutes is too short for that shape: keep the section counts, use the lower end of the mark ranges, and say in coverageNotes that the time allocation should be at least ${BLUEPRINT.minimumMinutes} minutes.` : " Use the mark ranges so the total sits at or under one mark per minute."} Keep rubrics specific but compact (3-6 marking points each; comprehensive questions may have more) - the paper must be complete; never stop part-way through the question list.
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
  input: GenerateInstrumentInput,
  onProgress?: ProgressHook
): Promise<GeneratedInstrument> {

  const message = await createLongMessage({
    model: MODEL,
    max_tokens: 20000,
    tools: [SUBMIT_TOOL],
    tool_choice: { type: "tool", name: "submit_instrument" },
    messages: [{ role: "user", content: buildPrompt(input) }],
  }, onProgress);

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
