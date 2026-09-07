import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import type { Question, QuestionType, BloomLevel } from "../types.js";

// Paper Extraction Engine (docs/restructure-2026-09-05.md §2).
//
// FPT Exam does not author papers. An Administrator uploads the exam paper and
// its memorandum / marking guide as issued (Word or PDF, one file or two) and
// this engine reads them into the structured form the rest of the system needs:
// one entry per question with its type, marks, prompt, options (MCQ), model
// answer or rubric, the outcome/criterion it evidences where the paper says so,
// and its Bloom's level. It also lifts the time allocation and pass rule if the
// paper states them. Nothing is invented: a question whose memo is missing is
// returned with an empty rubric and flagged, so the Administrator sees it.

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929";
const MAX_CHARS = 180_000; // ~45k tokens of document text - a long paper + memo fits comfortably

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set - required to read an uploaded paper.");
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

export class PaperExtractionError extends Error {}

export interface PaperExtractionInput {
  qualificationTitle: string;
  paperText: string; // the question paper (may already contain the memo)
  memoText?: string; // the memorandum / marking guide, if uploaded separately
  paperFilename: string;
  memoFilename?: string;
}

export interface ExtractedPaper {
  questions: Question[];
  timeAllocationMinutes: number | null;
  passMarkOrCompetencyRule: string | null;
  totalMarksStated: number | null;
  paperTitle: string | null;
  warnings: string[]; // e.g. "Q7 has no memo entry", "marks on paper (95) differ from memo (100)"
}

const SUBMIT_TOOL = {
  name: "submit_extracted_paper",
  description: "Submit the paper read into structured questions with their marking guide.",
  input_schema: {
    type: "object" as const,
    properties: {
      paperTitle: { type: "string", description: "The paper's own title/heading as printed, or empty." },
      timeAllocationMinutes: { type: "number", description: "Time allowed as stated on the paper, in minutes; 0 if not stated." },
      totalMarksStated: { type: "number", description: "Total marks as stated on the paper; 0 if not stated." },
      passMarkOrCompetencyRule: {
        type: "string",
        description: "Pass rule as stated on the paper or memo, in PERCENTAGES (e.g. '50% overall'); empty if not stated.",
      },
      questions: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            number: { type: "string", description: "The question number as printed, e.g. '1', '2.3', 'Section B Q4'." },
            type: { type: "string", enum: ["mcq", "short_answer", "long_answer", "practical_upload"] },
            prompt: { type: "string", description: "The full question text as printed, including any scenario/case study it depends on (repeat the scenario if several questions share it)." },
            maxMark: { type: "number" },
            options: { type: "array", items: { type: "string" }, description: "MCQ options only, in order, without the letter prefixes." },
            modelAnswerOrRubric: {
              type: "string",
              description: "The memo/marking guide for this question, verbatim or faithfully condensed, with the mark allocation per point. Empty string if the memo has no entry for it.",
            },
            eloRef: { type: "string", description: "The Exit Level Outcome / module / unit standard the paper or memo says this question assesses, if stated; else empty." },
            acRef: { type: "string", description: "The Assessment Criterion the paper or memo cites for this question, if stated; else empty." },
            bloomLevel: {
              type: "string",
              enum: ["remember", "understand", "apply", "analyse", "evaluate", "create"],
              description: "Your honest reading of the cognitive demand of the question.",
            },
          },
          required: ["number", "type", "prompt", "maxMark", "modelAnswerOrRubric", "bloomLevel"],
        },
      },
      warnings: {
        type: "array",
        items: { type: "string" },
        description: "Anything the Administrator must know: questions with no memo, mark totals that don't reconcile, illegible or ambiguous parts, sub-questions you merged or split.",
      },
    },
    required: ["questions", "warnings", "timeAllocationMinutes", "totalMarksStated", "passMarkOrCompetencyRule", "paperTitle"],
  },
};

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "\n\n[... document truncated for length ...]" : text;
}

