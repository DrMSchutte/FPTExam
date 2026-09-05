import type { LearnerResult } from "@shared/types";
import { Card, CardHead, Badge } from "../../components/ui";

const fmt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });

// The learner's released result: outcome, mark, the Assessor's feedback per
// question and overall, and the outcome-level gap map. Only reachable once the
// server has a signed-off decision for the session (build brief §5.1).
export default function LearnerResultView({ result, onBack }: { result: LearnerResult; onBack: () => void }) {
  const competent = result.outcome === "competent";
  return (
    <div className="max-w-3xl mx-auto p-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-brand-700">Your result</h1>
        <button onClick={onBack} className="text-xs text-ink-muted underline">
          ← Back to my sittings
        </button>
      </div>

      <Card className={"p-6 " + (competent ? "border-brand-100" : "border-amber-200")}>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{result.qualificationTitle}</p>
        <div className="mt-2 flex flex-wrap items-end gap-x-8 gap-y-3">
          <div>
            <p className="font-display text-4xl font-extrabold tabular">
              {result.totalMark}
              <span className="text-xl text-ink-muted font-semibold">/{result.totalMax}</span>
            </p>
            <p className="text-sm text-ink-muted">{result.percentage}%</p>
          </div>
          <div className="pb-1">
            {competent ? <Badge tone="green">Competent</Badge> : <Badge tone="amber">Not yet competent</Badge>}
          </div>
          <p className="text-xs text-ink-faint ml-auto pb-1">Released {fmt(result.signedOffAt)}</p>
        </div>
        {result.overallFeedback && (
          <div className="mt-5 pt-4 border-t border-line">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted mb-1">Assessor's feedback</p>
            <p className="text-sm whitespace-pre-wrap">{result.overallFeedback}</p>
          </div>
        )}
      </Card>

      {result.gapMap.length > 0 && (
        <Card>
          <CardHead title="Where you stand on each outcome" subtitle="Green: demonstrated in this exam. Amber: still to develop." />
          <ul className="divide-y divide-line">
            {result.gapMap.map((g, i) => (
              <li key={i} className="px-5 py-3 text-sm flex items-start gap-3">
                <span className={"mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full " + (g.demonstrated ? "bg-brand-600" : "bg-amber-500")} />
                <div>
                  <p className="font-semibold">{g.eloRef}</p>
                  {g.note && <p className="text-ink-muted">{g.note}</p>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardHead title="Question by question" />
        <ul className="divide-y divide-line">
          {result.perQuestion.map((q, idx) => (
            <li key={q.questionId} className="px-5 py-4">
              <div className="flex items-baseline justify-between gap-4">
                <p className="text-sm font-semibold">Question {idx + 1}</p>
                <p className="text-sm font-semibold tabular whitespace-nowrap">
                  {q.mark}
                  <span className="text-ink-muted font-normal">/{q.maxMark}</span>
                </p>
              </div>
              <p className="text-sm text-ink-muted mt-1 whitespace-pre-wrap">{q.prompt}</p>
              {q.feedback && <p className="text-sm mt-2 rounded-lg bg-surface-2 border border-line p-3 whitespace-pre-wrap">{q.feedback}</p>}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
