import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../lib/api";
import type { Dossier, QuestionMark, SuggestionReview, AiQuestionSuggestion, Outcome, EvidenceResponse } from "@shared/types";
import { PageHeader, Card, CardHead, Notice, Badge, TypePill } from "../../components/ui";
import { IntegrityBadge, Timeline, RecordingPlayer } from "../invigilator/LiveConsole";

const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

type Provisional = { outcome: Outcome; totalMark: number; totalMax: number; percentage: number; explanation: string };

function OutcomeBadge({ o }: { o: Outcome | null | undefined }) {
  if (o === "competent") return <Badge tone="green">Competent</Badge>;
  if (o === "not_yet_competent") return <Badge tone="amber">Not yet competent</Badge>;
  return <Badge tone="gray">Outcome pending</Badge>;
}

function Confidence({ c }: { c: AiQuestionSuggestion["confidence"] }) {
  const tone = c === "high" ? "green" : c === "medium" ? "blue" : "amber";
  return <Badge tone={tone}>{c} confidence</Badge>;
}

export default function AssessorDossier() {
  const { id } = useParams<{ id: string }>();
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Editable state
  const [marks, setMarks] = useState<Record<string, { mark: string; feedback: string }>>({});
  const [overallFeedback, setOverallFeedback] = useState("");
  const [provisional, setProvisional] = useState<Provisional | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "dirty" | "saving" | "saved">("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest editable state, readable from the debounced autosave without the
  // stale-closure problem (the timer is armed from an older render).
  const latest = useRef({ marks, overallFeedback });
  latest.current = { marks, overallFeedback };
  const [showRubric, setShowRubric] = useState<Record<string, boolean>>({});

  // Sign-off dialog
  const [signing, setSigning] = useState(false);
  const [override, setOverride] = useState<"" | Outcome>("");
  const [overrideReason, setOverrideReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const d = await api.get<Dossier>(`/sessions/${id}/dossier`);
    setDossier(d);
    // Seed the form once: from the saved draft if there is one; otherwise from
    // the AI's recommendations (docs/restructure-2026-09-05.md §3 - the AI
    // assesses, the assessor reviews and endorses). The AI's own record is
    // never changed by this; what the assessor signs off is theirs.
    setMarks((prev) => {
      if (Object.keys(prev).length > 0) return prev;
      const next: Record<string, { mark: string; feedback: string }> = {};
      if (d.decision) {
        for (const m of d.decision.perCriterionMarks) next[m.questionId] = { mark: String(m.mark), feedback: m.feedback ?? "" };
      } else if (d.aiReview && !d.decision) {
        for (const sug of d.aiReview.perQuestionSuggestions) {
          next[sug.questionId] = {
            mark: String(sug.suggestedMark),
            feedback: sug.criteriaMissed.length ? sug.criteriaMissed.map((c) => `Missing: ${c}`).join(" ") : sug.depthNote,
          };
        }
      }
      return next;
    });
    if (d.decision) setOverallFeedback((prev) => prev || (d.decision!.overallFeedback ?? ""));
    else if (d.aiReview) setOverallFeedback((prev) => prev || (d.aiReview!.summary ?? ""));
    return d;
  }, [id]);

  useEffect(() => {
    load().catch((err) => setError((err as Error).message));
  }, [load]);

  // While the AI review is still running, poll for it.
  useEffect(() => {
    if (!dossier || dossier.aiReview || dossier.decision?.signedOffAt) return;
    const st = dossier.aiReviewJob?.status;
    if (st !== "pending" && st !== "running") return;
    const t = setInterval(() => load().catch(() => undefined), 5000);
    return () => clearInterval(t);
  }, [dossier, load]);

  const signedOff = Boolean(dossier?.decision?.signedOffAt);
  const questions = dossier?.instrument.questions ?? [];
  const aiById = useMemo(() => {
    const m = new Map<string, AiQuestionSuggestion>();
    for (const s of dossier?.aiReview?.perQuestionSuggestions ?? []) m.set(s.questionId, s);
    return m;
  }, [dossier]);

  const totals = useMemo(() => {
    const max = questions.reduce((s, q) => s + q.maxMark, 0);
    const got = questions.reduce((s, q) => s + (Number(marks[q.id]?.mark) || 0), 0);
    const marked = questions.filter((q) => marks[q.id]?.mark !== undefined && marks[q.id]?.mark !== "").length;
    return { max, got, marked, pct: max ? Math.round((got / max) * 1000) / 10 : 0 };
  }, [questions, marks]);

  function buildPayload() {
    const { marks: cur, overallFeedback: overall } = latest.current;
    const perCriterionMarks: QuestionMark[] = [];
    const aiSuggestionsReview: SuggestionReview[] = [];
    for (const q of questions) {
      const m = cur[q.id];
      if (!m || m.mark === "") continue;
      const mark = Math.max(0, Math.min(q.maxMark, Number(m.mark) || 0));
      perCriterionMarks.push({ questionId: q.id, mark, feedback: m.feedback ?? "" });
      const ai = aiById.get(q.id);
      if (ai) {
        const diff = Math.abs(ai.suggestedMark - mark);
        aiSuggestionsReview.push({
          questionId: q.id,
          decision: diff === 0 ? "accepted" : diff >= q.maxMark / 2 ? "overridden" : "edited",
          reason: m.feedback ?? "",
        });
      }
    }
    return { perCriterionMarks, aiSuggestionsReview, overallFeedback: overall };
  }

  const saveDraft = useCallback(async () => {
    if (!id || signedOff) return;
    setSaveState("saving");
    try {
      const r = await api.post<{ provisional: Provisional }>(`/sessions/${id}/decision`, buildPayload());
      setProvisional(r.provisional);
      setSaveState("saved");
      setError(null);
    } catch (err) {
      setSaveState("dirty");
      setError((err as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, signedOff, questions, aiById]);

  function touch() {
    if (signedOff) return;
    setSaveState("dirty");
    setMessage(null);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveDraft(), 1500);
  }

  function setMark(qId: string, mark: string) {
    setMarks((p) => ({ ...p, [qId]: { mark, feedback: p[qId]?.feedback ?? "" } }));
    touch();
  }
  function setFeedback(qId: string, feedback: string) {
    setMarks((p) => ({ ...p, [qId]: { mark: p[qId]?.mark ?? "", feedback } }));
    touch();
  }
  function acceptAi(qId: string) {
    const ai = aiById.get(qId);
    if (!ai) return;
    setMarks((p) => ({
      ...p,
      [qId]: {
        mark: String(ai.suggestedMark),
        feedback: p[qId]?.feedback || [...ai.criteriaMissed.map((c) => `Missing: ${c}`)].join(" ") || ai.depthNote,
      },
    }));
    touch();
  }
  function acceptAllAi() {
    for (const q of questions) acceptAi(q.id);
  }

  async function rerunAi() {
    if (!id) return;
    setBusy(true);
    try {
      await api.post(`/sessions/${id}/rerun-ai-review`);
      setMessage("AI review re-queued. It usually takes a minute or two.");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function signOff() {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      await api.post(`/sessions/${id}/decision`, buildPayload());
      await api.post(`/sessions/${id}/sign-off`, override ? { overrideOutcome: override, overrideReason } : {});
      setSigning(false);
      setMessage("Signed off. The learner can now see their result, and it has been queued for FPTStaff.");
      setMarks({});
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!dossier) {
    return (
      <>
        <PageHeader title="Marking" />
        {error ? <Notice kind="error">{error}</Notice> : <p className="text-sm text-ink-muted">Loading script…</p>}
      </>
    );
  }

  const ai = dossier.aiReview;
  const rule = (dossier.instrument.passMarkOrCompetencyRule as { rule?: string } | null)?.rule;

  return (
    <>
      <div className="mb-4">
        <Link to="/assessor" className="lnk">
          ← Marking queue
        </Link>
      </div>
      <PageHeader
        title={dossier.learner.name}
        subtitle={`${dossier.qualification.title} · Paper ${dossier.instrument.version} · Submitted ${fmt(dossier.session.submissionTime)}`}
        action={
          <div className="flex items-center gap-3">
            <TypePill type={dossier.qualification.qctoRegistrationType} />
            {signedOff ? <OutcomeBadge o={dossier.decision?.outcome} /> : <Badge tone="blue">Marking</Badge>}
          </div>
        }
      />

      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}
      {!signedOff && ai && !dossier.decision && (
        <Notice kind="success">
          The AI has marked this script against the memo and its marks and feedback are filled in below, each tagged <strong>AI-recommended</strong>. Read them, change any you disagree with, then sign off. Your sign-off is the assessment decision.
        </Notice>
      )}

      <IntegrityCard dossier={dossier} />

      {signedOff && dossier.decision && (
        <Card className="p-5 mb-6 border-brand-100 bg-brand-50/40">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
            <div>
              <p className="field-lbl">Final result</p>
              <p className="font-display text-2xl font-extrabold tabular">
                {dossier.decision.totalMark}/{dossier.decision.totalMax}
                <span className="text-base text-ink-muted font-semibold ml-2">
                  {dossier.decision.totalMax ? Math.round(((dossier.decision.totalMark ?? 0) / dossier.decision.totalMax) * 1000) / 10 : 0}%
                </span>
              </p>
            </div>
            <div>
              <p className="field-lbl">Outcome</p>
              <OutcomeBadge o={dossier.decision.outcome} />
            </div>
            <div>
              <p className="field-lbl">Signed off</p>
              <p className="text-sm font-semibold">{fmt(dossier.decision.signedOffAt)}</p>
              <a href={`/api/sessions/${dossier.session.id}/statement.pdf`} target="_blank" rel="noreferrer" className="lnk block mt-1">Statement of Results (PDF)</a>
            </div>
            <p className="text-[12.5px] text-ink-muted ml-auto max-w-sm">
              This result is final and visible to the learner. It has been queued for FPTStaff, where moderation and verification run for passed learners.
            </p>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-[1fr_320px] gap-6 items-start">
        {/* ---------------- Left: the script ---------------- */}
        <div className="space-y-5">
          {questions.map((q, idx) => {
            const answer = dossier.session.answers[q.id];
            const s = aiById.get(q.id);
            const m = marks[q.id];
            const savedMark = dossier.decision?.perCriterionMarks.find((x) => x.questionId === q.id);
            return (
              <Card key={q.id}>
                <div className="px-5 py-4 border-b border-line flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                      Question {idx + 1} · {q.type.replace("_", " ")} · {q.maxMark} mark{q.maxMark === 1 ? "" : "s"}
                    </p>
                    <p className="text-[15px] mt-1 whitespace-pre-wrap">{q.prompt}</p>
                    {q.eloRef && <p className="t-sub mt-1">Outcome: {q.eloRef}</p>}
                  </div>
                </div>

                <div className="px-5 py-4 grid grid-cols-2 gap-5">
                  <div>
                    <p className="field-lbl">Learner's answer</p>
                    {answer && String(answer).trim() ? (
                      <p className="text-sm whitespace-pre-wrap bg-surface-2 rounded-lg p-3 border border-line">{String(answer)}</p>
                    ) : (
                      <p className="text-sm text-ink-faint italic bg-surface-2 rounded-lg p-3 border border-line">No answer given.</p>
                    )}
                    <button
                      type="button"
                      className="lnk mt-2 text-xs"
                      onClick={() => setShowRubric((p) => ({ ...p, [q.id]: !p[q.id] }))}
                    >
                      {showRubric[q.id] ? "Hide" : "Show"} model answer / rubric
                    </button>
                    {showRubric[q.id] && (
                      <p className="text-[13px] whitespace-pre-wrap mt-2 rounded-lg p-3 border border-dashed border-line-strong text-ink-muted">
                        {q.modelAnswerOrRubric || "No rubric recorded for this question."}
                      </p>
                    )}
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <p className="field-lbl mb-0">AI suggestion</p>
                      {s && <Confidence c={s.confidence} />}
                    </div>
                    {s ? (
                      <div className="rounded-lg border border-blue-100 bg-blue-50/50 p-3 text-[13px] space-y-2">
                        <p className="font-display font-extrabold text-lg tabular text-blue-700">
                          {s.suggestedMark}
                          <span className="text-sm text-ink-muted font-semibold">/{s.maxMark}</span>
                        </p>
                        {s.criteriaMatched.length > 0 && (
                          <div>
                            <p className="text-[11px] font-semibold text-brand-700 uppercase tracking-wide">Demonstrated</p>
                            <ul className="list-disc pl-4 text-ink">
                              {s.criteriaMatched.map((c, i) => (
                                <li key={i}>{c}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {s.criteriaMissed.length > 0 && (
                          <div>
                            <p className="text-[11px] font-semibold text-amber-700 uppercase tracking-wide">Missing</p>
                            <ul className="list-disc pl-4 text-ink">
                              {s.criteriaMissed.map((c, i) => (
                                <li key={i}>{c}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {s.depthNote && <p className="text-ink-muted italic">{s.depthNote}</p>}
                        {s.rationale && <p className="text-ink-muted">{s.rationale}</p>}
                        {!signedOff && (
                          <button type="button" className="btn-ghost btn-sm" onClick={() => acceptAi(q.id)}>
                            Use this mark
                          </button>
                        )}
                      </div>
                    ) : (
                      <p className="text-[13px] text-ink-faint rounded-lg border border-line p-3">
                        {dossier.aiReviewJob?.status === "failed"
                          ? "The AI review failed for this script - mark manually or re-run it."
                          : "AI review not available yet."}
                      </p>
                    )}
                  </div>
                </div>

                <div className="px-5 py-4 border-t border-line bg-surface-2/60 grid grid-cols-[120px_1fr] gap-4 items-start">
                  <div>
                    <label className="field-lbl">
                      Your mark
                      {!signedOff && s && m?.mark !== undefined && m.mark !== "" && (
                        <span className={"ml-2 normal-case tracking-normal font-semibold " + (Number(m.mark) === s.suggestedMark ? "text-blue-600" : "text-amber-700")}>
                          {Number(m.mark) === s.suggestedMark ? "AI-recommended" : "Changed from AI"}
                        </span>
                      )}
                    </label>
                    {signedOff ? (
                      <p className="font-display font-extrabold text-xl tabular">
                        {savedMark?.mark ?? 0}
                        <span className="text-sm text-ink-muted font-semibold">/{q.maxMark}</span>
                      </p>
                    ) : (
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={0}
                          max={q.maxMark}
                          step={0.5}
                          value={m?.mark ?? ""}
                          onChange={(e) => setMark(q.id, e.target.value)}
                          className="inp w-20 text-center font-semibold"
                          placeholder="–"
                        />
                        <span className="text-sm text-ink-muted">/ {q.maxMark}</span>
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="field-lbl">Feedback to the learner</label>
                    {signedOff ? (
                      <p className="text-sm whitespace-pre-wrap">{savedMark?.feedback || <span className="text-ink-faint">—</span>}</p>
                    ) : (
                      <textarea
                        rows={2}
                        value={m?.feedback ?? ""}
                        onChange={(e) => setFeedback(q.id, e.target.value)}
                        className="inp"
                        placeholder="What was right, what was missing, what to work on"
                      />
                    )}
                  </div>
                </div>
              </Card>
            );
          })}

          <Card>
            <CardHead title="Overall feedback" subtitle="Released to the learner with the result." />
            <div className="p-5">
              {signedOff ? (
                <p className="text-sm whitespace-pre-wrap">{dossier.decision?.overallFeedback || <span className="text-ink-faint">—</span>}</p>
              ) : (
                <textarea
                  rows={4}
                  value={overallFeedback}
                  onChange={(e) => {
                    setOverallFeedback(e.target.value);
                    touch();
                  }}
                  className="inp"
                  placeholder="Overall comment on the script"
                />
              )}
            </div>
          </Card>
        </div>

        {/* ---------------- Right: AI summary, gap map, totals, sign-off ---------------- */}
        <div className="space-y-5 sticky top-6">
          <Card>
            <CardHead
              title="Your marking"
              right={
                !signedOff && (
                  <span className="text-[11.5px] text-ink-faint">
                    {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Draft saved" : saveState === "dirty" ? "Unsaved changes" : ""}
                  </span>
                )
              }
            />
            <div className="p-5">
              <p className="font-display text-3xl font-extrabold tabular">
                {signedOff ? dossier.decision?.totalMark : totals.got}
                <span className="text-base text-ink-muted font-semibold">/{totals.max}</span>
                <span className="text-base text-ink-muted font-semibold ml-2">
                  {signedOff && dossier.decision?.totalMax
                    ? Math.round(((dossier.decision.totalMark ?? 0) / dossier.decision.totalMax) * 1000) / 10
                    : totals.pct}
                  %
                </span>
              </p>
              <p className="t-sub mt-1">
                {signedOff ? "Final." : `${totals.marked} of ${questions.length} questions marked.`}
              </p>
              <div className="mt-3 pt-3 border-t border-line">
                <p className="field-lbl">Pass rule</p>
                <p className="text-[13px]">{rule || "50% overall (default)"}</p>
                {!signedOff && provisional && (
                  <div className="mt-2 flex items-center gap-2">
                    <OutcomeBadge o={provisional.outcome} />
                    <span className="t-sub">provisional</span>
                  </div>
                )}
              </div>
              {!signedOff && (
                <div className="mt-4 flex flex-col gap-2">
                  {ai && (
                    <button type="button" className="btn-ghost" onClick={acceptAllAi} title="Put every mark back to the AI's recommendation">
                      Reset to AI recommendations
                    </button>
                  )}
                  <button type="button" className="btn-ghost" onClick={() => void saveDraft()} disabled={saveState === "saving"}>
                    Save draft
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={totals.marked < questions.length || busy}
                    onClick={() => {
                      setOverride("");
                      setOverrideReason("");
                      setSigning(true);
                      void saveDraft();
                    }}
                  >
                    Sign off result
                  </button>
                  {totals.marked < questions.length && <p className="t-sub">Mark every question to enable sign-off.</p>}
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHead
              title="AI review"
              subtitle={ai ? `Generated ${fmt(ai.generatedAt)}` : undefined}
              right={ai ? <OutcomeBadge o={ai.suggestedOutcome} /> : undefined}
            />
            <div className="p-5 text-[13px] space-y-3">
              {ai ? (
                <>
                  <p className="text-ink-muted">{ai.summary}</p>
                  <p className="t-sub">Suggested outcome is the AI's view under the pass rule. Your marks decide.</p>
                </>
              ) : dossier.aiReviewJob?.status === "failed" ? (
                <>
                  <p className="text-amber-700">
                    The AI review failed. {dossier.aiReviewJob.error} {dossier.aiReviewJob.detail}
                  </p>
                  {!signedOff && (
                    <button type="button" className="btn-ghost btn-sm" onClick={rerunAi} disabled={busy}>
                      Re-run AI review
                    </button>
                  )}
                </>
              ) : dossier.aiReviewJob ? (
                <p className="text-ink-muted">The AI is reviewing this script now - usually a minute or two. You can start marking meanwhile.</p>
              ) : (
                <>
                  <p className="text-ink-muted">No AI review has run for this script.</p>
                  {!signedOff && (
                    <button type="button" className="btn-ghost btn-sm" onClick={rerunAi} disabled={busy}>
                      Run AI review
                    </button>
                  )}
                </>
              )}
            </div>
          </Card>

          {ai && ai.gapMap.length > 0 && (
            <Card>
              <CardHead title="Gap map" subtitle="Outcomes demonstrated across the script" />
              <ul className="divide-y divide-line">
                {ai.gapMap.map((g, i) => (
                  <li key={i} className="px-5 py-3 text-[13px]">
                    <div className="flex items-start gap-2">
                      <span
                        className={
                          "mt-1 h-2.5 w-2.5 shrink-0 rounded-full " + (g.demonstrated ? "bg-brand-600" : "bg-amber-500")
                        }
                      />
                      <div>
                        <p className="font-semibold">{g.eloRef}</p>
                        <p className="text-ink-muted">{g.note}</p>
                        {g.evidenceQuestionIds.length > 0 && (
                          <p className="t-sub">
                            Q{g.evidenceQuestionIds
                              .map((qid) => questions.findIndex((q) => q.id === qid) + 1)
                              .filter((n) => n > 0)
                              .join(", Q")}
                          </p>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      {/* ---------------- Sign-off confirmation ---------------- */}
      {signing && (
        <div className="fixed inset-0 z-50 bg-ink/40 grid place-items-center p-4" onClick={() => !busy && setSigning(false)}>
          <div className="card w-full max-w-lg p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-display text-lg font-extrabold tracking-tight">Sign off this result?</h2>
            <p className="text-sm text-ink-muted">
              Sign-off is final. The learner sees the result and your feedback immediately, and the result is queued for FPTStaff. Re-opening later is an audited Administrator action.
            </p>
            <div className="rounded-lg border border-line bg-surface-2 p-4">
              <p className="font-display text-2xl font-extrabold tabular">
                {totals.got}/{totals.max} <span className="text-base text-ink-muted font-semibold">{totals.pct}%</span>
              </p>
              {provisional ? (
                <>
                  <div className="mt-1 flex items-center gap-2">
                    <OutcomeBadge o={provisional.outcome} />
                    <span className="t-sub">by the paper's rule</span>
                  </div>
                  <p className="t-sub mt-1">{provisional.explanation}</p>
                </>
              ) : (
                <p className="t-sub mt-1">Working out the outcome…</p>
              )}
            </div>
            <details className="text-sm">
              <summary className="cursor-pointer text-ink-muted">Override the computed outcome (needs a reason)</summary>
              <div className="mt-3 space-y-2">
                <select className="inp" value={override} onChange={(e) => setOverride(e.target.value as "" | Outcome)}>
                  <option value="">No override - use the rule</option>
                  <option value="competent">Competent</option>
                  <option value="not_yet_competent">Not yet competent</option>
                </select>
                {override && (
                  <textarea
                    className="inp"
                    rows={2}
                    placeholder="Reason for the override (recorded in the audit log)"
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                  />
                )}
              </div>
            </details>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className="btn-ghost" onClick={() => setSigning(false)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn" onClick={signOff} disabled={busy || (Boolean(override) && !overrideReason.trim())}>
                {busy ? "Signing off…" : "Sign off"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}


// Block 5c: what the exam room recorded, summarised - the assessor sees this
// before marking so an irregular sitting is never signed off unknowingly.
function IntegrityCard({ dossier }: { dossier: Dossier }) {
  const ig = dossier.integrity;
  const [open, setOpen] = useState(false);
  const [video, setVideo] = useState(false);
  const [evidence, setEvidence] = useState<EvidenceResponse | null>(null);
  useEffect(() => {
    if (open && !evidence) api.get<EvidenceResponse>(`/sittings/${dossier.sitting.id}/learners/${dossier.learner.id}/evidence`).then(setEvidence).catch(() => setEvidence(null));
  }, [open, evidence, dossier.sitting.id, dossier.learner.id]);
  if (!ig) return null;
  const flagged = ig.findings.filter((f) => f.severity !== "info");
  const tone = ig.recommendation === "clear" ? "border-brand-100 bg-brand-50/30" : ig.recommendation === "review" ? "border-amber-200 bg-amber-50/40" : "border-red-200 bg-red-50/40";
  return (
    <Card className={"mb-6 " + tone}>
      <div className="p-5 flex items-start gap-4">
        {dossier.identityPhotoId && <img src={`/api/sit/evidence/${dossier.identityPhotoId}`} alt="Identity photo at check-in" className="h-20 w-[6.5rem] rounded-md object-cover border border-line shrink-0" title="Identity photo taken at check-in" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Sitting integrity</span>
            <IntegrityBadge r={ig.recommendation} />
            <span className="t-sub">{dossier.learner.studentNumber ? `${dossier.learner.studentNumber} · ` : ""}ID {dossier.learner.idNumberMasked ?? "—"} · wrote for {ig.writingMinutes} min · {ig.counts.photos} photos, {ig.counts.screens} screens · submitted by {ig.submittedBy === "time_up" ? "the clock" : ig.submittedBy === "invigilator" ? "the invigilator" : "the learner"}</span>
          </div>
          <p className="text-[14px] font-semibold mt-1">{ig.headline}</p>
          {flagged.length > 0 && (
            <ul className="mt-2 space-y-1 text-[13px]">
              {flagged.map((f) => <li key={f.code} className="flex gap-2"><span className={"mt-1.5 h-2 w-2 rounded-full shrink-0 " + (f.severity === "high" ? "bg-red-500" : f.severity === "medium" ? "bg-amber-400" : "bg-blue-300")} /><span><span className="font-semibold">{f.title}.</span> <span className="text-ink-muted">{f.detail}</span></span></li>)}
            </ul>
          )}
          <div className="flex items-center gap-4 mt-2">
            <button type="button" className="lnk" onClick={() => setOpen(!open)}>{open ? "Hide the evidence" : "See the evidence — photos, screens and every event"}</button>
            {ig.recording && <button type="button" className="lnk" onClick={() => setVideo(!video)}>{video ? "Hide the recording" : `Watch the recording — ${ig.recording.camera} min`}</button>}
          </div>
        </div>
      </div>
      {open && <div className="border-t border-line p-5 bg-surface">{evidence ? <Timeline e={evidence} showIntegrity={false} /> : <p className="t-sub">Loading the evidence…</p>}</div>}
      {video && <div className="border-t border-line p-5 bg-surface"><RecordingPlayer sittingId={dossier.sitting.id} learnerId={dossier.learner.id} /></div>}
    </Card>
  );
}
