import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { Qualification, AssessmentInstrument, ExamSitting, PublicUser } from "@shared/types";

export default function AdminSittings() {
  const [qualifications, setQualifications] = useState<Qualification[]>([]);
  const [instruments, setInstruments] = useState<AssessmentInstrument[]>([]);
  const [sittings, setSittings] = useState<ExamSitting[]>([]);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

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

  const assessors = () => users.filter((u) => u.roles.includes("assessor"));
  const invigilators = () => users.filter((u) => u.roles.includes("invigilator"));
  const learners = () => users.filter((u) => u.roles.includes("learner"));

  // ---- Create sitting ----
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
      setShowCreate(false);
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // ---- Assign learners (inline per sitting) ----
  const [assignSittingId, setAssignSittingId] = useState<string | null>(null);
  const [assignLearnerIds, setAssignLearnerIds] = useState<string[]>([]);

  function toggleAssignLearner(id: string) {
    setAssignLearnerIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function assignLearners(sittingId: string, e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      const res = await api.post<{ assigned: number; alreadyAssigned: number }>(
        `/sittings/${sittingId}/assign-learners`,
        { learnerIds: assignLearnerIds }
      );
      setMessage(`Assigned ${res.assigned} learner(s) (${res.alreadyAssigned} were already on this sitting).`);
      setAssignLearnerIds([]);
      setAssignSittingId(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-brand-700">Exam Sittings</h1>
          <p className="text-sm text-gray-500 mt-1">
            A scheduled window where a cohort sits a specific instrument, with its proctoring settings and
            assigned assessor/invigilators.
          </p>
        </div>
        <button
          onClick={() => setShowCreate((v) => !v)}
          className="rounded bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700 whitespace-nowrap"
        >
          {showCreate ? "Close" : "+ New sitting"}
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {message && <p className="text-sm text-green-700">{message}</p>}

      {showCreate && (
        <section className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-medium mb-4">New sitting</h2>
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
                {invigilators().length === 0 && (
                  <span className="text-xs text-gray-400">No invigilators registered.</span>
                )}
              </div>
            </div>
            <button className="rounded bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700">
              Create sitting
            </button>
          </form>
        </section>
      )}

      <section className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-medium mb-4">All sittings</h2>
        <ul className="text-sm divide-y divide-gray-100">
          {sittings.map((s) => (
            <li key={s.id} className="py-3">
              <div className="flex items-center gap-2">
                <span className="flex-1">
                  {qualifications.find((q) => q.id === s.qualificationId)?.title ?? s.qualificationId} —{" "}
                  {new Date(s.startTime).toLocaleString()} → {new Date(s.endTime).toLocaleString()}
                </span>
                <button
                  onClick={() => {
                    setAssignSittingId(assignSittingId === s.id ? null : s.id);
                    setAssignLearnerIds([]);
                  }}
                  className="text-xs text-brand-600 underline whitespace-nowrap"
                >
                  {assignSittingId === s.id ? "Cancel" : "Assign learners"}
                </button>
              </div>

              {assignSittingId === s.id && (
                <form
                  onSubmit={(e) => assignLearners(s.id, e)}
                  className="mt-3 bg-gray-50 border border-gray-200 rounded p-3 space-y-3"
                >
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
                    {learners().length === 0 && (
                      <span className="text-xs text-gray-400">No learners registered.</span>
                    )}
                  </div>
                  <button className="rounded bg-brand-600 text-white px-3 py-1.5 text-xs font-medium hover:bg-brand-700">
                    Assign
                  </button>
                </form>
              )}
            </li>
          ))}
          {sittings.length === 0 && <li className="py-2.5 text-gray-400">None yet.</li>}
        </ul>
      </section>
    </div>
  );
}
