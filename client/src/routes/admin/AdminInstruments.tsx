import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { Qualification, AssessmentInstrument, Question, QuestionType } from "@shared/types";

const QUESTION_TYPES: QuestionType[] = ["mcq", "short_answer", "long_answer", "practical_upload"];

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

type Source = "manual" | "saqa" | "upload";

const SOURCE_TABS: { key: Source; label: string }[] = [
  { key: "manual", label: "Manual entry" },
  { key: "saqa", label: "AI from SAQA" },
  { key: "upload", label: "AI from uploaded QCTO document" },
];

function sourceBadge(source: AssessmentInstrument["source"]) {
  switch (source) {
    case "ai_generated":
      return { label: "AI-generated (SAQA)", className: "bg-brand-50 text-brand-700" };
    case "qcto_upload":
      return { label: "AI-generated (upload)", className: "bg-teal-50 text-teal-700" };
    case "curricula_builder":
      return { label: "Curricula Builder", className: "bg-amber-50 text-amber-700" };
    default:
      return { label: "Manual", className: "bg-gray-100 text-gray-500" };
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
  function removeQuestion(id: string) {
    setQuestions((qs) => qs.filter((q) => q.id !== id));
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
      setMessage("Assessment instrument created.");
      setInstrVersion("");
      setQuestions([newBlankQuestion()]);
      setShowCreate(false);
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // ---- Generate from SAQA ----
  const [genQualId, setGenQualId] = useState("");
  const [genVersion, setGenVersion] = useState("");
  const [genTime, setGenTime] = useState(120);
  const [genMaterials, setGenMaterials] = useState("");
  const [genLoading, setGenLoading] = useState(false);
  const [genCoverageNotes, setGenCoverageNotes] = useState<string | null>(null);

  async function generateFromSaqa(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setGenCoverageNotes(null);
    setGenLoading(true);
    try {
      const created = await api.post<AssessmentInstrument & { coverageNotes: string }>(
        "/instruments/generate",
        {
          qualificationId: genQualId,
          version: genVersion,
          timeAllocationMinutes: Number(genTime),
          permittedMaterials: genMaterials
            ? genMaterials.split(",").map((s) => s.trim()).filter(Boolean)
            : [],
        }
      );
      setMessage(`Instrument generated from SAQA (${created.questions.length} questions).`);
      setGenCoverageNotes(created.coverageNotes);
      setGenVersion("");
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGenLoading(false);
    }
  }

  // ---- Generate from an uploaded QCTO document ----
  const [uploadQualId, setUploadQualId] = useState("");
  const [uploadVersion, setUploadVersion] = useState("");
  const [uploadTime, setUploadTime] = useState(120);
  const [uploadMaterials, setUploadMaterials] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadCoverageNotes, setUploadCoverageNotes] = useState<string | null>(null);

  async function generateFromUpload(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setUploadCoverageNotes(null);
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

      const created = await api.postForm<AssessmentInstrument & { coverageNotes: string }>(
        "/instruments/generate-from-upload",
        form
      );
      setMessage(`Instrument generated from uploaded document (${created.questions.length} questions).`);
      setUploadCoverageNotes(created.coverageNotes);
      setUploadVersion("");
      setUploadFile(null);
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploadLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-brand-700">Assessment Instruments</h1>
          <p className="text-sm text-gray-500 mt-1">
            The paper, marking guide, and time allocation attached to a qualification. Create one manually,
            or let the AI draft one from a SAQA record or an uploaded QCTO document.
          </p>
        </div>
        <button
          onClick={() => setShowCreate((v) => !v)}
          className="rounded bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700 whitespace-nowrap"
        >
          {showCreate ? "Close" : "+ New instrument"}
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {message && <p className="text-sm text-green-700">{message}</p>}

      {showCreate && (
        <section className="bg-white rounded-lg shadow p-6">
          <div className="flex gap-1 border-b border-gray-100 mb-5">
            {SOURCE_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setSource(tab.key)}
                className={
                  "px-3 py-2 text-sm font-medium border-b-2 -mb-px " +
                  (source === tab.key
                    ? "border-brand-600 text-brand-700"
                    : "border-transparent text-gray-400 hover:text-gray-600")
                }
              >
                {tab.label}
              </button>
            ))}
          </div>

          {source === "manual" && (
            <form onSubmit={createInstrument} className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-500">Qualification</label>
                  <select
                    value={instrQualId}
                    onChange={(e) => setInstrQualId(e.target.value)}
                    required
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  >
                    <option value="">Select...</option>
                    {qualifications.map((q) => (
                      <option key={q.id} value={q.id}>
                        {q.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500">Version</label>
                  <input
                    value={instrVersion}
                    onChange={(e) => setInstrVersion(e.target.value)}
                    required
                    placeholder="e.g. 2026-v1"
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500">Time allocation (minutes)</label>
                  <input
                    type="number"
                    min={1}
                    value={instrTime}
                    onChange={(e) => setInstrTime(Number(e.target.value))}
                    required
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-gray-500">Questions</label>
                  <button
                    type="button"
                    onClick={() => setQuestions((qs) => [...qs, newBlankQuestion()])}
                    className="text-xs text-brand-600 underline"
                  >
                    + Add question
                  </button>
                </div>
                {questions.map((q, idx) => (
                  <div key={q.id} className="border border-gray-200 rounded p-3 space-y-2">
                    <div className="flex gap-2 items-start">
                      <span className="text-xs text-gray-400 pt-2 w-6">Q{idx + 1}</span>
                      <select
                        value={q.type}
                        onChange={(e) => updateQuestion(q.id, { type: e.target.value as QuestionType })}
                        className="rounded border border-gray-300 px-2 py-1 text-sm"
                      >
                        {QUESTION_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min={0}
                        value={q.maxMark}
                        onChange={(e) => updateQuestion(q.id, { maxMark: Number(e.target.value) })}
                        className="rounded border border-gray-300 px-2 py-1 text-sm w-20"
                        title="Max mark"
                      />
                      <button
                        type="button"
                        onClick={() => removeQuestion(q.id)}
                        className="text-xs text-red-500 ml-auto"
                      >
                        Remove
                      </button>
                    </div>
                    <textarea
                      value={q.prompt}
                      onChange={(e) => updateQuestion(q.id, { prompt: e.target.value })}
                      placeholder="Question prompt"
                      required
                      className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                      rows={2}
                    />
                    {q.type === "mcq" && (
                      <input
                        value={(q.options ?? []).join(", ")}
                        onChange={(e) =>
                          updateQuestion(q.id, { options: e.target.value.split(",").map((s) => s.trim()) })
                        }
                        placeholder="Options, comma-separated"
                        className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                      />
                    )}
                    <textarea
                      value={q.modelAnswerOrRubric}
                      onChange={(e) => updateQuestion(q.id, { modelAnswerOrRubric: e.target.value })}
                      placeholder="Model answer / rubric criteria (never shown to the learner)"
                      className="w-full rounded border border-gray-300 px-3 py-2 text-sm bg-amber-50"
                      rows={2}
                    />
                  </div>
                ))}
              </div>

              <button className="rounded bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700">
                Create instrument
              </button>
            </form>
          )}

          {source === "saqa" && (
            <>
              <p className="text-xs text-gray-400 mb-4">
                Fetches the qualification's Exit Level Outcomes and Associated Assessment Criteria from its
                public SAQA record and drafts a full paper mapped to them. Requires a SAQA ID set on the
                Qualifications page first. The result is usable immediately - edit it afterwards like any
                other instrument if anything needs fixing. This can take a minute or two.
              </p>
              <form onSubmit={generateFromSaqa} className="grid grid-cols-3 gap-3 items-end">
                <div>
                  <label className="block text-xs text-gray-500">Qualification</label>
                  <select
                    value={genQualId}
                    onChange={(e) => setGenQualId(e.target.value)}
                    required
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  >
                    <option value="">Select...</option>
                    {qualifications
                      .filter((q) => q.saqaQualificationId)
                      .map((q) => (
                        <option key={q.id} value={q.id}>
                          {q.title}
                        </option>
                      ))}
                  </select>
                  {qualifications.filter((q) => q.saqaQualificationId).length === 0 && (
                    <p className="text-xs text-amber-600 mt-1">
                      No qualification has a SAQA ID set yet - add one on the Qualifications page first.
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-xs text-gray-500">Version</label>
                  <input
                    value={genVersion}
                    onChange={(e) => setGenVersion(e.target.value)}
                    required
                    placeholder="e.g. 2026-v1"
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500">Time allocation (minutes)</label>
                  <input
                    type="number"
                    min={1}
                    value={genTime}
                    onChange={(e) => setGenTime(Number(e.target.value))}
                    required
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-gray-500">Permitted materials (comma-separated)</label>
                  <input
                    value={genMaterials}
                    onChange={(e) => setGenMaterials(e.target.value)}
                    placeholder="e.g. Non-programmable calculator, SANS 10142-1 code book"
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <button
                  disabled={genLoading}
                  className="rounded bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
                >
                  {genLoading ? "Generating..." : "Generate from SAQA"}
                </button>
              </form>

              {genCoverageNotes && (
                <div className="mt-4 bg-brand-50 border border-brand-100 rounded p-3 text-xs text-gray-700 whitespace-pre-wrap">
                  <p className="font-medium text-brand-700 mb-1">Coverage notes from the AI:</p>
                  {genCoverageNotes}
                </div>
              )}
            </>
          )}

          {source === "upload" && (
            <>
              <p className="text-xs text-gray-400 mb-4">
                For a qualification where you have the actual QCTO document (a Qualification Assessment
                Specifications / External Assessment Specifications document from your AQP — PDF or .docx,
                not a SCORM package) rather than a SAQA ID. Upload it and the AI identifies the outcomes/
                assessment criteria in it and drafts a full paper mapped to them, the same as the SAQA path.
                Usable immediately; edit it afterwards like any other instrument if anything needs fixing.
              </p>
              <form onSubmit={generateFromUpload} className="grid grid-cols-3 gap-3 items-end">
                <div>
                  <label className="block text-xs text-gray-500">Qualification</label>
                  <select
                    value={uploadQualId}
                    onChange={(e) => setUploadQualId(e.target.value)}
                    required
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  >
                    <option value="">Select...</option>
                    {qualifications.map((q) => (
                      <option key={q.id} value={q.id}>
                        {q.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500">Version</label>
                  <input
                    value={uploadVersion}
                    onChange={(e) => setUploadVersion(e.target.value)}
                    required
                    placeholder="e.g. 2026-v1"
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500">Time allocation (minutes)</label>
                  <input
                    type="number"
                    min={1}
                    value={uploadTime}
                    onChange={(e) => setUploadTime(Number(e.target.value))}
                    required
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-gray-500">Permitted materials (comma-separated)</label>
                  <input
                    value={uploadMaterials}
                    onChange={(e) => setUploadMaterials(e.target.value)}
                    placeholder="e.g. Non-programmable calculator, SANS 10142-1 code book"
                    className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500">Document (PDF or .docx)</label>
                  <input
                    type="file"
                    accept=".pdf,.docx,.doc,.txt"
                    onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                    required
                    className="w-full text-sm"
                  />
                </div>
                <button
                  disabled={uploadLoading}
                  className="rounded bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
                >
                  {uploadLoading ? "Generating..." : "Generate from document"}
                </button>
              </form>

              {uploadCoverageNotes && (
                <div className="mt-4 bg-brand-50 border border-brand-100 rounded p-3 text-xs text-gray-700 whitespace-pre-wrap">
                  <p className="font-medium text-brand-700 mb-1">Coverage notes from the AI:</p>
                  {uploadCoverageNotes}
                </div>
              )}
            </>
          )}
        </section>
      )}

      <section className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-medium mb-4">All instruments</h2>
        <ul className="text-sm divide-y divide-gray-100">
          {instruments.map((i) => {
            const badge = sourceBadge(i.source);
            return (
              <li key={i.id} className="py-2.5 flex items-center gap-2">
                <span className="flex-1">
                  {qualifications.find((q) => q.id === i.qualificationId)?.title ?? i.qualificationId} —{" "}
                  {i.version} ({i.questions.length} questions, {i.timeAllocationMinutes}min)
                </span>
                <span className={"text-xs rounded-full px-2 py-0.5 " + badge.className}>{badge.label}</span>
              </li>
            );
          })}
          {instruments.length === 0 && <li className="py-2.5 text-gray-400">None yet.</li>}
        </ul>
      </section>
    </div>
  );
}
