import type Anthropic from "@anthropic-ai/sdk";
import { createLongMessage, MODEL } from "./longCall.js";

// Tidies a list of outcomes and criteria into what the standard check and the
// drafting engine need: one assessable competence statement per line. SAQA's
// legacy pages, in particular, come through as preambles ("On achieving this
// qualification the learner will be able to:"), run-on lists of twenty
// competencies in one entry, exit-point and credit-transfer notes, and
// procedural text about integrated assessment - none of which a paper can
// "cover". This keeps every real competence, splits run-ons, and drops the rest.

export interface NormalisedOutcomes {
  exitLevelOutcomes: string[];
  assessmentCriteria: string[];
  changed: boolean;
  notes: string;
}

const SUBMIT_TOOL = {
  name: "submit_normalised_outcomes",
  description: "Submit the cleaned list of exit level outcomes and assessment criteria.",
  input_schema: {
    type: "object" as const,
    properties: {
      exitLevelOutcomes: { type: "array", items: { type: "string" }, description: "One assessable competence per entry, in the original order, original wording kept (light trimming only)." },
      assessmentCriteria: { type: "array", items: { type: "string" }, description: "One checkable criterion per entry, original wording kept." },
      notes: { type: "string", description: "One or two sentences: what was split, what was dropped and why." },
    },
    required: ["exitLevelOutcomes", "assessmentCriteria", "notes"],
  },
};

export async function normaliseOutcomes(p: { qualificationTitle: string; exitLevelOutcomes: string[]; assessmentCriteria: string[] }): Promise<NormalisedOutcomes> {
  const prompt = `Below are the exit level outcomes and assessment criteria for "${p.qualificationTitle}" exactly as they were read from the source (SAQA record or document). Clean the two lists so that each entry is ONE assessable competence statement:

- Split any entry that runs several competences together into separate entries, keeping the original wording of each.
- Remove preambles and headings ("On achieving this qualification, the learner will be able to:", "In particular, assessors should check that…"), exit-point and credit-transfer notes, statements about how assessment must be conducted, international comparability, and anything else that is not a competence a learner demonstrates.
- Remove exact duplicates. Keep the original order otherwise.
- Do not invent, reword or merge competences. If the source has no real criteria, return an empty criteria list rather than inventing any.

EXIT LEVEL OUTCOMES AS READ (${p.exitLevelOutcomes.length}):
${p.exitLevelOutcomes.map((e, i) => `${i + 1}. ${e}`).join("\n")}

ASSESSMENT CRITERIA AS READ (${p.assessmentCriteria.length}):
${p.assessmentCriteria.map((a, i) => `${i + 1}. ${a}`).join("\n") || "(none)"}

Call submit_normalised_outcomes.`;

  const message = await createLongMessage({
    model: MODEL,
    max_tokens: 6000,
    tools: [SUBMIT_TOOL],
    tool_choice: { type: "tool", name: "submit_normalised_outcomes" },
    messages: [{ role: "user", content: prompt }],
  });
  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const raw = toolUse?.input as { exitLevelOutcomes?: string[]; assessmentCriteria?: string[]; notes?: string } | undefined;
  const clean = (xs?: string[]) => (xs ?? []).map((x) => String(x).trim()).filter(Boolean);
  const elos = clean(raw?.exitLevelOutcomes);
  const acs = clean(raw?.assessmentCriteria);
  if (elos.length === 0) {
    // Never hand back nothing: fall back to what came in.
    return { exitLevelOutcomes: p.exitLevelOutcomes, assessmentCriteria: p.assessmentCriteria, changed: false, notes: "The list could not be tidied; kept as read." };
  }
  const changed = JSON.stringify(elos) !== JSON.stringify(p.exitLevelOutcomes) || JSON.stringify(acs) !== JSON.stringify(p.assessmentCriteria);
  return { exitLevelOutcomes: elos, assessmentCriteria: acs, changed, notes: raw?.notes ?? "" };
}

// Heuristic: does this list look like it needs tidying? Used to decide whether
// to spend the AI call at SAQA fetch time.
export function looksMalformed(elos: string[], acs: string[]): boolean {
  const longEntry = (s: string) => s.length > 220;
  const preamble = /will be able to:?\s*$|assessors should check|exit points?|credit(s)? (towards|transfer)|integrated assessment|international comparability/i;
  return elos.length < 3 || elos.some(longEntry) || elos.some((e) => preamble.test(e)) || acs.some((a) => preamble.test(a) || longEntry(a));
}