function buildPrompt(input: PaperExtractionInput): string {
  const memoBlock = input.memoText
    ? `\n\n===== MEMORANDUM / MARKING GUIDE (${input.memoFilename}) =====\n${clip(input.memoText, MAX_CHARS / 2)}`
    : "";
  return `You are reading an existing QCTO assessment paper for "${input.qualificationTitle}" into a structured form so it can be sat on screen and marked consistently. Do not write new questions, do not improve the paper, do not fill gaps with your own content.

Rules:
- One entry per markable question. Where a question has sub-questions with their own marks (2.1, 2.2 ...), make each sub-question its own entry with the parent's scenario repeated in the prompt, so it can be answered and marked on its own.
- Question type: mcq for multiple choice; short_answer for a few lines; long_answer for essays, calculations, case-study responses; practical_upload where the learner must produce a document/artefact/file.
- Marks: exactly as printed. If the paper and memo disagree, use the memo and add a warning.
- Rubric: take it from the memo. If the memo has no entry for a question, leave modelAnswerOrRubric empty and add a warning naming the question - never invent a memo.
- eloRef / acRef: only if the paper or memo states the outcome, module, unit standard or criterion; otherwise empty.
- Keep the printed question numbering in "number".
- Use British/South African English and keep the paper's wording.

===== QUESTION PAPER (${input.paperFilename}) =====
${clip(input.paperText, input.memoText ? MAX_CHARS / 2 : MAX_CHARS)}${memoBlock}

Call submit_extracted_paper with every question in order.`;
}

export async function extractPaper(input: PaperExtractionInput): Promise<ExtractedPaper> {
  if (input.paperText.trim().length < 200) {
    throw new PaperExtractionError("The uploaded paper has almost no readable text. If it is a scanned PDF, it needs OCR first.");
  }
  const anthropic = getClient();
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 20000,
    tools: [SUBMIT_TOOL],
    tool_choice: { type: "tool", name: "submit_extracted_paper" },
    messages: [{ role: "user", content: buildPrompt(input) }],
  });
  if (message.stop_reason === "max_tokens") {
    throw new PaperExtractionError("The paper is too long to read in one pass - split it into sections and upload each as its own paper.");
  }
  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) throw new PaperExtractionError("The AI did not return a structured paper.");

  const raw = toolUse.input as {
    paperTitle?: string;
    timeAllocationMinutes?: number;
    totalMarksStated?: number;
    passMarkOrCompetencyRule?: string;
    questions: Array<{
      number: string;
      type: QuestionType;
      prompt: string;
      maxMark: number;
      options?: string[];
      modelAnswerOrRubric: string;
      eloRef?: string;
      acRef?: string;
      bloomLevel?: BloomLevel;
    }>;
    warnings?: string[];
  };
  if (!raw.questions || raw.questions.length === 0) {
    throw new PaperExtractionError("No questions could be identified in the uploaded document.");
  }

  const warnings = [...(raw.warnings ?? [])];
  const questions: Question[] = raw.questions.map((q) => {
    const prompt = q.number ? `${q.number}. ${q.prompt}`.replace(/^(\S+)\. \1[.)]?\s*/, "$1. ") : q.prompt;
    if (!q.modelAnswerOrRubric?.trim()) warnings.push(`Question ${q.number} has no marking guide - it cannot be AI-marked until one is added.`);
    return {
      id: randomUUID(),
      type: q.type,
      prompt,
      maxMark: Math.max(0, Number(q.maxMark) || 0),
      options: q.type === "mcq" ? q.options : undefined,
      modelAnswerOrRubric: q.modelAnswerOrRubric?.trim() || undefined,
      eloRef: q.eloRef?.trim() || undefined,
      acRef: q.acRef?.trim() || undefined,
      bloomLevel: q.bloomLevel,
    };
  });

  const total = questions.reduce((s, q) => s + q.maxMark, 0);
  const stated = raw.totalMarksStated && raw.totalMarksStated > 0 ? raw.totalMarksStated : null;
  if (stated && stated !== total) warnings.push(`Questions add up to ${total} marks but the paper states ${stated}.`);

  return {
    questions,
    timeAllocationMinutes: raw.timeAllocationMinutes && raw.timeAllocationMinutes > 0 ? Math.round(raw.timeAllocationMinutes) : null,
    passMarkOrCompetencyRule: raw.passMarkOrCompetencyRule?.trim() || null,
    totalMarksStated: stated,
    paperTitle: raw.paperTitle?.trim() || null,
    warnings: [...new Set(warnings)],
  };
}
