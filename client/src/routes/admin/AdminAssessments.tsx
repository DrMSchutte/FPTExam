import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, pollJob } from "../../lib/api";
import type { Qualification, AssessmentInstrument, JobProgress, IntakeStatus } from "@shared/types";
import { PageHeader, Card, CardHead, Notice, Badge, Pill, Empty, PlusIcon } from "../../components/ui";
import type { BadgeTone } from "../../components/ui";
import JobProgressPanel from "../../components/JobProgressPanel";
import { VerdictBadge } from "../../components/standard";

// "Set up an Assessment" (docs/restructure-2026-09-05.md §2). FPT Exam does not
// author papers: the paper and its memo are uploaded (or, later, linked from
// Curricula Builder), read into structured questions, checked against the
// assessment standard, and gated on the result.

const INTAKE_STAGES = [
  "Identifying the qualification",
  "Reading the paper and memo",
  "Saving the paper",
  "Checking the paper against the assessment standard",
  "Saved",
];

export function GateBadge({ status }: { status: IntakeStatus }) {
  if (status === "ready") return <Badge tone="green">Ready to schedule</Badge>;
  if (status === "override") return <Badge tone="blue">Override · schedulable</Badge>;
  if (status === "blocked") return <Badge tone="amber">Blocked</Badge>;
  return <Badge tone="gray">Checking…</Badge>;
}

export function sourceBadge(source: AssessmentInstrument["source"]): { label: string; tone: BadgeTone } {
  switch (source) {
    case "uploaded_paper": return { label: "Uploaded", tone: "green" };
    case "curricula_builder": return { label: "Curricula Builder", tone: "amber" };
    case "ai_generated": return { label: "AI · SAQA (legacy)", tone: "gray" };
    case "qcto_upload": return { label: "AI · QCTO doc (legacy)", tone: "gray" };
    default: return { label: "Manual (legacy)", tone: "gray" };
  }
}

