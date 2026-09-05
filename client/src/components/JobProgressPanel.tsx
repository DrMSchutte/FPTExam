import { useEffect, useState } from "react";
import type { JobProgress } from "@shared/types";

// Stage-by-stage view of a long-running server job (drafting a paper, the
// assessment-standard check). `stages` are the labels the server will report
// in order; the current one comes from the job's progress record.
export default function JobProgressPanel({
  stages,
  progress,
  active,
  title,
}: {
  stages: string[];
  progress: JobProgress | null;
  active: boolean;
  title: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  if (!active) return null;

  const step = progress?.step ?? 0; // 0 = queued, not started
  const elapsed = progress?.startedAt ? Math.max(0, Math.round((now - new Date(progress.startedAt).getTime()) / 1000)) : 0;
  const mm = String(Math.floor(elapsed / 60)).padStart(1, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div className="mt-5 rounded-xl border border-brand-100 bg-brand-50/40 p-4" aria-live="polite">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[13.5px] font-semibold">{title}</p>
        <p className="text-[12px] text-ink-muted tabular">
          {progress ? `${mm}:${ss} elapsed` : "Starting…"}
        </p>
      </div>
      <ol className="space-y-1.5">
        {stages.map((label, i) => {
          const n = i + 1;
          const state = n < step ? "done" : n === step ? "current" : "todo";
          return (
            <li key={label} className="flex items-start gap-2.5 text-[13px]">
              <span
                className={
                  "mt-[3px] h-4 w-4 shrink-0 rounded-full grid place-items-center text-[10px] font-bold " +
                  (state === "done"
                    ? "bg-brand-600 text-white"
                    : state === "current"
                      ? "border-2 border-brand-600 text-brand-700 animate-pulse"
                      : "border border-line-strong text-ink-faint")
                }
              >
                {state === "done" ? "✓" : n}
              </span>
              <div>
                <p className={state === "todo" ? "text-ink-faint" : state === "current" ? "font-semibold" : "text-ink-muted"}>{label}</p>
                {state === "current" && progress?.detail && <p className="text-[12px] text-ink-muted">{progress.detail}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export const DRAFT_STAGES_SAQA = [
  "Fetching the SAQA record",
  "Extracting outcomes and criteria",
  "Drafting questions and marking rubrics",
  "Checking the paper against the assessment standard",
  "Saved",
];
export const DRAFT_STAGES_UPLOAD = [
  "Reading outcomes and criteria from the document",
  "Drafting questions and marking rubrics",
  "Checking the paper against the assessment standard",
  "Saved",
];
export const CHECK_STAGES = ["Checking the paper against the assessment standard", "Saved"];
