import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, pollJob } from "../../lib/api";
import type { AssessmentInstrument, Qualification, JobProgress, BloomLevel, InstrumentQualityReview } from "@shared/types";
import { PageHeader, Card, CardHead, Notice, Badge, Pill, Empty } from "../../components/ui";
import JobProgressPanel, { CHECK_STAGES } from "../../components/JobProgressPanel";
import { BLOOM_ORDER, BLOOM_LABEL, BLOOM_TONE, BloomBadge, VerdictBadge, CoverageDot } from "../../components/standard";

const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

// The AI occasionally emits **markdown** emphasis; we render plain text.
const plain = (t: string | null | undefined) => (t ?? "").replace(/\*\*/g, "");

const TYPE_LABEL: Record<string, string> = {
  mcq: "Multiple choice",
  short_answer: "Short answer",
  long_answer: "Long answer",
  practical_upload: "Practical / upload",
};

const BAR_COLOUR: Record<BloomLevel, string> = {
  remember: "bg-blue-300",
  understand: "bg-blue-500",
  apply: "bg-teal-500",
  analyse: "bg-brand-400",
  evaluate: "bg-brand-600",
  create: "bg-brand-800",
};

function BloomDistribution({ review }: { review: InstrumentQualityReview }) {
  const { profile } = review;
  const total = profile.totalMarks || 1;
  const band = profile.expectedHigherOrderShare;
  const share = profile.higherOrderMarkShare;
  const inBand = share >= band.min && share <= band.max;
  const above = share > band.max;
  return (
    <div className="p-5 space-y-4">
      {/* stacked bar of marks by level */}
      <div>
        <div className="flex h-5 w-full overflow-hidden rounded-md border border-line">
          {BLOOM_ORDER.map((l) => {
            const pct = (profile.byBloom[l].marks / total) * 100;
            return pct > 0 ? (
              <div key={l} className={BAR_COLOUR[l]} style={{ width: `${pct}%` }} title={`${BLOOM_LABEL[l]}: ${profile.byBloom[l].marks} marks (${Math.round(pct)}%)`} />
            ) : null;
          })}
        </div>
        <div className="mt-2.5 grid grid-cols-2 gap-x-5 gap-y-1">
          {BLOOM_ORDER.map((l) => (
            <div key={l} className="text-[12.5px] flex items-center gap-2 whitespace-nowrap">
              <span className={"inline-block h-2.5 w-2.5 shrink-0 rounded-sm " + BAR_COLOUR[l]} />
              <span className="text-ink-muted">{BLOOM_LABEL[l]}</span>
              <span className="tabular ml-auto">
                <span className="font-semibold">{profile.byBloom[l].marks}</span>
                <span className="text-ink-faint"> mk · {profile.byBloom[l].count} q</span>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-line bg-surface-2 p-3.5 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="field-lbl mb-0.5">Higher-order share</p>
            <p className="font-display text-2xl font-extrabold tabular leading-none">{share}%</p>
            <p className="t-sub mt-1">of marks at analyse / evaluate / create</p>
          </div>
          <div className="text-right shrink-0">
            {inBand ? <Badge tone="green">In band</Badge> : above ? <Badge tone="blue">Above band</Badge> : <Badge tone="amber">Below band</Badge>}
            <p className="text-[12.5px] text-ink-muted tabular mt-1.5 whitespace-nowrap">
              expected <span className="font-semibold text-ink">{band.min}–{band.max}%</span>
            </p>
          </div>
        </div>
        <p className="t-sub">{band.basis}</p>
      </div>

      {profile.unlabelledBloom > 0 && (
        <p className="t-sub">
          {profile.unlabelledBloom} question{profile.unlabelledBloom === 1 ? "" : "s"} carry no Bloom's label and are excluded from the shares above.
        </p>
      )}
      <p className="text-[13px] text-ink-muted">{plain(review.bloomAssessment)}</p>
    </div>
  );
}

export default function AdminInstrumentDetail() {
  const { id } = useParams<{ id: string }>();
  const [instrument, setInstrument] = useState<AssessmentInstrument | null>(null);
  const [qualification, setQualification] = useState<Qualification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [showRubrics, setShowRubrics] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const i = await api.get<AssessmentInstrument>(`/instruments/${id}`);
    setInstrument(i);
    const quals = await api.get<Qualification[]>("/qualifications");
    setQualification(quals.find((q) => q.id === i.qualificationId) ?? null);
  }, [id]);

  useEffect(() => {
    load().catch((err) => setError((err as Error).message));
  }, [load]);

  async function runCheck() {
    if (!id) return;
    setError(null);
    setMessage(null);
    setProgress(null);
    setChecking(true);
    try {
      const { jobId } = await api.post<{ jobId: string }>(`/instruments/${id}/quality-check`);
      await pollJob(`/instruments/jobs/${jobId}`, { onProgress: setProgress });
      setMessage("Assessment-standard check complete.");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  }

  if (!instrument) {
    return (
      <>
        <PageHeader title="Instrument" />
        {error ? <Notice kind="error">{error}</Notice> : <p className="text-sm text-ink-muted">Loading…</p>}
      </>
    );
  }

  const review = instrument.qualityReview;
  const qIndex = new Map(instrument.questions.map((q, i) => [q.id, i + 1]));
  const rule = (instrument.passMarkOrCompetencyRule as { rule?: string } | null)?.rule;
  const totalMarks = instrument.questions.reduce((s, q) => s + q.maxMark, 0);
  const issuesByQ = new Map<string, InstrumentQualityReview["questionIssues"]>();
  for (const iss of review?.questionIssues ?? []) {
    const list = issuesByQ.get(iss.questionId) ?? [];
    list.push(iss);
    issuesByQ.set(iss.questionId, list);
  }
  const eloRows = (review?.coverage ?? []).filter((c) => c.kind === "elo");
  const acRows = (review?.coverage ?? []).filter((c) => c.kind === "ac");
  const covered = (review?.coverage ?? []).filter((c) => c.status === "covered").length;

  return (
    <>
      <div className="mb-4">
        <Link to="/admin/instruments" className="lnk">
          ← Instruments
        </Link>
      </div>
      <PageHeader
        title={`${qualification?.title ?? "Instrument"} · ${instrument.version}`}
        subtitle={`${instrument.questions.length} questions · ${totalMarks} marks · ${instrument.timeAllocationMinutes} minutes · Pass rule: ${rule || "50% overall (default)"}${qualification?.nqfLevel ? ` · NQF Level ${qualification.nqfLevel}` : ""}`}
        action={
          <div className="flex items-center gap-3">
            {qualification && <Pill tone={qualification.qctoRegistrationType}>{qualification.qctoRegistrationType.toUpperCase()}</Pill>}
            <VerdictBadge verdict={review?.verdict ?? null} />
            <button type="button" className="btn" onClick={runCheck} disabled={checking}>
              {checking ? "Checking…" : review ? "Re-run standard check" : "Run standard check"}
            </button>
          </div>
        }
      />
      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}
      <JobProgressPanel title="Assessment-standard check" stages={CHECK_STAGES} progress={progress} active={checking} />

      {/* ---------------- Standard check ---------------- */}
      {review ? (
        <div className="space-y-5 mt-5">
          <Card className={review.verdict === "meets_standard" ? "border-brand-100" : "border-amber-200"}>
            <div className="p-5 flex items-start gap-5">
              <div className="shrink-0">
                <p className="field-lbl">Verdict</p>
                <VerdictBadge verdict={review.verdict} />
                <p className="t-sub mt-2">Checked {fmt(review.generatedAt)}</p>
                <p className="t-sub">
                  Against{" "}
                  {review.sourceOfOutcomes === "saqa"
                    ? "the SAQA record"
                    : review.sourceOfOutcomes === "qcto_upload"
                      ? "the uploaded QCTO document"
                      : "the paper's own outcome references only"}
                </p>
              </div>
              <div className="border-l border-line pl-5">
                <p className="text-sm">{plain(review.summary)}</p>
                <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[13px] tabular">
                  <span>
                    <strong>{covered}</strong>/{review.coverage.length} outcomes & criteria covered
                  </span>
                  <span>
                    <strong>{review.profile.higherOrderMarkShare}%</strong> higher-order marks
                  </span>
                  <span>
                    <strong>{review.profile.minutesPerMark}</strong> min per mark
                  </span>
                  <span>
                    <strong>{review.questionIssues.filter((i) => i.severity === "critical").length}</strong> critical question issues
                  </span>
                </div>
              </div>
            </div>
          </Card>

          <div className="grid grid-cols-[1fr_380px] gap-5 items-start">
            <div className="space-y-5">
              <Card>
                <CardHead
                  title="Coverage of the assessment standard"
                  subtitle="Every Exit Level Outcome and Associated Assessment Criterion, and which questions evidence it"
                />
                {review.coverage.length === 0 ? (
                  <Empty>No outcomes on record to check against.</Empty>
                ) : (
                  <>
                    {[
                      { label: "Exit Level Outcomes", rows: eloRows },
                      { label: "Associated Assessment Criteria", rows: acRows },
                    ]
                      .filter((g) => g.rows.length > 0)
                      .map((g) => (
                        <div key={g.label}>
                          <p className="px-5 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{g.label}</p>
                          <table className="data">
                            <thead>
                              <tr>
                                <th className="w-[45%]">Outcome / criterion</th>
                                <th>Status</th>
                                <th>Questions</th>
                                <th className="text-right">Marks</th>
                              </tr>
                            </thead>
                            <tbody>
                              {g.rows.map((c, i) => (
                                <tr key={i}>
                                  <td>
                                    <p className="text-[13px]">{c.ref}</p>
                                    {c.note && <p className="t-sub mt-0.5">{c.note}</p>}
                                  </td>
                                  <td>
                                    <CoverageDot status={c.status} />
                                  </td>
                                  <td className="text-[13px]">
                                    {c.questionIds.length ? c.questionIds.map((qid) => `Q${qIndex.get(qid) ?? "?"}`).join(", ") : <span className="text-ink-faint">—</span>}
                                  </td>
                                  <td className="text-right tabular">{c.marks}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ))}
                  </>
                )}
              </Card>

              <Card>
                <CardHead title="Recommendations" subtitle="Most important first" />
                {review.recommendations.length === 0 ? (
                  <Empty>Nothing to change.</Empty>
                ) : (
                  <ol className="list-decimal pl-9 pr-5 py-4 space-y-2 text-sm">
                    {review.recommendations.map((r, i) => (
                      <li key={i}>{plain(r)}</li>
                    ))}
                  </ol>
                )}
              </Card>
            </div>

            <div className="space-y-5">
              <Card>
                <CardHead title="Cognitive demand (Bloom's taxonomy)" subtitle="Marks by level, against the NQF band" />
                <BloomDistribution review={review} />
              </Card>
              <Card>
                <CardHead title="Question mix" />
                <ul className="divide-y divide-line">
                  {Object.entries(review.profile.byType).map(([t, v]) => (
                    <li key={t} className="px-5 py-2.5 flex items-center justify-between text-[13px]">
                      <span>{TYPE_LABEL[t] ?? t}</span>
                      <span className="tabular text-ink-muted">
                        {v.count} q · {v.marks} mk · {Math.round((v.marks / (review.profile.totalMarks || 1)) * 100)}%
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </div>
        </div>
      ) : (
        !checking && (
          <Card className="mt-5 p-5">
            <p className="text-sm text-ink-muted">
              This paper hasn't been checked against the assessment standard yet. The check maps every question to the qualification's outcomes and criteria, measures cognitive demand on Bloom's taxonomy against the NQF level, and lists what to fix.
            </p>
          </Card>
        )
      )}

      {/* ---------------- Questions ---------------- */}
      <Card className="mt-5">
        <CardHead
          title="Questions"
          subtitle={`${instrument.questions.length} questions · ${totalMarks} marks`}
          right={
            <button type="button" className="btn-ghost btn-sm" onClick={() => setShowRubrics((v) => !v)}>
              {showRubrics ? "Hide rubrics" : "Show rubrics"}
            </button>
          }
        />
        <ul className="divide-y divide-line">
          {instrument.questions.map((q, i) => {
            const issues = issuesByQ.get(q.id) ?? [];
            return (
              <li key={q.id} className="px-5 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                      Q{i + 1} · {TYPE_LABEL[q.type] ?? q.type} · {q.maxMark} mark{q.maxMark === 1 ? "" : "s"}
                    </p>
                    <p className="text-sm mt-1 whitespace-pre-wrap">{q.prompt}</p>
                    {q.type === "mcq" && q.options && (
                      <ul className="mt-1.5 text-[13px] text-ink-muted list-disc pl-5">
                        {q.options.map((o) => (
                          <li key={o}>{o}</li>
                        ))}
                      </ul>
                    )}
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 t-sub">
                      {q.eloRef && <span>Outcome: {q.eloRef}</span>}
                      {q.acRef && <span>Criterion: {q.acRef}</span>}
                    </div>
                    {showRubrics && (
                      <p className="mt-2 text-[13px] whitespace-pre-wrap rounded-lg p-3 border border-dashed border-line-strong text-ink-muted">
                        {q.modelAnswerOrRubric || "No rubric recorded."}
                      </p>
                    )}
                    {issues.map((iss, k) => (
                      <p
                        key={k}
                        className={
                          "mt-2 text-[13px] rounded-lg px-3 py-2 border " +
                          (iss.severity === "critical"
                            ? "border-red-200 bg-red-50 text-red-800"
                            : iss.severity === "warning"
                              ? "border-amber-200 bg-amber-50 text-amber-800"
                              : "border-line bg-surface-2 text-ink-muted")
                        }
                      >
                        <strong className="capitalize">{iss.severity}:</strong> {iss.issue} <span className="opacity-80">— {iss.suggestion}</span>
                      </p>
                    ))}
                  </div>
                  <div className="shrink-0">
                    <BloomBadge level={q.bloomLevel} />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
    </>
  );
}
