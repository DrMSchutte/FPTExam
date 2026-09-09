import type { ReactNode } from "react";
import type { IntakeRoute, IntakeStatus, AssessmentInstrument } from "@shared/types";
import { Badge } from "./ui";
import type { BadgeTone } from "./ui";

// The four ways an assessment enters FPT Exam (docs/restructure-2026-09-05.md §2,
// rule of 9 Sep 2026). Shared by Set up an Assessment, the assessment page,
// Results and anywhere else the route is shown.

export interface RouteMeta {
  key: IntakeRoute;
  label: string; // the badge
  question: string; // the chooser card title
  answer: string; // the chooser card body: where the paper comes from
  tone: BadgeTone;
  builtHere: boolean;
  curriculaBuilder: boolean;
  cbKind?: "qcto" | "other";
}

export const ROUTES: RouteMeta[] = [
  {
    key: "qcto_curricula_builder",
    label: "Curricula Builder · QCTO",
    question: "QCTO FISA / EISA",
    answer: "An occupational qualification under the QCTO rules. The paper is linked in from Curricula Builder — it is never built here.",
    tone: "green",
    builtHere: false,
    curriculaBuilder: true,
    cbKind: "qcto",
  },
  {
    key: "legacy_saqa",
    label: "Legacy FISA · SAQA",
    question: "Legacy FISA",
    answer: "A legacy (SAQA-registered) qualification, e.g. ND: Payroll Administration Services. Linked to SAQA; the paper is drafted here from its exit level outcomes and assessment criteria.",
    tone: "blue",
    builtHere: true,
    curriculaBuilder: false,
  },
  {
    key: "built_here",
    label: "Built here",
    question: "Build from scratch",
    answer: "Anything outside the QCTO rules — an internal test, short course or skills programme. Give the title and your own outcomes and criteria, or upload a document, and the paper is built here.",
    tone: "teal",
    builtHere: true,
    curriculaBuilder: false,
  },
  {
    key: "curricula_builder_other",
    label: "Curricula Builder · other",
    question: "Other course from Curricula Builder",
    answer: "CPD and other courses created on Curricula Builder. Linked in as built there.",
    tone: "gray",
    builtHere: false,
    curriculaBuilder: true,
    cbKind: "other",
  },
];

export const routeMeta = (key: IntakeRoute): RouteMeta => ROUTES.find((r) => r.key === key) ?? ROUTES[2];
export const isCurriculaBuilderRoute = (key: IntakeRoute) => routeMeta(key).curriculaBuilder;

export function RouteBadge({ route, small = false }: { route: IntakeRoute; small?: boolean }) {
  const m = routeMeta(route);
  return (
    <span className={small ? "inline-flex [&>.badge]:text-[10.5px] [&>.badge]:py-0" : "inline-flex"}>
      <Badge tone={m.tone}>{m.label}</Badge>
    </span>
  );
}

export function GateBadge({ status }: { status: IntakeStatus }) {
  if (status === "ready") return <Badge tone="green">Ready to schedule</Badge>;
  if (status === "override") return <Badge tone="blue">Override · schedulable</Badge>;
  if (status === "blocked") return <Badge tone="amber">Blocked</Badge>;
  return <Badge tone="gray">Checking…</Badge>;
}

// How the paper's content came to exist, as distinct from the route it came in on.
export function sourceWord(source: AssessmentInstrument["source"]): string {
  switch (source) {
    case "uploaded_paper": return "Existing paper uploaded";
    case "curricula_builder": return "Linked from Curricula Builder";
    case "ai_generated": return "AI-drafted from SAQA";
    case "qcto_upload": return "AI-drafted from outcomes";
    default: return "Entered manually";
  }
}

export function RouteCard({
  meta,
  selected,
  onSelect,
  children,
}: {
  meta: RouteMeta;
  selected: boolean;
  onSelect: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={
        "text-left rounded-xl border p-4 transition flex flex-col gap-1.5 h-full " +
        (selected ? "border-brand-600 bg-brand-50/50 shadow-btn" : "border-line bg-surface hover:border-line-strong hover:bg-surface-2")
      }
    >
      <div className="flex items-center justify-between gap-2">
        <p className="font-display font-bold text-[14px] leading-tight">{meta.question}</p>
        <span className={"h-4 w-4 shrink-0 rounded-full border-2 grid place-items-center " + (selected ? "border-brand-600" : "border-line-strong")}>
          {selected && <span className="h-2 w-2 rounded-full bg-brand-600" />}
        </span>
      </div>
      <p className="text-[12.5px] text-ink-muted leading-snug">{meta.answer}</p>
      <div className="mt-auto pt-1 flex items-center gap-2">
        <Badge tone={meta.tone}>{meta.builtHere ? "Built here" : "Linked in"}</Badge>
        {children}
      </div>
    </button>
  );
}
