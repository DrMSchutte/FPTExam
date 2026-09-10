import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { api, pollJob } from "../../lib/api";
import type { AssessmentInstrument, Qualification, JobProgress, BloomLevel, InstrumentQualityReview, Question } from "@shared/types";
import { PageHeader, Card, CardHead, Notice, Badge, TypePill, Empty } from "../../components/ui";
import JobProgressPanel, { CHECK_STAGES } from "../../components/JobProgressPanel";

const FIX_STAGES = ["Revising the paper to close the gaps", "Checking the revised paper against the standard", "Saved"];
import { BLOOM_ORDER, BLOOM_LABEL, BloomBadge, VerdictBadge, CoverageDot } from "../../components/standard";
import { GateBadge, RouteBadge, sourceWord, routeMeta } from "../../components/intake";

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
  const [overriding, setOverriding] = useState(false);
  const navigate = useNavigate();
  const [retiring, setRetiring] = useState(false);
  const [retireReason, setRetireReason] = useState("");
  async function retire() {
    try { const r = await api.post<AssessmentInstrument>(`/instruments/${id}/retire`, { reason: retireReason }); setInstrument((i) => (i ? { ...i, retiredAt: r.retiredAt, retireReason: r.retireReason } : i)); setRetiring(false); setMessage("Paper retired. It stays for the sittings written on it and cannot be scheduled again."); }
    catch (e) { setError((e as Error).message); }
  }
  async function unretire() {
    try { await api.post(`/instruments/${id}/unretire`); setInstrument((i) => (i ? { ...i, retiredAt: null, retireReason: null } : i)); setMessage("Paper back in use."); }
    catch (e) { setError((e as Error).message); }
  }
  async function deletePaper() {
    if (!window.confirm("Delete this paper permanently? Only possible when no sitting was ever scheduled on it.")) return;
    try { await api.del(`/instruments/${id}`); navigate("/admin/assessments", { replace: true }); }
    catch (e) { setError((e as Error).message); }
  }
  const [overrideReason, setOverrideReason] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Question[]>([]);
  const [draftTime, setDraftTime] = useState("");
  const [draftRule, setDraftRule] = useState("");
  const [saving, setSaving] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [fixNotes, setFixNotes] = useState<string | null>(null);
  // Outcomes & criteria editor
  const [editingOutcomes, setEditingOutcomes] = useState(false);
  const [eloText, setEloText] = useState("");
  const [acText, setAcText] = useState("");
  const [tidying, setTidying] = useState(false);
  const [tidyNote, setTidyNote] = useState<string | null>(null);
  const [savingOutcomes, setSavingOutcomes] = useState(false);

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

  async function submitOverride() {
    if (!id) return;
    setError(null);
    try {
      await api.post(`/instruments/${id}/override`, { reason: overrideReason });
      setOverriding(false);
      setOverrideReason("");
      setMessage("Override recorded. This paper can now be scheduled; the reason is in the audit log.");
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function fixGaps() {
    if (!id) return;
    setError(null);
    setMessage(null);
    setFixNotes(null);
    setProgress(null);
    setFixing(true);
    try {
      const { jobId } = await api.post<{ jobId: string }>(`/instruments/${id}/fix-gaps`);
      const done = await pollJob<{ instrument: AssessmentInstrument; coverageNotes: string }>(`/instruments/jobs/${jobId}`, { onProgress: setProgress });
      setFixNotes(done.coverageNotes || null);
      const v = done.instrument.qualityReview?.verdict;
      setMessage(
        v === "meets_standard"
          ? "The paper now meets the assessment standard and is ready to schedule."
          : v === "meets_with_minor_gaps"
            ? "The paper now meets the standard with minor gaps and is ready to schedule. The remaining notes are below."
            : "The paper was revised but still does not meet the standard. The notes below say what remains and what to do about it."
      );
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setFixing(false);
    }
  }

  async function restorePrevious() {
    if (!id) return;
    setError(null);
    setMessage(null);
    setFixNotes(null);
    setChecking(true);
    try {
      const { jobId } = await api.post<{ jobId: string }>(`/instruments/${id}/restore-previous`);
      await pollJob(`/instruments/jobs/${jobId}`, { onProgress: setProgress });
      setMessage("The previous version of the paper is back and has been re-checked.");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  }

  async function beginEditOutcomes() {
    if (!id) return;
    setError(null);
    setMessage(null);
    setTidyNote(null);
    try {
      const o = await api.get<{ exitLevelOutcomes: string[]; assessmentCriteria: string[] }>(`/instruments/${id}/outcomes`);
      setEloText(o.exitLevelOutcomes.join("\n"));
      setAcText(o.assessmentCriteria.join("\n"));
      setEditingOutcomes(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const lines = (t: string) => t.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)]|ELO\s*\d+[:.]?|AC\s*\d+(?:\.\d+)*[:.]?)\s*/i, "").trim()).filter(Boolean);

  async function tidyOutcomes() {
    if (!id) return;
    setError(null);
    setTidying(true);
    try {
      const n = await api.post<{ exitLevelOutcomes: string[]; assessmentCriteria: string[]; changed: boolean; notes: string }>(`/instruments/${id}/outcomes/tidy`, {
        exitLevelOutcomes: lines(eloText),
        assessmentCriteria: lines(acText),
      });
      setEloText(n.exitLevelOutcomes.join("\n"));
      setAcText(n.assessmentCriteria.join("\n"));
      setTidyNote(n.changed ? `Tidied: ${n.notes} Review the lists, then Save and re-check.` : "Nothing to tidy — the lists already read as one competence per line.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTidying(false);
    }
  }

  async function saveOutcomes() {
    if (!id) return;
    setError(null);
    const elos = lines(eloText);
    if (elos.length === 0) return setError("Give at least one exit level outcome, one per line.");
    setSavingOutcomes(true);
    setProgress(null);
    try {
      const { jobId } = await api.put<{ jobId: string }>(`/instruments/${id}/outcomes`, { exitLevelOutcomes: elos, assessmentCriteria: lines(acText) });
      setEditingOutcomes(false);
      setChecking(true);
      try {
        await pollJob(`/instruments/jobs/${jobId}`, { onProgress: setProgress });
        setMessage("Outcomes saved. The paper was re-checked against them.");
      } finally {
        setChecking(false);
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingOutcomes(false);
    }
  }

  function beginEdit() {
    if (!instrument) return;
    setDraft(instrument.questions.map((q) => ({ ...q, options: q.options ? [...q.options] : undefined })));
    setDraftTime(String(instrument.timeAllocationMinutes));
    setDraftRule((instrument.passMarkOrCompetencyRule as { rule?: string } | null)?.rule ?? "");
    setEditing(true);
    setMessage(null);
    setError(null);
  }

  async function saveEdit() {
    if (!id || !instrument) return;
    setError(null);
    const bad = draft.find((q) => !q.prompt.trim() || !(q.maxMark >= 0) || (q.type === "mcq" && (q.options?.filter(Boolean).length ?? 0) < 2));
    if (bad) return setError(`Q${draft.indexOf(bad) + 1} needs a prompt, a mark, and (for multiple choice) at least two options.`);
    if (draft.length === 0) return setError("A paper needs at least one question.");
    setSaving(true);
    setProgress(null);
    try {
      const body: Record<string, unknown> = {
        questions: draft.map((q) => ({
          ...q,
          prompt: q.prompt.trim(),
          options: q.type === "mcq" ? q.options?.map((o) => o.trim()).filter(Boolean) : undefined,
          modelAnswerOrRubric: q.modelAnswerOrRubric?.trim() || undefined,
          eloRef: q.eloRef?.trim() || undefined,
          acRef: q.acRef?.trim() || undefined,
        })),
      };
      const t = Number(draftTime);
      if (t > 0 && t !== instrument.timeAllocationMinutes) body.timeAllocationMinutes = t;
      const currentRule = (instrument.passMarkOrCompetencyRule as { rule?: string } | null)?.rule ?? "";
      if (draftRule.trim() && draftRule.trim() !== currentRule) body.passMarkOrCompetencyRule = draftRule.trim();
      const updated = await api.patch<AssessmentInstrument & { recheckJobId: string | null }>(`/instruments/${id}`, body);
      setEditing(false);
      if (updated.recheckJobId) {
        setChecking(true);
        try {
          await pollJob(`/instruments/jobs/${updated.recheckJobId}`, { onProgress: setProgress });
          setMessage("Changes saved. The paper was re-checked against the assessment standard.");
        } finally {
          setChecking(false);
        }
      } else {
        setMessage("Changes saved.");
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function updateQ(i: number, patch: Partial<Question>) {
    setDraft((d) => d.map((q, k) => (k === i ? { ...q, ...patch } : q)));
  }
  function moveQ(i: number, dir: -1 | 1) {
    setDraft((d) => {
      const j = i + dir;
      if (j < 0 || j >= d.length) return d;
      const copy = [...d];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  }
  function addQ() {
    setDraft((d) => [
      ...d,
      { id: crypto.randomUUID(), type: "short_answer", prompt: "", maxMark: 5, modelAnswerOrRubric: "", bloomLevel: "understand" },
    ]);
  }

  if (!instrument) {
    return (
      <>
        <PageHeader title="Assessment" />
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
  const meta = routeMeta(instrument.intakeRoute);
  const editable = meta.builtHere;

  return (
    <>
      <div className="mb-4">
        <Link to="/admin/assessments" className="lnk">
          ← Set up an Assessment
        </Link>
      </div>
      <PageHeader
        title={`${qualification?.title ?? "Instrument"} · ${instrument.version}`}
        subtitle={`${instrument.questions.length} questions · ${totalMarks} marks · ${instrument.timeAllocationMinutes} minutes · Pass rule: ${rule || "50% overall (default)"}${qualification?.nqfLevel ? ` · NQF Level ${qualification.nqfLevel}` : ""}`}
        action={
          <div className="flex items-center gap-3">
            {qualification && <TypePill type={qualification.qctoRegistrationType} />}
            <RouteBadge route={instrument.intakeRoute} />
            <GateBadge status={instrument.intakeStatus} />
            <button type="button" className="btn-ghost" onClick={runCheck} disabled={checking}>
              {checking ? "Checking…" : review ? "Re-run standard check" : "Run standard check"}
            </button>
            <a href={`/api/instruments/${id}/alignment.pdf?download=1`} className="btn-ghost whitespace-nowrap" title="The alignment matrix report: verdict, paper shape, coverage of every outcome and criterion, the question × outcome grid and the question index">Alignment matrix (PDF)</a>
          </div>
        }
      />
      {instrument.retiredAt ? (
        <div className="mb-4 rounded-lg border border-line bg-surface-2 px-4 py-3 text-[13.5px] flex items-start gap-3">
          <div className="flex-1"><span className="font-semibold">This paper is retired</span> — {instrument.retireReason ?? "taken out of use"}. It stays for the sittings written on it and cannot be scheduled again.</div>
          <button type="button" className="btn-ghost btn-sm" onClick={unretire}>Put back in use</button>
          <button type="button" className="btn-ghost btn-sm text-red-700" onClick={deletePaper}>Delete</button>
        </div>
      ) : (
        <div className="mb-4 flex items-center gap-3 text-[12.5px] text-ink-muted">
          {retiring ? (
            <>
              <input className="inp max-w-md" value={retireReason} onChange={(e) => setRetireReason(e.target.value)} placeholder="Why this paper is being taken out of use (e.g. replaced by 2026-2)" maxLength={300} />
              <button type="button" className="btn btn-sm" disabled={retireReason.trim().length < 3} onClick={retire}>Retire paper</button>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setRetiring(false)}>Cancel</button>
            </>
          ) : (
            <>
              <span>Not using this paper?</span>
              <button type="button" className="lnk" onClick={() => setRetiring(true)}>Retire it</button>
              <span className="text-ink-faint">·</span>
              <button type="button" className="lnk text-red-700" onClick={deletePaper}>Delete it</button>
              <span className="t-sub">(delete only while no sitting has been scheduled on it; otherwise retire)</span>
            </>
          )}
        </div>
      )}
      {instrument.supersededById && (
        <div className="mb-4 rounded-lg border border-line bg-surface-2 px-4 py-3 text-[13.5px]">
          <span className="font-semibold">This version has been superseded.</span> A newer release of this assessment was pulled in from Curricula Builder — <Link to={`/admin/assessments/${instrument.supersededById}`} className="lnk">open the current version</Link>. This one stays for the sittings already written on it and cannot be scheduled again.
        </div>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}
      <JobProgressPanel title="Assessment-standard check" stages={CHECK_STAGES} progress={progress} active={checking} />
      <JobProgressPanel title="Fixing the gaps — the AI revises the paper, then the check runs again" stages={FIX_STAGES} progress={progress} active={fixing} />
      {fixNotes && (
        <div className="mt-4 rounded-lg border border-brand-100 bg-brand-50/40 p-3.5 text-[13px] whitespace-pre-wrap">
          <p className="font-semibold mb-1">What the revision changed</p>
          {plain(fixNotes)}
        </div>
      )}
      {instrument.previousQuestions && !fixing && !checking && (
        <p className="t-sub mt-3">
          This paper was revised by the AI.{" "}
          <button type="button" className="lnk" onClick={restorePrevious}>Restore the previous version</button>
        </p>
      )}

      {instrument.intakeStatus === "blocked" && (
        <Card className="mt-5 border-amber-200">
          <div className="p-5 flex items-start gap-4">
            <div className="flex-1">
              <p className="font-display font-bold text-[15px]">This paper cannot be scheduled yet</p>
              <p className="text-sm text-ink-muted mt-1">
                The standard check found it does not meet the assessment standard (see below).{" "}
                {editable
                  ? "Edit the questions below — the check runs again when you save — or, if you are satisfied it is fit for use, record an override with a reason."
                  : "Correct it on Curricula Builder and pull the new version in under Set up an Assessment, or — if you are satisfied it is fit for use — record an override with a reason."}{" "}
                The reason goes in the audit log.
              </p>
              {overriding && (
                <div className="mt-3 flex gap-2 items-start">
                  <textarea className="inp" rows={2} placeholder="Why this paper may be used despite the check" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
                  <button type="button" className="btn whitespace-nowrap" onClick={submitOverride} disabled={overrideReason.trim().length < 10}>
                    Record override
                  </button>
                  <button type="button" className="btn-ghost" onClick={() => setOverriding(false)}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
            {!overriding && (
              <div className="flex flex-col items-stretch gap-2 shrink-0">
                {editable && review && (
                  <button type="button" className="btn whitespace-nowrap" onClick={fixGaps} disabled={fixing || checking}>
                    {fixing ? "Fixing…" : "Fix the gaps with AI"}
                  </button>
                )}
                <button type="button" className="btn-ghost whitespace-nowrap" onClick={() => setOverriding(true)}>
                  Override with a reason
                </button>
              </div>
            )}
          </div>
        </Card>
      )}
      {instrument.intakeStatus === "override" && (
        <Card className="mt-5 border-blue-100">
          <div className="p-5">
            <p className="font-display font-bold text-[15px]">Override in force</p>
            <p className="text-sm text-ink-muted mt-1">This paper may be scheduled despite the standard check. Reason recorded: “{instrument.intakeOverrideReason}”</p>
          </div>
        </Card>
      )}
      <p className="t-sub mt-4">
        {sourceWord(instrument.source)}
        {instrument.sourceFiles && instrument.sourceFiles.length > 0 ? ` · ${instrument.sourceFiles.join(" · ")}` : ""}
        {instrument.externalRef ? ` · Curricula Builder ref ${instrument.externalRef}` : ""}
        {!editable && " · Read-only on FPT Exam: corrections are made on Curricula Builder and pulled in as a new version."}
      </p>

      {/* ---------------- Outcomes & criteria (what the check measures against) ---------------- */}
      {editable && (
        <Card className="mt-5">
          <CardHead
            title="Outcomes and criteria the check measures against"
            subtitle={
              review?.sourceOfOutcomes === "saqa"
                ? "As read from the SAQA record. If SAQA's list is untidy — preambles, run-on lists, exit-point notes — tidy or edit it here and the check runs again."
                : review?.sourceOfOutcomes === "own_outcomes"
                  ? "As given by the Administrator. Edit them here and the check runs again."
                  : "The reference list for this paper. Edit it here and the check runs again."
            }
            right={
              !editingOutcomes ? (
                <button type="button" className="btn-ghost btn-sm" onClick={beginEditOutcomes} disabled={checking || fixing}>
                  Edit outcomes
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <button type="button" className="btn-ghost btn-sm" onClick={tidyOutcomes} disabled={tidying || savingOutcomes}>
                    {tidying ? "Tidying…" : "Tidy up with AI"}
                  </button>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setEditingOutcomes(false)} disabled={savingOutcomes}>
                    Cancel
                  </button>
                  <button type="button" className="btn btn-sm" onClick={saveOutcomes} disabled={savingOutcomes || tidying}>
                    {savingOutcomes ? "Saving…" : "Save and re-check"}
                  </button>
                </div>
              )
            }
          />
          {editingOutcomes && (
            <div className="px-5 pb-5 space-y-3">
              {tidyNote && <p className="text-[13px] rounded-lg border border-brand-100 bg-brand-50/40 px-3 py-2">{tidyNote}</p>}
              <div className="grid grid-cols-2 gap-3.5">
                <div>
                  <label className="field-lbl">Exit level outcomes <span className="normal-case font-normal text-ink-faint">(one per line · {lines(eloText).length})</span></label>
                  <textarea className="inp font-normal text-[13px]" rows={14} value={eloText} onChange={(e) => setEloText(e.target.value)} />
                </div>
                <div>
                  <label className="field-lbl">Assessment criteria <span className="normal-case font-normal text-ink-faint">(one per line · {lines(acText).length})</span></label>
                  <textarea className="inp font-normal text-[13px]" rows={14} value={acText} onChange={(e) => setAcText(e.target.value)} />
                </div>
              </div>
              <p className="t-sub">Each line should be one competence a learner demonstrates. Remove preambles, exit-point notes and text about how assessment is conducted — a paper cannot "cover" those. Saving keeps the original SAQA/document list on record and re-runs the check against your list.</p>
            </div>
          )}
        </Card>
      )}

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
                      ? "the outcomes read from the uploaded document"
                      : review.sourceOfOutcomes === "own_outcomes"
                        ? "the outcomes you gave"
                        : review.sourceOfOutcomes === "curricula_builder"
                          ? "the outcomes supplied by Curricula Builder"
                          : "the paper's own outcome references only"}
                </p>
              </div>
              <div className="border-l border-line pl-5">
                <p className="text-sm">{plain(review.summary)}</p>
                {review.verdict === "meets_with_minor_gaps" && editable && (
                  <p className="mt-2 text-[13px]">
                    Ready to schedule as it is.{" "}
                    <button type="button" className="lnk" onClick={fixGaps} disabled={fixing || checking}>
                      Close the remaining gaps with AI
                    </button>
                  </p>
                )}
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
                <CardHead title="Paper shape" subtitle="FPT exam standard: at least 20 multiple choice · 6 knowledge-and-depth · 6 comprehensive" right={review.profile.shape ? (review.profile.shape.meets ? <Badge tone="green">Meets the shape</Badge> : <Badge tone="amber">Short of the shape</Badge>) : undefined} />
                {review.profile.shape && (
                  <div className="px-5 py-3 border-b border-line text-[13px]">
                    <div className="grid grid-cols-3 gap-2 text-center">
                      {([["Multiple choice", review.profile.shape.mcq, "20+"], ["Knowledge & depth", review.profile.shape.knowledge, "6"], ["Comprehensive", review.profile.shape.comprehensive, "6"]] as [string, number, string][]).map(([l, n, want]) => (
                        <div key={l} className="rounded-lg border border-line bg-surface-2 py-2"><div className="font-display font-extrabold text-lg tabular">{n}<span className="text-ink-faint text-[12px] font-normal"> / {want}</span></div><div className="t-sub">{l}</div></div>
                      ))}
                    </div>
                    {review.profile.shape.shortfalls.length > 0 && <ul className="mt-2 space-y-0.5 text-amber-800">{review.profile.shape.shortfalls.map((x) => <li key={x}>· {x}</li>)}</ul>}
                  </div>
                )}
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
          subtitle={editing ? "Editing — nothing is saved until you press Save" : `${instrument.questions.length} questions · ${totalMarks} marks`}
          right={
            <div className="flex items-center gap-2">
              {editable && !editing && (
                <button type="button" className="btn btn-sm" onClick={beginEdit} disabled={checking}>
                  Edit questions
                </button>
              )}
              {editing && (
                <>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(false)} disabled={saving}>
                    Cancel
                  </button>
                  <button type="button" className="btn btn-sm" onClick={saveEdit} disabled={saving}>
                    {saving ? "Saving…" : "Save and re-check"}
                  </button>
                </>
              )}
              {!editing && (
                <button type="button" className="btn-ghost btn-sm" onClick={() => setShowRubrics((v) => !v)}>
                  {showRubrics ? "Hide rubrics" : "Show rubrics"}
                </button>
              )}
            </div>
          }
        />

        {editing ? (
          <div className="px-5 pb-5">
            <div className="grid grid-cols-[160px_1fr] gap-3.5 items-end py-4 border-b border-line">
              <div>
                <label className="field-lbl">Time (minutes)</label>
                <input className="inp tabular" type="number" min={1} value={draftTime} onChange={(e) => setDraftTime(e.target.value)} />
              </div>
              <div>
                <label className="field-lbl">Pass rule</label>
                <input className="inp" value={draftRule} onChange={(e) => setDraftRule(e.target.value)} placeholder="e.g. 50% overall" />
              </div>
            </div>
            <ul className="divide-y divide-line">
              {draft.map((q, i) => (
                <li key={q.id} className="py-4 space-y-3">
                  <div className="flex items-center gap-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted w-10">Q{i + 1}</p>
                    <select className="inp !w-auto" value={q.type} onChange={(e) => updateQ(i, { type: e.target.value as Question["type"], options: e.target.value === "mcq" ? q.options ?? ["", "", "", ""] : undefined })}>
                      {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                    <label className="text-[12px] text-ink-muted flex items-center gap-1.5">
                      Marks <input className="inp !w-20 tabular" type="number" min={0} value={q.maxMark} onChange={(e) => updateQ(i, { maxMark: Number(e.target.value) })} />
                    </label>
                    <select className="inp !w-auto" value={q.bloomLevel ?? ""} onChange={(e) => updateQ(i, { bloomLevel: (e.target.value || undefined) as BloomLevel | undefined })}>
                      <option value="">Bloom's level…</option>
                      {BLOOM_ORDER.map((l) => <option key={l} value={l}>{BLOOM_LABEL[l]}</option>)}
                    </select>
                    <span className="ml-auto flex items-center gap-1">
                      <button type="button" className="btn-ghost btn-sm" onClick={() => moveQ(i, -1)} disabled={i === 0} title="Move up">↑</button>
                      <button type="button" className="btn-ghost btn-sm" onClick={() => moveQ(i, 1)} disabled={i === draft.length - 1} title="Move down">↓</button>
                      <button type="button" className="btn-ghost btn-sm text-red-700" onClick={() => setDraft((d) => d.filter((_, k) => k !== i))}>Remove</button>
                    </span>
                  </div>
                  <textarea className="inp font-normal" rows={3} value={q.prompt} onChange={(e) => updateQ(i, { prompt: e.target.value })} placeholder="The question as the learner will see it" />
                  {q.type === "mcq" && (
                    <div>
                      <label className="field-lbl">Options <span className="normal-case font-normal text-ink-faint">(one per line; put the correct one in the rubric)</span></label>
                      <textarea className="inp font-normal" rows={4} value={(q.options ?? []).join("\n")} onChange={(e) => updateQ(i, { options: e.target.value.split("\n") })} />
                    </div>
                  )}
                  <div>
                    <label className="field-lbl">Model answer / marking rubric</label>
                    <textarea className="inp font-normal" rows={3} value={q.modelAnswerOrRubric ?? ""} onChange={(e) => updateQ(i, { modelAnswerOrRubric: e.target.value })} placeholder="What earns the marks — specific enough for an assessor and the AI marker to apply" />
                  </div>
                  <div className="grid grid-cols-2 gap-3.5">
                    <div>
                      <label className="field-lbl">Outcome it evidences</label>
                      <input className="inp" value={q.eloRef ?? ""} onChange={(e) => updateQ(i, { eloRef: e.target.value })} placeholder="e.g. ELO 2" />
                    </div>
                    <div>
                      <label className="field-lbl">Criterion</label>
                      <input className="inp" value={q.acRef ?? ""} onChange={(e) => updateQ(i, { acRef: e.target.value })} placeholder="e.g. AC 2.3" />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <div className="pt-4 flex items-center justify-between">
              <button type="button" className="btn-ghost" onClick={addQ}>+ Add a question</button>
              <p className="t-sub tabular">{draft.length} questions · {draft.reduce((s, q) => s + (Number(q.maxMark) || 0), 0)} marks</p>
            </div>
          </div>
        ) : (
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
        )}
      </Card>
    </>
  );
}
