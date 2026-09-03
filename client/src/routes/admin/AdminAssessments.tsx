import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type {
  Qualification,
  AssessmentInstrument,
  ExamSitting,
  PublicUser,
  Question,
  QuestionType,
} from "@shared/types";

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

export default function AdminAssessments() {
  const [qualifications, setQualifications] = useState<Qualification[]>([]);
  const [instruments, setInstruments] = useState<AssessmentInstrument[]>([]);
  const [sittings, setSittings] = useState<ExamSitting[]>([]);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function loadAll() {
    const [q, i, s, u] = await Promise.all([
      api.get<Qualification[]>("/qualifications"),
      api.get<AssessmentInstrument[]>("/instruments"),
      api.get<ExamSitting[]>("/sittings"),
      api.get<PublicUser[]>("/users"),
    ]);
    setQualifications(q);
    setInstruments(i);
    setSittings(s);
    setUsers(u);
  }

  useEffect(() => {
    loadAll();
  }, []);

  function assessors() {
    return users.filter((u) => u.roles.includes("assessor"));
  }
  function invigilators() {
    return users.filter((u) => u.roles.includes("invigilator"));
  }
  function learners() {
    return users.filter((u) => u.roles.includes("learner"));
  }

  // ---- Qualification form ----
  const [qTitle, setQTitle] = useState("");
  const [qType, setQType] = useState<"fisa" | "eisa">("eisa");
  const [qSaqaId, setQSaqaId] = useState("");

  async function createQualification(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await api.post("/qualifications", {
        title: qTitle,
        qctoRegistrationType: qType,
        saqaQualificationId: qSaqaId || undefined,
      });
      setQTitle("");
      setQSaqaId("");
      setMessage("Qualification created.");
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // ---- Inline "set SAQA ID" editor for existing qualifications ----
  const [saqaEditId, setSaqaEditId] = useState<string | null>(null);
  const [saqaEditValue, setSaqaEditValue] = useState("");

  async function saveSaqaId(qualificationId: string) {
    setError(null);
    setMessage(null);
    try {
      await api.patch(`/qualifications/${qualificationId}`, { saqaQualificationId: saqaEditValue });
      setSaqaEditId(null);
      setMessage("SAQA qualification ID saved.");
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // ---- Instrument form ----
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

  // ---- Sitting form ----
  const [sitQualId, setSitQualId] = useState("");
  const [sitInstrId, setSitInstrId] = useState("");
  const [sitStart, setSitStart] = useState("");
  const [sitEnd, setSitEnd] = useState("");
  const [sitAssessorId, setSitAssessorId] = useState("");
  const [sitInvigilatorIds, setSitInvigilatorIds] = useState<string[]>([]);
  const [sitIndependent, setSitIndependent] = useState(false);

  function toggleInvigilator(id: string) {
    setSitInvigilatorIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function createSitting(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await api.post("/sittings", {
        qualificationId: sitQualId,
        instrumentId: sitInstrId,
        startTime: new Date(sitStart).toISOString(),
        endTime: new Date(sitEnd).toISOString(),
        assignedAssessorId: sitAssessorId,
        invigilatorIds: sitInvigilatorIds,
        independentInvigilationRequired: sitIndependent,
      });
      setMessage("Exam sitting created.");
      setSitInvigilatorIds([]);
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // ---- Assign learners ----
  const [assignSittingId, setAssignSittingId] = useState("");
  const [assignLearnerIds, setAssignLearnerIds] = useState<string[]>([]);

  function toggleAssignLearner(id: string) {
    setAssignLearnerIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function assignLearners(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      const res = await api.post<{ assigned: number; alreadyAssigned: number }>(
        `/sittings/${assignSittingId}/assign-learners`,
        { learnerIds: assignLearnerIds }
      );
      setMessage(`Assigned ${res.assigned} learner(s) (${res.alreadyAssigned} were already on this sitting).`);
      setAssignLearnerIds([]);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-8">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {message && <p className="text-sm text-green-700">{message}</p>}

      {/* Qualifications */}
      <section className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-medium mb-4">Qualifications</h2>
        <form onSubmit={createQualification} className="flex flex-wrap gap-3 items-end mb-4">
          <div>
            <label className="block text-xs text-gray-500">Title</label>
            <input
              value={qTitle}
              onChange={(e) => setQTitle(e.target.value)}
              required
              className="rounded border border-gray-300 px-3 py-2 text-sm w-80"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500">QCTO type</label>
            <select
              value={qType}
              onChange={(e) => setQType(e.target.value as "fisa" | "eisa")}
              className="rounded border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="eisa">EISA</option>
              <option value="fisa">FISA (legacy)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500">SAQA qualification ID (optional)</label>
            <input
              value={qSaqaId}
              onChange={(e) => setQSaqaId(e.target.value)}
              placeholder="e.g. 4911"
              className="rounded border border-gray-300 px-3 py-2 text-sm w-40"
            />
          </div>
          <button className="rounded bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700">
            Add qualification
          </button>
        </form>
        <p className="text-xs text-gray-400 mb-3">
          The SAQA ID is the id= value from that qualification's page on allqs.saqa.org.za - set it here (or
          later, inline below) to use the "Generate from SAQA" option further down.
        </p>
        <ul className="text-sm space-y-1">
          {qualifications.map((q) => (
            <li key={q.id} className="text-gray-700 flex items-center gap-2">
              <span>
                {q.title} <span className="text-gray-400">({q.qctoRegistrationType.toUpperCase()})</span>
              </span>
              {saqaEditId === q.id ? (
                <>
                  <input
                    autoFocus
                    value={saqaEditValue}
                    onChange={(e) => setSaqaEditValue(e.target.value)}
                    placeholder="SAQA ID"
                    className="rounded border border-gray-300 px-2 py-0.5 text-xs w-28"
                  />
                  <button onClick={() => saveSaqaId(q.id)} className="text-xs text-brand-600 underline">
                    Save
                  </button>
                  <button onClick={() => setSaqaEditId(null)} className="text-xs text-gray-400 underline">
                    Cancel
                  </button>
                </>
              ) : q.saqaQualificationId ? (
                <span className="text-xs text-gray-400">SAQA ID: {q.saqaQualificationId}</span>
              ) : (
                <button
                  onClick={() => {
                    setSaqaEditId(q.id);
                    setSaqaEditValue("");
                  }}
                  className="text-xs text-brand-600 underline"
                >
                  Set SAQA ID
                </button>
              )}
            </li>
          ))}
          {qualifications.length === 0 && <li className="text-gray-400">None yet.</li>}
        </ul>
      </section>

      {/* AI-generated from SAQA */}
      <section className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-medium mb-4">Generate an Instrument from SAQA</h2>
        <p className="text-xs text-gray-400 mb-4">
          Fetches the qualification's Exit Level Outcomes and Associated Assessment Criteria from its public
          SAQA record and drafts a full paper mapped to them. Available for FISA or EISA qualifications with
          a SAQA ID set above. The result is usable immediately - edit it afterwards like any other
          instrument if anything needs fixing. This can take a minute or two.
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
                No qualification has a SAQA ID set yet - add one above first.
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
      </section>

      {/* Instruments */}
      <section className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-medium mb-4">Assessment Instruments (manual intake)</h2>
        <p className="text-xs text-gray-400 mb-4">
          Curricula Builder doesn't have a live API yet, so this is the v1 manual-entry path from Section 5 of
          the spec — the same internal shape a future "Fetch from Curricula Builder" import will populate.
        </p>
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

        <div className="mt-4 text-sm">
          <p className="text-xs text-gray-500 mb-1">Existing instruments:</p>
          <ul className="space-y-1">
            {instruments.map((i) => (
              <li key={i.id} className="text-gray-700">
                {qualifications.find((q) => q.id === i.qualificationId)?.title ?? i.qualificationId} —{" "}
                {i.version} ({i.questions.length} questions, {i.timeAllocationMinutes}min){" "}
                <span
                  className={
                    "text-xs rounded-full px-2 py-0.5 " +
                    (i.source === "ai_generated"
                      ? "bg-brand-50 text-brand-700"
                      : i.source === "curricula_builder"
                      ? "bg-amber-50 text-amber-700"
                      : "bg-gray-100 text-gray-500")
                  }
                >
                  {i.source === "ai_generated" ? "AI-generated (SAQA)" : i.source === "curricula_builder" ? "Curricula Builder" : "Manual"}
                </span>
              </li>
            ))}
            {instruments.length === 0 && <li className="text-gray-400">None yet.</li>}
          </ul>
        </div>
      </section>

      {/* Sittings */}
      <section className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-medium mb-4">Exam Sittings</h2>
        <form onSubmit={createSitting} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500">Qualification</label>
              <select
                value={sitQualId}
                onChange={(e) => setSitQualId(e.target.value)}
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
              <label className="block text-xs text-gray-500">Instrument</label>
              <select
                value={sitInstrId}
                onChange={(e) => setSitInstrId(e.target.value)}
                required
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="">Select...</option>
                {instruments
                  .filter((i) => !sitQualId || i.qualificationId === sitQualId)
                  .map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.version}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500">Start</label>
              <input
                type="datetime-local"
                value={sitStart}
                onChange={(e) => setSitStart(e.target.value)}
                required
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500">End</label>
              <input
                type="datetime-local"
                value={sitEnd}
                onChange={(e) => setSitEnd(e.target.value)}
                required
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500">Assessor</label>
              <select
                value={sitAssessorId}
                onChange={(e) => setSitAssessorId(e.target.value)}
                required
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="">Select...</option>
                {assessors().map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2 pt-5">
              <input
                type="checkbox"
                id="independent"
                checked={sitIndependent}
                onChange={(e) => setSitIndependent(e.target.checked)}
              />
              <label htmlFor="independent" className="text-sm">
                Requires independent (external) invigilation
              </label>
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Invigilators {sitIndependent && "(only external accounts shown)"}
            </label>
            <div className="flex flex-wrap gap-3">
              {invigilators()
                .filter((inv) => !sitIndependent || inv.employmentRelationship === "external")
                .map((inv) => (
                  <label key={inv.id} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={sitInvigilatorIds.includes(inv.id)}
                      onChange={() => toggleInvigilator(inv.id)}
                    />
                    {inv.name}
                  </label>
                ))}
              {invigilators().length === 0 && <span className="text-xs text-gray-400">No invigilators registered.</span>}
            </div>
          </div>
          <button className="rounded bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700">
            Create sitting
          </button>
        </form>

        <div className="mt-4 text-sm">
          <p className="text-xs text-gray-500 mb-1">Existing sittings:</p>
          <ul className="space-y-1">
            {sittings.map((s) => (
              <li key={s.id} className="text-gray-700">
                {qualifications.find((q) => q.id === s.qualificationId)?.title ?? s.qualificationId} —{" "}
                {new Date(s.startTime).toLocaleString()} → {new Date(s.endTime).toLocaleString()}
                <span className="text-gray-400"> (id: {s.id.slice(0, 8)}…)</span>
              </li>
            ))}
            {sittings.length === 0 && <li className="text-gray-400">None yet.</li>}
          </ul>
        </div>
      </section>

      {/* Assign learners */}
      <section className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-medium mb-4">Assign Learners to a Sitting</h2>
        <form onSubmit={assignLearners} className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500">Sitting</label>
            <select
              value={assignSittingId}
              onChange={(e) => setAssignSittingId(e.target.value)}
              required
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">Select...</option>
              {sittings.map((s) => (
                <option key={s.id} value={s.id}>
                  {qualifications.find((q) => q.id === s.qualificationId)?.title ?? s.id} —{" "}
                  {new Date(s.startTime).toLocaleString()}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Learners</label>
            <div className="flex flex-wrap gap-3">
              {learners().map((l) => (
                <label key={l.id} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={assignLearnerIds.includes(l.id)}
                    onChange={() => toggleAssignLearner(l.id)}
                  />
                  {l.name}
                </label>
              ))}
              {learners().length === 0 && <span className="text-xs text-gray-400">No learners registered.</span>}
            </div>
          </div>
          <button className="rounded bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700">
            Assign
          </button>
        </form>
      </section>
    </div>
  );
}
