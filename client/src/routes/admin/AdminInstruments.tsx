import { useEffect, useState } from "react";
import { api, pollJob } from "../../lib/api";
import { Link } from "react-router-dom";
import type { JobProgress } from "@shared/types";
import JobProgressPanel, { DRAFT_STAGES_SAQA, DRAFT_STAGES_UPLOAD } from "../../components/JobProgressPanel";
import { VerdictBadge } from "../../components/standard";
import type { Qualification, AssessmentInstrument, Question, QuestionType } from "@shared/types";
import { PageHeader, Card, CardHead, Notice, Badge, Empty, PlusIcon } from "../../components/ui";
import type { BadgeTone } from "../../components/ui";

const QUESTION_TYPES: { value: QuestionType; label: string }[] = [
  { value: "mcq", label: "Multiple choice" },
  { value: "short_answer", label: "Short answer" },
  { value: "long_answer", label: "Long answer" },
  { value: "practical_upload", label: "Practical upload" },
];

function newBlankQuestion(): Question {
  return {
    id: crypto.randomUUID(),
    type: "short_answer",
    prompt: "",
    maxMark: 10,
    options: [],
    modelAnswerOrRubric: "",
  };
}

// The four ways an instrument can be created (spec Section 5). "curricula" is
// the FISA route - present from the start so the flow is visible, active once
// Curricula Builder exposes an API.
type Source = "manual" | "saqa" | "upload" | "curricula";

const SOURCE_TABS: { key: Source; label: string; disabled?: boolean }[] = [
  { key: "manual", label: "Manual entry" },
  { key: "saqa", label: "AI from SAQA" },
  { key: "upload", label: "AI from uploaded QCTO document" },
  { key: "curricula", label: "From Curricula Builder", disabled: true },
];

function sourceBadge(source: AssessmentInstrument["source"]): { label: string; tone: BadgeTone } {
  switch (source) {
    case "ai_generated": return { label: "AI · SAQA", tone: "green" };
    case "qcto_upload": return { label: "AI · Upload", tone: "teal" };
    case "curricula_builder": return { label: "Curricula Builder", tone: "amber" };
    default: return { label: "Manual", tone: "gray" };
  }
}

