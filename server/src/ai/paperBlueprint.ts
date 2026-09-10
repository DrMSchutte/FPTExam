import type { Question } from "../types.js";

// The shape of an FPT Academy exam paper (decided 10 Sep 2026). A Final
// Integrated Summative Assessment is an examination, not a practical:
//
//   Section A  at least 20 multiple-choice questions                    (1 mark each)
//   Section B  6 knowledge-and-depth questions - identify, list,
//              explain, describe (short written answers)                (4-6 marks each)
//   Section C  6 comprehensive questions - evaluate, advise, make the
//              connection, apply to a scenario, write a fuller answer
//              (analysis and critical thinking)                          (8-12 marks each)
//
// No practical activities, uploads or workplace tasks - those are assessed in
// the workplace. Drafting builds to this shape; the standard check measures a
// paper against it; "Fix the gaps" restructures towards it.

export const BLUEPRINT = {
  mcq: { min: 20, marks: 1 },
  knowledge: { count: 6, marks: [4, 6] as const, bloom: ["remember", "understand", "apply"] as const },
  comprehensive: { count: 6, marks: [8, 12] as const, bloom: ["analyse", "evaluate", "create"] as const },
  // 20 + 6×5 + 6×10 = 110 marks; at one mark per 1.5 minutes that is about 3 hours.
  recommendedMinutes: 180,
  minimumMinutes: 110,
};

export const BLUEPRINT_TEXT = `THE SHAPE OF THE PAPER (FPT Academy exam standard - not negotiable):
Section A - MULTIPLE CHOICE: at least ${BLUEPRINT.mcq.min} multiple-choice questions, ${BLUEPRINT.mcq.marks} mark each, four options, one correct, no "all of the above". Spread across the outcomes; recall and understanding level.
Section B - KNOWLEDGE AND DEPTH: exactly ${BLUEPRINT.knowledge.count} short-answer questions (type short_answer) that ask the learner to identify, list, explain, describe or define; ${BLUEPRINT.knowledge.marks[0]}-${BLUEPRINT.knowledge.marks[1]} marks each; Bloom's remember, understand or apply.
Section C - COMPREHENSIVE: exactly ${BLUEPRINT.comprehensive.count} long-answer questions (type long_answer) built on a scenario, case or given data, where the learner must evaluate, give advice, make the connection between concepts, justify a decision or write a fuller structured answer - critical thinking and analysis; ${BLUEPRINT.comprehensive.marks[0]}-${BLUEPRINT.comprehensive.marks[1]} marks each; Bloom's analyse, evaluate or create.
Order the questions A then B then C, ids a1..a20+, b1..b6, c1..c6. Every question is answered by typing in the sitting; there are no practical activities, uploads or workplace tasks - practical competence is assessed in the workplace, not in this paper.`;

export interface BlueprintProfile {
  mcq: number;
  knowledge: number;
  comprehensive: number;
  comprehensiveLowOrder: number; // long answers labelled remember/understand
  shortfalls: string[];
  meets: boolean;
}

export function blueprintProfile(questions: Pick<Question, "type" | "bloomLevel">[]): BlueprintProfile {
  const mcq = questions.filter((q) => q.type === "mcq").length;
  const knowledge = questions.filter((q) => q.type === "short_answer").length;
  const comp = questions.filter((q) => q.type === "long_answer");
  const comprehensiveLowOrder = comp.filter((q) => q.bloomLevel === "remember" || q.bloomLevel === "understand").length;
  const shortfalls: string[] = [];
  if (mcq < BLUEPRINT.mcq.min) shortfalls.push(`${mcq} multiple-choice question${mcq === 1 ? "" : "s"} - the paper needs at least ${BLUEPRINT.mcq.min}`);
  if (knowledge < BLUEPRINT.knowledge.count) shortfalls.push(`${knowledge} knowledge-and-depth (short answer) question${knowledge === 1 ? "" : "s"} - the paper needs ${BLUEPRINT.knowledge.count}`);
  if (comp.length < BLUEPRINT.comprehensive.count) shortfalls.push(`${comp.length} comprehensive (long answer) question${comp.length === 1 ? "" : "s"} - the paper needs ${BLUEPRINT.comprehensive.count}`);
  if (comprehensiveLowOrder > 0) shortfalls.push(`${comprehensiveLowOrder} comprehensive question${comprehensiveLowOrder === 1 ? "" : "s"} only ask${comprehensiveLowOrder === 1 ? "s" : ""} for recall or understanding - Section C must demand analysis, evaluation or advice`);
  return { mcq, knowledge, comprehensive: comp.length, comprehensiveLowOrder, shortfalls, meets: shortfalls.length === 0 };
}

export const blueprintLine = (p: BlueprintProfile) => `${p.mcq} multiple choice · ${p.knowledge} knowledge · ${p.comprehensive} comprehensive (standard: ${BLUEPRINT.mcq.min}+ · ${BLUEPRINT.knowledge.count} · ${BLUEPRINT.comprehensive.count})`;
