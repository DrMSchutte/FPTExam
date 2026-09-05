import type { BloomLevel, StandardVerdict, CoverageStatus } from "@shared/types";
import { Badge } from "./ui";

// Small shared pieces for the assessment-standard check.

export const BLOOM_ORDER: BloomLevel[] = ["remember", "understand", "apply", "analyse", "evaluate", "create"];
export const BLOOM_LABEL: Record<BloomLevel, string> = {
  remember: "Remember",
  understand: "Understand",
  apply: "Apply",
  analyse: "Analyse",
  evaluate: "Evaluate",
  create: "Create",
};
// Lower-order levels in blue, higher-order in green - the eye reads the split at once.
export const BLOOM_TONE: Record<BloomLevel, "blue" | "teal" | "green"> = {
  remember: "blue",
  understand: "blue",
  apply: "teal",
  analyse: "green",
  evaluate: "green",
  create: "green",
};

export function BloomBadge({ level }: { level: BloomLevel | undefined }) {
  if (!level) return <Badge tone="gray">Bloom's not set</Badge>;
  return <Badge tone={BLOOM_TONE[level]}>{BLOOM_LABEL[level]}</Badge>;
}

export function VerdictBadge({ verdict }: { verdict: StandardVerdict | null | undefined }) {
  if (verdict === "meets_standard") return <Badge tone="green">Meets standard</Badge>;
  if (verdict === "meets_with_minor_gaps") return <Badge tone="amber">Minor gaps</Badge>;
  if (verdict === "does_not_meet") return <Badge tone="amber">Does not meet</Badge>;
  return <Badge tone="gray">Not checked</Badge>;
}

export function CoverageDot({ status }: { status: CoverageStatus }) {
  const cls = status === "covered" ? "bg-brand-600" : status === "partial" ? "bg-amber-400" : "bg-red-500";
  const label = status === "covered" ? "Covered" : status === "partial" ? "Partial" : "Not covered";
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold whitespace-nowrap">
      <span className={"h-2.5 w-2.5 rounded-full " + cls} />
      {label}
    </span>
  );
}
