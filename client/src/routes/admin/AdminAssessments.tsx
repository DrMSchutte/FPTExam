import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, pollJob } from "../../lib/api";
import type { Qualification, AssessmentInstrument, JobProgress, IntakeRoute } from "@shared/types";
import { PageHeader, Card, CardHead, Notice, Badge, TypePill, Empty, PlusIcon } from "../../components/ui";
import JobProgressPanel from "../../components/JobProgressPanel";
import { VerdictBadge } from "../../components/standard";
import { ROUTES, routeMeta, RouteBadge, RouteCard, GateBadge } from "../../components/intake";

// "Set up an Assessment" — four routes (docs/restructure-2026-09-05.md §2, rule of
// 9 Sep 2026). The first question is what kind of assessment this is; the answer
// fixes where the paper may come from. QCTO papers are only ever linked in from
// Curricula Builder. Legacy FISA and non-QCTO assessments are drafted here.

const STAGES = {
  legacyDraft: ["Fetching the SAQA record", "Extracting outcomes and criteria", "Drafting questions and marking rubrics", "Checking the paper against the assessment standard", "Saved"],
  buildDraftDoc: ["Reading outcomes and criteria from the document", "Drafting questions and marking rubrics", "Checking the paper against the assessment standard", "Saved"],
  buildDraft: ["Drafting questions and marking rubrics", "Checking the paper against the assessment standard", "Saved"],
  intake: ["Identifying the qualification", "Reading the paper and memo", "Saving the paper", "Checking the paper against the assessment standard", "Saved"],
  cbImport: ["Fetching the assessment from Curricula Builder", "Identifying the qualification", "Checking the paper against the assessment standard", "Saved"],
};

type DraftResult = { instrument: AssessmentInstrument; coverageNotes: string; questionCount: number };

const fmt = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function verdictWord(i: AssessmentInstrument) {
  if (i.intakeStatus === "ready") return i.qualityReview?.verdict === "meets_standard" ? "meets the standard — ready to schedule" : "minor gaps — ready to schedule";
  if (i.intakeStatus === "blocked") return "does not meet the standard — blocked until fixed or overridden";
  return i.intakeStatus;
}

const fileInput = (onChange: (f: File | null) => void, tone: "brand" | "blue" = "brand") => (
  <input
    type="file"
    accept=".pdf,.docx,.doc,.txt"
    onChange={(e) => onChange(e.target.files?.[0] ?? null)}
    className={`block w-full text-sm text-ink-muted file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-1.5 file:text-xs file:font-semibold ${tone === "brand" ? "file:bg-brand-50 file:text-brand-700" : "file:bg-blue-50 file:text-blue-700"}`}
  />
);

// ---------------------------------------------------------------------------------

