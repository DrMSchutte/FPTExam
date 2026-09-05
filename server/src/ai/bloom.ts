import type { BloomLevel } from "../types.js";

// Expected share of marks at the higher-order levels (analyse / evaluate /
// create) for a QCTO final assessment by NQF level. These are the working
// bands FPT Academy applies when judging whether a paper's cognitive demand
// matches the qualification; they are guidance, not a hard gate - the
// Administrator sees the actual figure against the band.
export function expectedHigherOrderShare(nqfLevel: number | null): { min: number; max: number; basis: string } {
  if (nqfLevel === null) return { min: 25, max: 60, basis: "NQF level unknown - general QCTO occupational band applied" };
  if (nqfLevel <= 2) return { min: 5, max: 25, basis: `NQF ${nqfLevel}: mostly recall and understanding, some application` };
  if (nqfLevel <= 4) return { min: 15, max: 40, basis: `NQF ${nqfLevel}: application-led, with some analysis` };
  if (nqfLevel <= 6) return { min: 30, max: 60, basis: `NQF ${nqfLevel}: application and analysis dominate; evaluation expected` };
  return { min: 45, max: 80, basis: `NQF ${nqfLevel}: analysis, evaluation and creation should carry most marks` };
}

export function bloomGuidanceForNqf(nqfLevel: number | null): string {
  const band = expectedHigherOrderShare(nqfLevel);
  return `This qualification is at ${nqfLevel ? `NQF Level ${nqfLevel}` : "an unstated NQF level (assume a mid-level occupational qualification)"}. Aim for roughly ${band.min}-${band.max}% of the marks at the higher-order Bloom's levels (analyse, evaluate, create), the remainder spread across remember, understand and apply - ${band.basis}.`;
}

export const HIGHER_ORDER: BloomLevel[] = ["analyse", "evaluate", "create"];
