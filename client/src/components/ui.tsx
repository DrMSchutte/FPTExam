import type { ReactNode } from "react";

// Small shared building blocks matching the approved FPT admin design.
// Styling lives in index.css (@layer components) so these stay thin.

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-5 mb-6">
      <div>
        <h1 className="text-[21px] font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="text-[13.5px] text-ink-muted mt-0.5">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={"card " + className}>{children}</section>;
}

export function CardHead({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <div className="card-head">
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

export function Notice({ kind, children }: { kind: "error" | "success"; children: ReactNode }) {
  const cls =
    kind === "error"
      ? "bg-red-50 border-red-200 text-red-700"
      : "bg-brand-50 border-brand-100 text-brand-800";
  return <p className={"rounded-lg border px-3.5 py-2.5 text-sm mb-5 " + cls}>{children}</p>;
}

export type BadgeTone = "green" | "blue" | "teal" | "amber" | "gray";
const BADGE_TONES: Record<BadgeTone, string> = {
  green: "bg-brand-50 text-brand-700",
  blue: "bg-blue-50 text-blue-700",
  teal: "bg-teal-50 text-teal-700",
  amber: "bg-amber-50 text-amber-700",
  gray: "bg-surface-2 text-ink-muted border border-line badge-plain",
};

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={"badge " + BADGE_TONES[tone]}>{children}</span>;
}

export function Pill({ tone, children }: { tone: "eisa" | "fisa"; children: ReactNode }) {
  return (
    <span className={"pill " + (tone === "eisa" ? "bg-brand-50 text-brand-700" : "bg-blue-50 text-blue-700")}>
      {children}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-6 text-center text-sm text-ink-faint">{children}</p>;
}

export function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className="h-[15px] w-[15px]">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