export default function AdminAssessments() {
  const [qualifications, setQualifications] = useState<Qualification[]>([]);
  const [instruments, setInstruments] = useState<AssessmentInstrument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const [route, setRoute] = useState<IntakeRoute | null>(null);

  async function loadAll() {
    const [q, i] = await Promise.all([api.get<Qualification[]>("/qualifications"), api.get<AssessmentInstrument[]>("/instruments")]);
    setQualifications(q);
    setInstruments(i.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  }
  useEffect(() => {
    loadAll().catch((err) => setError((err as Error).message));
  }, []);

  function onDone(done: DraftResult, what: string) {
    setMessage(`${what}: ${done.questionCount} questions. Standard check: ${verdictWord(done.instrument)}.`);
    setNotes(done.coverageNotes || null);
    setCreatedId(done.instrument.id);
    loadAll().catch(() => undefined);
  }
  function onStart() {
    setError(null);
    setMessage(null);
    setNotes(null);
    setCreatedId(null);
  }

  const qualOf = (id: string) => qualifications.find((q) => q.id === id);
  const retiredCount = instruments.filter((i) => i.retiredAt).length;
  const visible = instruments.filter((i) => showRetired || !i.retiredAt);
  const readyCount = visible.filter((i) => (i.intakeStatus === "ready" || i.intakeStatus === "override") && !i.supersededById).length;
  const blockedCount = visible.filter((i) => i.intakeStatus === "blocked").length;
  const meta = route ? routeMeta(route) : null;

  return (
    <>
      <PageHeader
        title="Set up an Assessment"
        subtitle="QCTO papers are linked in from Curricula Builder. Legacy FISA papers are drafted from SAQA. Anything outside the QCTO rules is built here. Every paper is checked against the assessment standard before it can be scheduled."
        action={
          <button className="btn whitespace-nowrap" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "Close" : <><PlusIcon /> Set up an assessment</>}
          </button>
        }
      />
      {error && <Notice kind="error">{error}</Notice>}
      {message && (
        <Notice kind="success">
          {message}{" "}
          {createdId && (
            <Link to={`/admin/assessments/${createdId}`} className="underline font-semibold">
              Open it
            </Link>
          )}
        </Notice>
      )}
      {notes && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3.5 text-[13px] text-amber-900 whitespace-pre-wrap">
          <p className="font-semibold mb-1">Notes from setting this assessment up</p>
          {notes}
        </div>
      )}

      {showCreate && (
        <Card className="mb-6">
          <CardHead title="What kind of assessment is this?" subtitle="The answer decides where the paper may come from." />
          <div className="grid grid-cols-4 gap-3 px-5 pt-4 pb-5">
            {ROUTES.map((r) => (
              <RouteCard key={r.key} meta={r} selected={route === r.key} onSelect={() => { setRoute(r.key); onStart(); }} />
            ))}
          </div>

          {meta && (
            <div className="border-t border-line px-5 pt-4 pb-5">
              <div className="flex items-center gap-2 mb-4">
                <RouteBadge route={meta.key} />
                <p className="text-[13px] text-ink-muted">{meta.builtHere ? "Drafted here by the AI, editable afterwards, then checked against the standard." : "Pulled from Curricula Builder as released there, then checked against the standard. Read-only on FPT Exam."}</p>
              </div>
              {meta.key === "qcto_curricula_builder" && <CurriculaBuilderPanel kind="qcto" onStart={onStart} onDone={(d) => onDone(d, "QCTO paper linked in")} onError={setError} />}
              {meta.key === "curricula_builder_other" && <CurriculaBuilderPanel kind="other" onStart={onStart} onDone={(d) => onDone(d, "Assessment linked in")} onError={setError} />}
              {meta.key === "legacy_saqa" && <LegacySaqaPanel onStart={onStart} onDone={onDone} onError={setError} />}
              {meta.key === "built_here" && <BuildHerePanel qualifications={qualifications.filter((q) => q.qctoRegistrationType === "non_qcto")} onStart={onStart} onDone={onDone} onError={setError} />}
            </div>
          )}
        </Card>
      )}

      <div className="grid grid-cols-3 gap-4 mb-6">
        <Card className="p-5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Assessments</p>
          <p className="font-display text-3xl font-extrabold mt-1 tabular">{instruments.length}</p>
        </Card>
        <Card className="p-5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Ready to schedule</p>
          <p className="font-display text-3xl font-extrabold mt-1 tabular text-brand-700">{readyCount}</p>
        </Card>
        <Card className="p-5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Blocked by the standard check</p>
          <p className="font-display text-3xl font-extrabold mt-1 tabular text-amber-700">{blockedCount}</p>
        </Card>
      </div>

      <Card>
        <CardHead title="All assessments" subtitle="Every paper on the system, how it came in, and where it stands" right={retiredCount > 0 ? <button type="button" className="lnk" onClick={() => setShowRetired(!showRetired)}>{showRetired ? "Hide retired" : `Show ${retiredCount} retired`}</button> : undefined} />
        <div className="px-2 pb-2">
          {instruments.length ? (
            <table className="data">
              <thead>
                <tr>
                  <th>Assessment</th>
                  <th>Route</th>
                  <th>Paper</th>
                  <th>Questions</th>
                  <th>Time</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((i) => {
                  const q = qualOf(i.qualificationId);
                  return (
                    <tr key={i.id}>
                      <td>
                        <div className="flex items-center gap-2">
                          {q && <TypePill type={q.qctoRegistrationType} />}
                          <span className="font-semibold">{q?.title ?? "—"}</span>
                        </div>
                        {q?.nqfLevel && <p className="t-sub">NQF Level {q.nqfLevel}</p>}
                      </td>
                      <td><RouteBadge route={i.intakeRoute} /></td>
                      <td>
                        {i.version}
                        <p className="t-sub">{fmt(i.createdAt)}</p>
                      </td>
                      <td className="tabular">{i.questions.length}</td>
                      <td className="tabular">{i.timeAllocationMinutes} min</td>
                      <td>
                        {i.retiredAt ? <Badge tone="gray">Retired</Badge> : i.supersededById ? <Badge tone="gray">Superseded</Badge> : <GateBadge status={i.intakeStatus} />}
                        <p className="t-sub mt-1">{i.retiredAt ? (i.retireReason ?? "Out of use") : i.supersededById ? "A newer version was pulled in from Curricula Builder" : <VerdictBadge verdict={i.qualityReview?.verdict ?? null} />}</p>
                      </td>
                      <td className="text-right">
                        <Link to={`/admin/assessments/${i.id}`} className="lnk">Open</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <Empty>No assessments yet — set up the first one above.</Empty>
          )}
        </div>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------------
// Shared pieces for the per-route panels
// ---------------------------------------------------------------------------------

type PanelProps = { onStart: () => void; onDone: (d: DraftResult, what: string) => void; onError: (m: string) => void };

function useJob() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  async function run(start: () => Promise<{ jobId: string }>): Promise<DraftResult> {
    setBusy(true);
    setProgress(null);
    try {
      const { jobId } = await start();
      return await pollJob<DraftResult>(`/instruments/jobs/${jobId}`, { onProgress: setProgress });
    } finally {
      setBusy(false);
    }
  }
  return { busy, progress, run };
}

function SubTabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { k: T; label: string }[] }) {
  return (
    <div className="inline-flex rounded-lg border border-line-strong p-0.5 bg-surface mb-4">
      {tabs.map((t) => (
        <button
          key={t.k}
          type="button"
          onClick={() => onChange(t.k)}
          className={"px-3.5 py-1.5 rounded-md text-[13px] font-semibold transition " + (value === t.k ? "bg-brand-50 text-brand-700" : "text-ink-muted hover:text-ink")}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function PaperDetails({ version, setVersion, time, setTime, materials, setMaterials, timeOptional }: {
  version: string; setVersion: (v: string) => void; time: string; setTime: (v: string) => void; materials: string; setMaterials: (v: string) => void; timeOptional?: boolean;
}) {
  return (
    <div className="grid grid-cols-[1fr_1fr_2fr] gap-3.5 items-end">
      <div>
        <label className="field-lbl">Version / paper reference</label>
        <input className="inp" value={version} onChange={(e) => setVersion(e.target.value)} required placeholder="e.g. 2026-v1 or Paper A" />
      </div>
      <div>
        <label className="field-lbl">Time (minutes){timeOptional && <span className="normal-case font-normal text-ink-faint"> (if not on the paper)</span>}</label>
        <input className="inp tabular" type="number" min={1} value={time} onChange={(e) => setTime(e.target.value)} required={!timeOptional} placeholder={timeOptional ? "read from paper" : "e.g. 180"} />
      </div>
      <div>
        <label className="field-lbl">Permitted materials <span className="normal-case font-normal text-ink-faint">(comma-separated)</span></label>
        <input className="inp" value={materials} onChange={(e) => setMaterials(e.target.value)} placeholder="e.g. Non-programmable calculator" />
      </div>
    </div>
  );
}

function PaperUploads({ setPaper, setMemo }: { setPaper: (f: File | null) => void; setMemo: (f: File | null) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3.5">
      <div className="rounded-lg border border-line p-3.5">
        <label className="field-lbl">Question paper <span className="text-red-600 normal-case font-normal">required</span></label>
        {fileInput(setPaper)}
        <p className="t-sub mt-1.5">Word or PDF, as issued. If the memo is inside the same document, that's fine.</p>
      </div>
      <div className="rounded-lg border border-line p-3.5">
        <label className="field-lbl">Memorandum / marking guide <span className="normal-case font-normal text-ink-faint">(if separate)</span></label>
        {fileInput(setMemo, "blue")}
        <p className="t-sub mt-1.5">Without a marking guide the paper cannot be AI-marked and the check will say so.</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------
// Legacy FISA — SAQA
// ---------------------------------------------------------------------------------

function LegacySaqaPanel({ onStart, onDone, onError }: PanelProps) {
  const [mode, setMode] = useState<"draft" | "upload">("draft");
  const [saqaId, setSaqaId] = useState("");
  const [version, setVersion] = useState("");
  const [time, setTime] = useState("");
  const [materials, setMaterials] = useState("");
  const [paper, setPaper] = useState<File | null>(null);
  const [memo, setMemo] = useState<File | null>(null);
  const job = useJob();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    onStart();
    if (!saqaId.trim()) return onError("Enter the SAQA qualification ID.");
    try {
      if (mode === "draft") {
        const done = await job.run(() =>
          api.post<{ jobId: string }>("/assessments/legacy-saqa/draft", {
            saqaQualificationId: saqaId.trim(),
            version,
            timeAllocationMinutes: Number(time),
            permittedMaterials: materials.split(",").map((m) => m.trim()).filter(Boolean),
          })
        );
        onDone(done, "Legacy FISA paper drafted from SAQA");
      } else {
        if (!paper) return onError("Choose the question paper to upload.");
        const form = new FormData();
        form.append("intakeRoute", "legacy_saqa");
        form.append("saqaQualificationId", saqaId.trim());
        form.append("version", version);
        form.append("paper", paper);
        if (memo) form.append("memo", memo);
        if (time) form.append("timeAllocationMinutes", time);
        if (materials) form.append("permittedMaterials", materials);
        const done = await job.run(() => api.postForm<{ jobId: string }>("/assessments/intake", form));
        onDone(done, "Legacy FISA paper read in");
      }
      setVersion("");
      setPaper(null);
      setMemo(null);
    } catch (err) {
      onError((err as Error).message);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <SubTabs value={mode} onChange={setMode} tabs={[{ k: "draft", label: "Draft the paper from SAQA" }, { k: "upload", label: "I already have the paper" }]} />
      <div className="grid grid-cols-[220px_1fr] gap-3.5 items-end">
        <div>
          <label className="field-lbl">SAQA qualification ID</label>
          <input className="inp tabular" value={saqaId} onChange={(e) => setSaqaId(e.target.value)} placeholder="e.g. 67229" required />
        </div>
        <p className="text-[12.5px] text-ink-muted pb-2">
          Title, NQF level and the registered exit level outcomes and assessment criteria are fetched from SAQA; the qualification is created for you.{" "}
          {mode === "draft" ? "The AI drafts the full paper and memo from those outcomes." : "The paper you upload is checked against those outcomes."}{" "}
          An occupational (QCTO) qualification is refused here — its paper comes from Curricula Builder.
        </p>
      </div>
      {mode === "upload" && <PaperUploads setPaper={setPaper} setMemo={setMemo} />}
      <PaperDetails version={version} setVersion={setVersion} time={time} setTime={setTime} materials={materials} setMaterials={setMaterials} timeOptional={mode === "upload"} />
      <div className="flex items-center gap-3">
        <button disabled={job.busy} className="btn">{job.busy ? "Working…" : mode === "draft" ? "Draft the paper" : "Read in and check the paper"}</button>
        <span className="t-sub">Usually 2–5 minutes. You can leave this page; the paper appears in the list when done.</span>
      </div>
      <JobProgressPanel title={mode === "draft" ? "Drafting the legacy FISA paper" : "Bringing the paper in"} stages={mode === "draft" ? STAGES.legacyDraft : STAGES.intake} progress={job.progress} active={job.busy} />
    </form>
  );
}

// ---------------------------------------------------------------------------------
// Build from scratch — outside the QCTO rules
// ---------------------------------------------------------------------------------

function BuildHerePanel({ qualifications, onStart, onDone, onError }: PanelProps & { qualifications: Qualification[] }) {
  const [mode, setMode] = useState<"outcomes" | "upload">("outcomes");
  const [existingId, setExistingId] = useState("");
  const [title, setTitle] = useState("");
  const [nqf, setNqf] = useState("");
  const [version, setVersion] = useState("");
  const [time, setTime] = useState("");
  const [materials, setMaterials] = useState("");
  const [outcomes, setOutcomes] = useState("");
  const [criteria, setCriteria] = useState("");
  const [doc, setDoc] = useState<File | null>(null);
  const [paper, setPaper] = useState<File | null>(null);
  const [memo, setMemo] = useState<File | null>(null);
  const job = useJob();

  function identify(form: FormData) {
    if (existingId) form.append("qualificationId", existingId);
    else {
      form.append("title", title.trim());
      if (nqf) form.append("nqfLevel", nqf);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    onStart();
    if (!existingId && !title.trim()) return onError("Give the assessment a title.");
    try {
      if (mode === "outcomes") {
        if (!doc && !outcomes.trim()) return onError("Type the outcomes this assessment must test, or upload a document that contains them.");
        const form = new FormData();
        identify(form);
        form.append("version", version);
        form.append("timeAllocationMinutes", time);
        if (materials) form.append("permittedMaterials", materials);
        if (outcomes.trim()) form.append("outcomes", outcomes);
        if (criteria.trim()) form.append("criteria", criteria);
        if (doc) form.append("document", doc);
        const done = await job.run(() => api.postForm<{ jobId: string }>("/assessments/build/draft", form));
        onDone(done, "Assessment built");
      } else {
        if (!paper) return onError("Choose the question paper to upload.");
        const form = new FormData();
        form.append("intakeRoute", "built_here");
        identify(form);
        form.append("version", version);
        form.append("paper", paper);
        if (memo) form.append("memo", memo);
        if (time) form.append("timeAllocationMinutes", time);
        if (materials) form.append("permittedMaterials", materials);
        const done = await job.run(() => api.postForm<{ jobId: string }>("/assessments/intake", form));
        onDone(done, "Paper read in");
      }
      setVersion("");
      setDoc(null);
      setPaper(null);
      setMemo(null);
    } catch (err) {
      onError((err as Error).message);
    }
  }

  const stages = mode === "upload" ? STAGES.intake : doc ? STAGES.buildDraftDoc : STAGES.buildDraft;

  return (
    <form onSubmit={submit} className="space-y-5">
      <SubTabs value={mode} onChange={setMode} tabs={[{ k: "outcomes", label: "Build it from my outcomes" }, { k: "upload", label: "I already have the paper" }]} />

      <div>
        <p className="field-lbl">What is being assessed?</p>
        <div className="grid grid-cols-[2fr_1fr_1fr] gap-3.5 items-end">
          <div>
            <label className="field-lbl">Title</label>
            <input className="inp" value={title} onChange={(e) => { setTitle(e.target.value); setExistingId(""); }} placeholder="e.g. Bookkeeping Fundamentals — Short Course" disabled={!!existingId} />
          </div>
          <div>
            <label className="field-lbl">NQF level <span className="normal-case font-normal text-ink-faint">(if any)</span></label>
            <select className="inp" value={nqf} onChange={(e) => setNqf(e.target.value)} disabled={!!existingId}>
              <option value="">—</option>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          {qualifications.length > 0 && (
            <div>
              <label className="field-lbl">…or one already on the system</label>
              <select className="inp" value={existingId} onChange={(e) => setExistingId(e.target.value)}>
                <option value="">New</option>
                {qualifications.map((q) => <option key={q.id} value={q.id}>{q.title}</option>)}
              </select>
            </div>
          )}
        </div>
      </div>

      {mode === "outcomes" ? (
        <>
          <div className="grid grid-cols-2 gap-3.5">
            <div>
              <label className="field-lbl">Assessment outcomes <span className="normal-case font-normal text-ink-faint">(one per line)</span></label>
              <textarea className="inp font-normal" rows={6} value={outcomes} onChange={(e) => setOutcomes(e.target.value)} placeholder={"Record cash transactions in the cash book\nReconcile a bank statement to the cash book\n…"} />
            </div>
            <div>
              <label className="field-lbl">Assessment criteria <span className="normal-case font-normal text-ink-faint">(one per line, optional)</span></label>
              <textarea className="inp font-normal" rows={6} value={criteria} onChange={(e) => setCriteria(e.target.value)} placeholder={"Receipts and payments are recorded in the correct columns\nDifferences are identified and explained\n…"} />
            </div>
          </div>
          <div className="rounded-lg border border-line p-3.5">
            <label className="field-lbl">…or upload a document that lists the outcomes <span className="normal-case font-normal text-ink-faint">(optional; anything typed above is added to it)</span></label>
            {fileInput(setDoc)}
            <p className="t-sub mt-1.5">Word or PDF — a course outline, unit standard, module guide. The AI reads the outcomes and criteria out of it and builds the paper and memo from them.</p>
          </div>
        </>
      ) : (
        <PaperUploads setPaper={setPaper} setMemo={setMemo} />
      )}

      <PaperDetails version={version} setVersion={setVersion} time={time} setTime={setTime} materials={materials} setMaterials={setMaterials} timeOptional={mode === "upload"} />

      <div className="flex items-center gap-3">
        <button disabled={job.busy} className="btn">{job.busy ? "Working…" : mode === "outcomes" ? "Build the assessment" : "Read in and check the paper"}</button>
        <span className="t-sub">Usually 2–5 minutes. Afterwards you can edit any question on the assessment's page.</span>
      </div>
      <JobProgressPanel title={mode === "outcomes" ? "Building the assessment" : "Bringing the paper in"} stages={stages} progress={job.progress} active={job.busy} />
    </form>
  );
}

// ---------------------------------------------------------------------------------
// Curricula Builder — QCTO FISA/EISA, and other courses
// ---------------------------------------------------------------------------------

interface CbSummary {
  id: string;
  title: string;
  qualificationTitle: string;
  kind: "qcto" | "other";
  qctoRegistrationType?: "fisa" | "eisa" | null;
  saqaQualificationId?: string | null;
  nqfLevel?: number | null;
  version: string;
  updatedAt?: string;
  importedInstrumentId: string | null;
  importedStatus?: string | null;
  superseded?: boolean;
  earlierVersion?: { id: string; version: string } | null;
}
interface CbStatus { connected: boolean; sample: boolean; host: string | null; probe?: { ok: boolean; step: string; message: string; qcto?: number; other?: number; ms: number } }

function CurriculaBuilderPanel({ kind, onStart, onDone, onError }: PanelProps & { kind: "qcto" | "other" }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [status, setStatus] = useState<CbStatus | null>(null);
  const [probing, setProbing] = useState(false);
  const [list, setList] = useState<CbSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const job = useJob();

  const loadList = () => api.get<CbSummary[]>(`/assessments/curricula-builder/assessments?kind=${kind}`).then(setList);
  useEffect(() => {
    setList(null);
    setListError(null);
    api
      .get<CbStatus>("/assessments/curricula-builder/status")
      .then((s) => {
        setStatus(s);
        setConnected(s.connected);
        if (s.connected) return loadList();
      })
      .catch((err) => setListError((err as Error).message));
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  async function probe() {
    setProbing(true);
    try { setStatus(await api.get<CbStatus>("/assessments/curricula-builder/status?probe=1")); } catch (err) { onError((err as Error).message); } finally { setProbing(false); }
  }

  async function pull(a: CbSummary) {
    onStart();
    setImporting(a.id);
    try {
      const done = await job.run(() => api.post<{ jobId: string }>("/assessments/curricula-builder/import", { externalId: a.id, kind, version: a.version }));
      onDone(done, a.title);
      await loadList().catch(() => undefined);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setImporting(null);
    }
  }

  if (connected === null && !listError) return <p className="text-sm text-ink-muted">Checking the Curricula Builder connection…</p>;

  const connectionLine = status && (
    <div className="flex items-center gap-3 flex-wrap rounded-lg border border-line bg-surface px-3.5 py-2 text-[13px]">
      <span className={"h-2.5 w-2.5 rounded-full " + (status.probe ? (status.probe.ok ? "bg-brand-500" : "bg-red-500") : status.connected ? "bg-brand-300" : "bg-ink-faint")} />
      <span className="font-semibold">{status.connected ? (status.sample ? "Sample export" : `Connected · ${status.host}`) : "Not connected"}</span>
      {status.sample && <Badge tone="amber">Sample data — remove CURRICULA_BUILDER_MOCK when Curricula Builder is live</Badge>}
      {status.probe && <span className={status.probe.ok ? "text-ink-muted" : "text-red-700"}>{status.probe.message}{status.probe.ok ? ` ${status.probe.qcto ?? 0} QCTO · ${status.probe.other ?? 0} other · ${status.probe.ms} ms` : ""}</span>}
      <span className="flex-1" />
      {status.connected && <button type="button" className="btn-ghost btn-sm" onClick={probe} disabled={probing}>{probing ? "Testing…" : "Test connection"}</button>}
    </div>
  );

  if (connected === false) {
    return (
      <div className="rounded-xl border border-dashed border-line-strong bg-surface-2 p-5">
        <p className="font-display font-bold text-[15px]">Curricula Builder is not connected yet</p>
        <p className="text-sm text-ink-muted mt-1.5 max-w-2xl">
          {kind === "qcto"
            ? "This is the only way a QCTO FISA/EISA paper enters FPT Exam, so until the connection exists no QCTO paper can be scheduled — by design. "
            : "CPD and other Curricula Builder courses arrive through the same connection. "}
          Once Curricula Builder exposes its export (the contract is in <code className="text-[12px]">docs/curricula-builder-contract.md</code>) and the two secrets are set on the Repl —{" "}
          <code className="text-[12px]">CURRICULA_BUILDER_BASE_URL</code> and <code className="text-[12px]">CURRICULA_BUILDER_API_KEY</code> — the released papers appear here to pull in.
        </p>
        <p className="t-sub mt-3">Nothing on this route can be typed, uploaded or drafted on FPT Exam.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {connectionLine}
      {listError && <Notice kind="error">{listError}</Notice>}
      {!list ? (
        !listError && <p className="text-sm text-ink-muted">Reading released assessments from Curricula Builder…</p>
      ) : list.length === 0 ? (
        <Empty>Curricula Builder has no released {kind === "qcto" ? "QCTO papers" : "other-course assessments"} to pull in.</Empty>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Assessment</th>
              <th>Qualification / course</th>
              <th>Version</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.id}>
                <td className="font-semibold">{a.title}</td>
                <td>
                  <div className="flex items-center gap-2">
                    {a.qctoRegistrationType && <TypePill type={a.qctoRegistrationType} />}
                    <span>{a.qualificationTitle}</span>
                  </div>
                  <p className="t-sub">{[a.saqaQualificationId ? `SAQA ${a.saqaQualificationId}` : null, a.nqfLevel ? `NQF Level ${a.nqfLevel}` : null].filter(Boolean).join(" · ")}</p>
                </td>
                <td className="tabular">
                  {a.version}
                  {a.updatedAt && <p className="t-sub">released {fmt(a.updatedAt)}</p>}
                </td>
                <td className="text-right whitespace-nowrap">
                  {a.importedInstrumentId ? (
                    <>
                      {a.superseded ? <Badge tone="gray">Superseded</Badge> : <Badge tone="green">On FPT Exam</Badge>}
                      <Link to={`/admin/assessments/${a.importedInstrumentId}`} className="lnk ml-2">open</Link>
                    </>
                  ) : a.earlierVersion ? (
                    <>
                      <span className="t-sub mr-2">replaces {a.earlierVersion.version}</span>
                      <button type="button" className="btn btn-sm" disabled={job.busy} onClick={() => pull(a)}>
                        {importing === a.id ? "Pulling…" : "Pull new version"}
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn btn-sm" disabled={job.busy} onClick={() => pull(a)}>
                      {importing === a.id ? "Pulling…" : "Pull in"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <JobProgressPanel title="Linking the assessment in from Curricula Builder" stages={STAGES.cbImport} progress={job.progress} active={job.busy} />
      {list && <Badge tone="gray">Only assessments released on Curricula Builder are listed</Badge>}
    </div>
  );
}