export default function AdminInstruments() {
  const [qualifications, setQualifications] = useState<Qualification[]>([]);
  const [instruments, setInstruments] = useState<AssessmentInstrument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [source, setSource] = useState<Source>("manual");

  async function loadAll() {
    const [q, i] = await Promise.all([
      api.get<Qualification[]>("/qualifications"),
      api.get<AssessmentInstrument[]>("/instruments"),
    ]);
    setQualifications(q);
    setInstruments(i);
  }

  useEffect(() => {
    loadAll();
  }, []);

  // ---- Manual entry ----
  const [instrQualId, setInstrQualId] = useState("");
  const [instrVersion, setInstrVersion] = useState("");
  const [instrTime, setInstrTime] = useState(120);
  const [questions, setQuestions] = useState<Question[]>([newBlankQuestion()]);

  function updateQuestion(id: string, patch: Partial<Question>) {
    setQuestions((qs) => qs.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  }

  async function createInstrument(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await api.post("/instruments", {
        qualificationId: instrQualId,
        version: instrVersion,
        timeAllocationMinutes: Number(instrTime),
        questions: questions.map((q) => ({
          ...q,
          maxMark: Number(q.maxMark),
          options: q.type === "mcq" ? q.options : undefined,
        })),
      });
      setMessage("Instrument created.");
      setInstrVersion("");
      setQuestions([newBlankQuestion()]);
      setShowCreate(false);
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // ---- AI from SAQA ----
  const [genQualId, setGenQualId] = useState("");
  const [genVersion, setGenVersion] = useState("");
  const [genTime, setGenTime] = useState(120);
  const [genMaterials, setGenMaterials] = useState("");
  const [genLoading, setGenLoading] = useState(false);
  const [genCoverageNotes, setGenCoverageNotes] = useState<string | null>(null);
  const [genProgress, setGenProgress] = useState<JobProgress | null>(null);

  async function generateFromSaqa(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setGenCoverageNotes(null);
    setGenProgress(null);
    setGenLoading(true);
    try {
      const { jobId } = await api.post<{ jobId: string }>("/instruments/generate", {
        qualificationId: genQualId,
        version: genVersion,
        timeAllocationMinutes: Number(genTime),
        permittedMaterials: genMaterials ? genMaterials.split(",").map((s) => s.trim()).filter(Boolean) : [],
      });
      const done = await pollJob<{ instrument: AssessmentInstrument; coverageNotes: string; questionCount: number }>(
        `/instruments/jobs/${jobId}`,
        { onProgress: setGenProgress }
      );
      setMessage(`Instrument drafted from SAQA (${done.questionCount} questions). Open it to see the assessment-standard check.`);
      setGenCoverageNotes(done.coverageNotes);
      setGenVersion("");
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGenLoading(false);
    }
  }

  // ---- AI from uploaded QCTO document ----
  const [uploadQualId, setUploadQualId] = useState("");
  const [uploadVersion, setUploadVersion] = useState("");
  const [uploadTime, setUploadTime] = useState(120);
  const [uploadMaterials, setUploadMaterials] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadCoverageNotes, setUploadCoverageNotes] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<JobProgress | null>(null);

  async function generateFromUpload(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setUploadCoverageNotes(null);
    setUploadProgress(null);
    if (!uploadFile) {
      setError("Choose a document to upload first.");
      return;
    }
    setUploadLoading(true);
    try {
      const form = new FormData();
      form.append("document", uploadFile);
      form.append("qualificationId", uploadQualId);
      form.append("version", uploadVersion);
      form.append("timeAllocationMinutes", String(uploadTime));
      if (uploadMaterials) form.append("permittedMaterials", uploadMaterials);
      const { jobId } = await api.postForm<{ jobId: string }>("/instruments/generate-from-upload", form);
      const done = await pollJob<{ instrument: AssessmentInstrument; coverageNotes: string; questionCount: number }>(
        `/instruments/jobs/${jobId}`,
        { onProgress: setUploadProgress }
      );
      setMessage(`Instrument drafted from the uploaded document (${done.questionCount} questions). Open it to see the assessment-standard check.`);
      setUploadCoverageNotes(done.coverageNotes);
      setUploadVersion("");
      setUploadFile(null);
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploadLoading(false);
    }
  }

  const QualSelect = ({ value, onChange, onlyWithSaqa = false }: { value: string; onChange: (v: string) => void; onlyWithSaqa?: boolean }) => (
    <select className="inp" value={value} onChange={(e) => onChange(e.target.value)} required>
      <option value="">Select…</option>
      {qualifications.filter((q) => !onlyWithSaqa || q.saqaQualificationId).map((q) => (
        <option key={q.id} value={q.id}>{q.title}</option>
      ))}
    </select>
  );

  const CoverageNotes = ({ notes }: { notes: string | null }) =>
    notes ? (
      <div className="mt-4 rounded-lg border border-brand-100 bg-brand-50 p-3.5 text-xs text-ink whitespace-pre-wrap">
        <p className="font-semibold text-brand-700 mb-1">Coverage notes from the AI</p>
        {notes}
      </div>
    ) : null;

  return (
    <>
      <PageHeader
        title="Assessment Instruments"
        subtitle="The paper, marking rubric and time allocation attached to a qualification."
        action={
          <button className="btn whitespace-nowrap" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "Close" : <><PlusIcon /> New instrument</>}
          </button>
        }
      />

      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}

      {showCreate && (
        <Card className="mb-5">
          <CardHead title="New instrument" subtitle="Build the paper by hand, or let the AI draft it — the marking rubric is created alongside every question." />
          <div className="flex gap-1 px-5 pt-3.5 border-b border-line">
            {SOURCE_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                disabled={tab.disabled}
                onClick={() => setSource(tab.key)}
                className={
                  "px-3.5 py-2.5 -mb-px border-b-2 font-display text-[13px] font-semibold transition " +
                  (source === tab.key
                    ? "border-brand-600 text-brand-700"
                    : tab.disabled
                    ? "border-transparent text-ink-faint/60 cursor-not-allowed"
                    : "border-transparent text-ink-faint hover:text-ink-muted")
                }
                title={tab.disabled ? "Connects once Curricula Builder exposes an API" : undefined}
              >
                {tab.label}
                {tab.disabled && <span className="ml-1.5 pill bg-surface-2 text-ink-faint border border-line !text-[10px]">soon</span>}
              </button>
            ))}
          </div>

          <div className="px-5 pt-4 pb-5">
            {source === "manual" && (
              <form onSubmit={createInstrument} className="space-y-4">
                <div className="grid grid-cols-[2fr_1fr_1fr] gap-3.5">
                  <div><label className="field-lbl">Qualification</label><QualSelect value={instrQualId} onChange={setInstrQualId} /></div>
                  <div><label className="field-lbl">Version</label><input className="inp" value={instrVersion} onChange={(e) => setInstrVersion(e.target.value)} required placeholder="e.g. 2026-v1" /></div>
                  <div><label className="field-lbl">Time (minutes)</label><input className="inp tabular" type="number" min={1} value={instrTime} onChange={(e) => setInstrTime(Number(e.target.value))} required /></div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="field-lbl !mb-0">Questions</label>
                    <button type="button" onClick={() => setQuestions((qs) => [...qs, newBlankQuestion()])} className="lnk">+ Add question</button>
                  </div>
                  <div className="space-y-3">
                    {questions.map((q, idx) => (
                      <div key={q.id} className="rounded-lg border border-line p-3.5 space-y-2.5 bg-surface-2/50">
                        <div className="flex gap-2 items-center">
                          <span className="font-display font-bold text-xs text-ink-faint w-7">Q{idx + 1}</span>
                          <select className="inp !w-auto !py-1.5 text-xs" value={q.type} onChange={(e) => updateQuestion(q.id, { type: e.target.value as QuestionType })}>
                            {QUESTION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                          </select>
                          <label className="text-xs text-ink-faint ml-1">Max mark</label>
                          <input className="inp !w-20 !py-1.5 text-xs tabular" type="number" min={0} value={q.maxMark} onChange={(e) => updateQuestion(q.id, { maxMark: Number(e.target.value) })} />
                          {questions.length > 1 && (
                            <button type="button" onClick={() => setQuestions((qs) => qs.filter((x) => x.id !== q.id))} className="ml-auto text-xs text-red-600 hover:underline">Remove</button>
                          )}
                        </div>
                        <textarea className="inp" rows={2} value={q.prompt} onChange={(e) => updateQuestion(q.id, { prompt: e.target.value })} placeholder="Question prompt" required />
                        {q.type === "mcq" && (
                          <input className="inp" value={(q.options ?? []).join(", ")} onChange={(e) => updateQuestion(q.id, { options: e.target.value.split(",").map((s) => s.trim()) })} placeholder="Options, comma-separated" />
                        )}
                        <textarea className="inp !bg-amber-50/60" rows={2} value={q.modelAnswerOrRubric} onChange={(e) => updateQuestion(q.id, { modelAnswerOrRubric: e.target.value })} placeholder="Model answer / rubric criteria — never shown to the learner" />
                      </div>
                    ))}
                  </div>
                </div>
                <button className="btn">Create instrument</button>
              </form>
            )}

            {source === "saqa" && (
              <>
                <p className="text-xs text-ink-muted mb-4 max-w-prose">
                  Fetches the qualification's Exit Level Outcomes and Assessment Criteria from its public SAQA record and drafts a full paper mapped to them, each question with its rubric. Needs a SAQA ID set on the Qualifications page. Usable immediately; edit afterwards like any other instrument. Takes a minute or two.
                </p>
                <form onSubmit={generateFromSaqa} className="grid grid-cols-3 gap-3.5 items-end">
                  <div>
                    <label className="field-lbl">Qualification</label>
                    <QualSelect value={genQualId} onChange={setGenQualId} onlyWithSaqa />
                    {qualifications.filter((q) => q.saqaQualificationId).length === 0 && (
                      <p className="text-xs text-amber-700 mt-1.5">No qualification has a SAQA ID yet — set one on the Qualifications page first.</p>
                    )}
                  </div>
                  <div><label className="field-lbl">Version</label><input className="inp" value={genVersion} onChange={(e) => setGenVersion(e.target.value)} required placeholder="e.g. 2026-v1" /></div>
                  <div><label className="field-lbl">Time (minutes)</label><input className="inp tabular" type="number" min={1} value={genTime} onChange={(e) => setGenTime(Number(e.target.value))} required /></div>
                  <div className="col-span-2"><label className="field-lbl">Permitted materials <span className="normal-case font-normal text-ink-faint">(comma-separated)</span></label><input className="inp" value={genMaterials} onChange={(e) => setGenMaterials(e.target.value)} placeholder="e.g. Non-programmable calculator, SANS 10142-1 code book" /></div>
                  <button disabled={genLoading} className="btn">{genLoading ? "Drafting…" : "Draft from SAQA"}</button>
                </form>
                <JobProgressPanel title="Drafting from SAQA" stages={DRAFT_STAGES_SAQA} progress={genProgress} active={genLoading} />
                <CoverageNotes notes={genCoverageNotes} />
              </>
            )}

            {source === "upload" && (
              <>
                <p className="text-xs text-ink-muted mb-4 max-w-prose">
                  For a qualification where you hold the actual QCTO document — the Qualification Assessment Specifications / External Assessment Specifications from your AQP, as PDF or Word. The AI finds the outcomes and assessment criteria in it and drafts a full paper with rubrics, exactly as the SAQA path does.
                </p>
                <form onSubmit={generateFromUpload} className="grid grid-cols-3 gap-3.5 items-end">
                  <div><label className="field-lbl">Qualification</label><QualSelect value={uploadQualId} onChange={setUploadQualId} /></div>
                  <div><label className="field-lbl">Version</label><input className="inp" value={uploadVersion} onChange={(e) => setUploadVersion(e.target.value)} required placeholder="e.g. 2026-v1" /></div>
                  <div><label className="field-lbl">Time (minutes)</label><input className="inp tabular" type="number" min={1} value={uploadTime} onChange={(e) => setUploadTime(Number(e.target.value))} required /></div>
                  <div className="col-span-2"><label className="field-lbl">Permitted materials <span className="normal-case font-normal text-ink-faint">(comma-separated)</span></label><input className="inp" value={uploadMaterials} onChange={(e) => setUploadMaterials(e.target.value)} placeholder="e.g. Non-programmable calculator" /></div>
                  <div><label className="field-lbl">Document <span className="normal-case font-normal text-ink-faint">(PDF or .docx)</span></label><input type="file" accept=".pdf,.docx,.doc,.txt" onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)} required className="block w-full text-sm text-ink-muted file:mr-3 file:rounded-md file:border-0 file:bg-brand-50 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-brand-700" /></div>
                  <button disabled={uploadLoading} className="btn">{uploadLoading ? "Drafting…" : "Draft from document"}</button>
                </form>
                <JobProgressPanel title="Drafting from the uploaded document" stages={DRAFT_STAGES_UPLOAD} progress={uploadProgress} active={uploadLoading} />
                <CoverageNotes notes={uploadCoverageNotes} />
              </>
            )}
          </div>
        </Card>
      )}

      <Card>
        <CardHead title="All instruments" />
        <div className="px-2 pb-2">
          {instruments.length ? (
            <table className="data">
              <thead>
                <tr><th>Qualification</th><th>Version</th><th>Questions</th><th>Time</th><th>Source</th><th>Standard check</th><th></th></tr>
              </thead>
              <tbody>
                {instruments.map((i) => {
                  const b = sourceBadge(i.source);
                  return (
                    <tr key={i.id}>
                      <td className="font-semibold">{qualifications.find((q) => q.id === i.qualificationId)?.title ?? "—"}</td>
                      <td>{i.version}</td>
                      <td>{i.questions.length}</td>
                      <td>{i.timeAllocationMinutes} min</td>
                      <td><Badge tone={b.tone}>{b.label}</Badge></td>
                      <td><VerdictBadge verdict={i.qualityReview?.verdict ?? null} /></td>
                      <td className="text-right"><Link to={`/admin/instruments/${i.id}`} className="lnk">Open</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <Empty>No instruments yet — create the first one above.</Empty>
          )}
        </div>
      </Card>
    </>
  );
}
