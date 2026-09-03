import Anthropic from "@anthropic-ai/sdk";

// Mirrors the shape produced by integrations/saqa/fetchQualification.ts, but
// sourced from an uploaded QCTO document instead of a scraped SAQA page.
// Unlike the SAQA page (which has consistent section headings we can anchor
// on with plain text extraction), a QCTO Qualification Assessment
// Specifications document has no guaranteed structure - so this step hands
// the raw extracted text straight to the AI and asks it to identify and pull
// out the outcomes/criteria itself, rather than trying to regex/heading-match
// an arbitrary document layout.

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

export class DocumentOutcomeExtractionError extends Error {}

export interface ExtractedOutcomes {
  exitLevelOutcomes: string[];
  assessmentCriteria: string[];
}

const SUBMIT_TOOL = {
  name: "submit_outcomes",
  description:
    "Submit the Exit Level Outcomes and Associated Assessment Criteria (or the closest equivalent the document actually uses) identified in the document.",
  input_schema: {
    type: "object" as const,
    properties: {
      found: {
        type: "boolean",
        description:
          "Whether the document actually contains identifiable learning outcomes / assessment criteria (or an equivalent, e.g. 'competencies', 'exit outcomes', 'performance criteria').",
      },
      exitLevelOutcomes: {
        type: "array",
        items: { type: "string" },
        description: "Each outcome as a self-contained plain-text statement, one per array entry.",
      },
      assessmentCriteria: {
        type: "array",
        items: { type: "string" },
        description: "Each criterion as a self-contained plain-text statement, one per array entry.",
      },
      notFoundReason: {
        type: "string",
        description: "If found=false, a plain-language explanation of what the document contains instead.",
      },
    },
    required: ["found", "exitLevelOutcomes", "assessmentCriteria"],
  },
};

// QCTO documents don't reliably fit in a single call's context at arbitrary
// length; keep a generous but bounded excerpt rather than failing outright on
// a long document.
const MAX_CHARS = 60000;

export async function extractOutcomesFromDocumentText(
  rawText: string,
  qualificationTitle: string
): Promise<ExtractedOutcomes> {
  const anthropic = getClient();
  const excerpt = rawText.length > MAX_CHARS ? rawText.slice(0, MAX_CHARS) : rawText;

  const prompt = `This is the extracted text of a document uploaded for the qualification "${qualificationTitle}", intended to be a QCTO Qualification Assessment Specifications (QAS) document, an External Assessment Specifications document, or similar - the kind of document a QCTO Assessment Quality Partner issues describing what a final assessment for this qualification must cover.

Read the text below and identify:
- The Exit Level Outcomes (ELOs) - or whatever this document calls the top-level things a learner must be able to do (may be labelled "exit level outcomes", "learning outcomes", "competencies", or similar).
- The Associated Assessment Criteria (ACs) - the more specific, checkable criteria under each outcome (may be labelled "assessment criteria", "performance criteria", or similar).

If the document doesn't actually contain anything resembling outcomes/criteria (e.g. it's the wrong document, or just a cover page), say so via found=false rather than inventing content.

DOCUMENT TEXT:
"""
${excerpt}
"""

Call submit_outcomes with the result.`;

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4000,
    tools: [SUBMIT_TOOL],
    tool_choice: { type: "tool", name: "submit_outcomes" },
    messages: [{ role: "user", content: prompt }],
  });

  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolUse) {
    throw new DocumentOutcomeExtractionError(
      "The AI did not return a structured response (no tool_use block)."
    );
  }

  const raw = toolUse.input as {
    found: boolean;
    exitLevelOutcomes: string[];
    assessmentCriteria: string[];
    notFoundReason?: string;
  };

  if (!raw.found || raw.exitLevelOutcomes.length === 0) {
    throw new DocumentOutcomeExtractionError(
      raw.notFoundReason
        ? `Could not find outcomes/assessment criteria in this document: ${raw.notFoundReason}`
        : "Could not find any outcomes or assessment criteria in this document."
    );
  }

  return {
    exitLevelOutcomes: raw.exitLevelOutcomes,
    assessmentCriteria: raw.assessmentCriteria,
  };
}