const fmt = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export default function AdminAssessments() {
  const [qualifications, setQualifications] = useState<Qualification[]>([]);
  const [instruments, setInstruments] = useState<AssessmentInstrument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [route, setRoute] = useState<"upload" | "link">("upload");

  // Form
  const [qualMode, setQualMode] = useState<"existing" | "saqa" | "manual">("saqa");
  const [qualificationId, setQualificationId] = useState("");
  const [saqaId, setSaqaId] = useState("");
  const [title, setTitle] = useState("");
  const [qType, setQType] = useState<"" | "fisa" | "eisa">("");
  const [nqf, setNqf] = useState("");
  const [version, setVersion] = useState("");
  const [time, setTime] = useState("");
  const [materials, setMaterials] = useState("");
  const [paperFile, setPaperFile] = useState<File | null>(null);
  const [memoFile, setMemoFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  async function loadAll() {
    const [q, i] = await Promise.all([api.get<Qualification[]>("/qualifications"), api.get<AssessmentInstrument[]>("/instruments")]);
    setQualifications(q);
    setInstruments(i.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  }
  useEffect(() => {
    loadAll().catch((err) => setError((err as Error).message));
  }, []);

  useEffect(() => {
    // Default to "existing" once there is something to pick from.
    if (qualifications.length > 0 && qualMode === "saqa" && !saqaId) setQualMode("existing");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qualifications.length]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setNotes(null);
    setCreatedId(null);
    if (!paperFile) {
      setError("Choose the question paper to upload.");
      return;
    }
    if (qualMode === "existing" && !qualificationId) return setError("Pick the qualification.");
    if (qualMode === "saqa" && !saqaId.trim()) return setError("Enter the SAQA qualification ID.");
    if (qualMode === "manual" && !title.trim()) return setError("Enter the qualification title.");
    setBusy(true);
    setProgress(null);
    try {
      const form = new FormData();
      form.append("paper", paperFile);
      if (memoFile) form.append("memo", memoFile);
      form.append("version", version);
      if (qualMode === "existing") form.append("qualificationId", qualificationId);
      if (qualMode === "saqa") form.append("saqaQualificationId", saqaId.trim());
      if (qualMode === "manual" || title.trim()) form.append("title", title.trim());
      if (qType) form.append("qctoRegistrationType", qType);
      if (nqf) form.append("nqfLevel", nqf);
      if (time) form.append("timeAllocationMinutes", time);
      if (materials) form.append("permittedMaterials", materials);
      const { jobId } = await api.postForm<{ jobId: string }>("/assessments/intake", form);
      const done = await pollJob<{ instrument: AssessmentInstrument; coverageNotes: string; questionCount: number }>(`/instruments/jobs/${jobId}`, {
        onProgress: setProgress,
      });
      setMessage(`Paper read in: ${done.questionCount} questions. Standard check: ${verdictWord(done.instrument)}.`);
      setNotes(done.coverageNotes || null);
      setCreatedId(done.instrument.id);
      setVersion("");
      setPaperFile(null);
      setMemoFile(null);
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function verdictWord(i: AssessmentInstrument) {
    if (i.intakeStatus === "ready") return i.qualityReview?.verdict === "meets_standard" ? "meets the standard — ready to schedule" : "minor gaps — ready to schedule";
    if (i.intakeStatus === "blocked") return "does not meet the standard — blocked until fixed or overridden";
    return i.intakeStatus;
  }

  const qualTitle = (id: string) => qualifications.find((q) => q.id === id)?.title ?? "—";
  const readyCount = instruments.filter((i) => i.intakeStatus === "ready" || i.intakeStatus === "override").length;
  const blockedCount = instruments.filter((i) => i.intakeStatus === "blocked").length;

  return (
    <>
      <PageHeader
        title="Set up an Assessment"
        subtitle="Bring the paper and its memo in. It is read into questions, checked against the assessment standard, and only a paper that passes can be scheduled."
        action={
          <button className="btn whitespace-nowrap" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "Close" : <><PlusIcon /> Add an assessment</>}
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

      {showCreate && (
        <Card className="mb-6">
          <CardHead title="Add an assessment" subtitle="Upload the paper as issued, or link one from Curricula Builder." />
          <div className="flex gap-1 px-5 pt-3.5 border-b border-line">
            {[
              { k: "upload" as const, label: "Upload the paper" },
              { k: "link" as const, label: "Link from Curricula Builder", soon: true },
            ].map((t) => (
              <button
                key={t.k}
                type="button"
                disabled={t.soon}
                onClick={() => !t.soon && setRoute(t.k)}
                className={
                  "px-3.5 py-2 -mb-px font-display text-[13px] font-semibold border-b-2 transition " +
                  (route === t.k ? "text-brand-700 border-brand-600" : "text-ink-faint border-transparent hover:text-ink-muted") +
                  (t.soon ? " opacity-60 cursor-not-allowed" : "")
                }
              >
                {t.label}
                {t.soon && <span className="ml-2 badge bg-surface-2 text-ink-faint border border-line badge-plain">soon</span>}
              </button>
            ))}
          </div>

          {route === "upload" && (
            <form onSubmit={submit} className="px-5 pt-4 pb-5 space-y-5">
              {/* --- Which qualification --- */}
              <div>
                <p className="field-lbl">Which qualification is this paper for?</p>
                <div className="inline-flex rounded-lg border border-line-strong p-0.5 bg-surface mb-3">
                  {[
                    { k: "existing" as const, label: "Already on the system", show: qualifications.length > 0 },
                    { k: "saqa" as const, label: "By SAQA ID", show: true },
                    { k: "manual" as const, label: "Type the details", show: true },
                  ]
                    .filter((o) => o.show)
                    .map((o) => (
                      <button
                        key={o.k}
                        type="button"
                        onClick={() => setQualMode(o.k)}
                        className={
                          "px-3.5 py-1.5 rounded-md text-[13px] font-semibold transition " +
                          (qualMode === o.k ? "bg-brand-50 text-brand-700" : "text-ink-muted hover:text-ink")
                        }
                      >
                        {o.label}
                      </button>
                    ))}
                </div>

                {qualMode === "existing" && (
                  <select className="inp max-w-xl" value={qualificationId} onChange={(e) => setQualificationId(e.target.value)}>
                    <option value="">Choose…</option>
                    {qualifications.map((q) => (
                      <option key={q.id} value={q.id}>
                        {q.title}
                        {q.saqaQualificationId ? ` · SAQA ${q.saqaQualificationId}` : ""}
                      </option>
                    ))}
                  </select>
                )}

                {qualMode === "saqa" && (
                  <div className="grid grid-cols-[220px_1fr] gap-3.5 items-end">
                    <div>
                      <label className="field-lbl">SAQA qualification ID</label>
                      <input className="inp tabular" value={saqaId} onChange={(e) => setSaqaId(e.target.value)} placeholder="e.g. 67229" />
                    </div>
                    <p className="text-[12.5px] text-ink-muted pb-2">
                      Title, NQF level and the registered outcomes and criteria are fetched from SAQA and the qualification is created for you. The paper is then checked against those outcomes.
                    </p>
                  </div>
                )}

                {qualMode === "manual" && (
                  <div className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-3.5 items-end">
                    <div>
                      <label className="field-lbl">Title</label>
                      <input className="inp" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Occupational Certificate: Electrician" />
                    </div>
                    <div>
                      <label className="field-lbl">QCTO type</label>
                      <select className="inp" value={qType} onChange={(e) => setQType(e.target.value as "" | "fisa" | "eisa")}>
                        <option value="">Auto</option>
                        <option value="eisa">EISA</option>
                        <option value="fisa">FISA (legacy)</option>
                      </select>
                    </div>
                    <div>
                      <label className="field-lbl">NQF level</label>
                      <select className="inp" value={nqf} onChange={(e) => setNqf(e.target.value)}>
                        <option value="">—</option>
                        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="field-lbl">SAQA ID <span className="normal-case font-normal text-ink-faint">(optional)</span></label>
                      <input className="inp tabular" value={saqaId} onChange={(e) => setSaqaId(e.target.value)} placeholder="if known" />
                    </div>
                  </div>
                )}
              </div>

              {/* --- The documents --- */}
              <div className="grid grid-cols-2 gap-3.5">
                <div className="rounded-lg border border-line p-3.5">
                  <label className="field-lbl">Question paper <span className="text-red-600 normal-case font-normal">required</span></label>
                  <input
                    type="file"
                    accept=".pdf,.docx,.doc,.txt"
                    onChange={(e) => setPaperFile(e.target.files?.[0] ?? null)}
                    className="block w-full text-sm text-ink-muted file:mr-3 file:rounded-md file:border-0 file:bg-brand-50 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-brand-700"
                  />
                  <p className="t-sub mt-1.5">Word or PDF, as issued. If the memo is inside the same document, that's fine.</p>
                </div>
                <div className="rounded-lg border border-line p-3.5">
                  <label className="field-lbl">Memorandum / marking guide <span className="normal-case font-normal text-ink-faint">(if separate)</span></label>
                  <input
                    type="file"
                    accept=".pdf,.docx,.doc,.txt"
                    onChange={(e) => setMemoFile(e.target.files?.[0] ?? null)}
                    className="block w-full text-sm text-ink-muted file:mr-3 file:rounded-md file:border-0 file:bg-blue-50 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-blue-700"
                  />
                  <p className="t-sub mt-1.5">Without a marking guide the paper cannot be AI-marked and the check will say so.</p>
                </div>
              </div>

              {/* --- Paper details --- */}
              <div className="grid grid-cols-[1fr_1fr_2fr] gap-3.5 items-end">
                <div>
                  <label className="field-lbl">Version / paper reference</label>
                  <input className="inp" value={version} onChange={(e) => setVersion(e.target.value)} required placeholder="e.g. 2026-v1 or Paper A" />
                </div>
                <div>
                  <label className="field-lbl">Time (minutes) <span className="normal-case font-normal text-ink-faint">(if not on the paper)</span></label>
                  <input className="inp tabular" type="number" min={1} value={time} onChange={(e) => setTime(e.target.value)} placeholder="read from paper" />
                </div>
                <div>
                  <label className="field-lbl">Permitted materials <span className="normal-case font-normal text-ink-faint">(comma-separated)</span></label>
                  <input className="inp" value={materials} onChange={(e) => setMaterials(e.target.value)} placeholder="e.g. Non-programmable calculator" />
                </div>
              </div>

              <div className="flex items-center gap-3">
                <button disabled={busy} className="btn">
                  {busy ? "Working…" : "Read in and check the paper"}
                </button>
                <span className="t-sub">Usually 2–5 minutes. You can leave this page; the paper appears in the list when done.</span>
              </div>
              <JobProgressPanel title="Bringing the paper in" stages={INTAKE_STAGES} progress={progress} active={busy} />
              {notes && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3.5 text-[13px] text-amber-900 whitespace-pre-wrap">
                  <p className="font-semibold mb-1">Notes from reading the paper</p>
                  {notes}
                </div>
              )}
            </form>
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
        <CardHead title="All assessments" subtitle="Every paper on the system and where it stands" />
        <div className="px-2 pb-2">
          {instruments.length ? (
            <table className="data">
              <thead>
                <tr>
                  <th>Qualification</th>
                  <th>Paper</th>
                  <th>Questions</th>
                  <th>Time</th>
                  <th>Source</th>
                  <th>Standard check</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {instruments.map((i) => {
                  const b = sourceBadge(i.source);
                  const q = qualifications.find((x) => x.id === i.qualificationId);
                  return (
                    <tr key={i.id}>
                      <td>
                        <div className="flex items-center gap-2">
                          {q && <Pill tone={q.qctoRegistrationType}>{q.qctoRegistrationType.toUpperCase()}</Pill>}
                          <span className="font-semibold">{qualTitle(i.qualificationId)}</span>
                        </div>
                        {q?.nqfLevel && <p className="t-sub">NQF Level {q.nqfLevel}</p>}
                      </td>
                      <td>
                        {i.version}
                        <p className="t-sub">{fmt(i.createdAt)}</p>
                      </td>
                      <td className="tabular">{i.questions.length}</td>
                      <td className="tabular">{i.timeAllocationMinutes} min</td>
                      <td><Badge tone={b.tone}>{b.label}</Badge></td>
                      <td><VerdictBadge verdict={i.qualityReview?.verdict ?? null} /></td>
                      <td><GateBadge status={i.intakeStatus} /></td>
                      <td className="text-right">
                        <Link to={`/admin/assessments/${i.id}`} className="lnk">Open</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <Empty>No assessments yet — add the first one above.</Empty>
          )}
        </div>
      </Card>
    </>
  );
}
