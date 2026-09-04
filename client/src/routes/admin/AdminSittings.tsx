import { Fragment, useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { Qualification, AssessmentInstrument, ExamSitting, PublicUser } from "@shared/types";
import { PageHeader, Card, CardHead, Notice, Empty, PlusIcon } from "../../components/ui";

const fmt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

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

  const assessors = users.filter((u) => u.roles.includes("assessor"));
  const invigilators = users.filter((u) => u.roles.includes("invigilator"));
  const learners = users.filter((u) => u.roles.includes("learner"));
  const qualTitle = (id: string) => qualifications.find((q) => q.id === id)?.title ?? "—";

  // ---- Create sitting ----
  const [sitQualId, setSitQualId] = useState("");
  const [sitInstrId, setSitInstrId] = useState("");
  const [sitStart, setSitStart] = useState("");
  const [sitEnd, setSitEnd] = useState("");
  const [sitAssessorId, setSitAssessorId] = useState("");
  const [sitInvigilatorIds, setSitInvigilatorIds] = useState<string[]>([]);
  const [sitIndependent, setSitIndependent] = useState(false);

  const toggle = (setter: React.Dispatch<React.SetStateAction<string[]>>, id: string) =>
    setter((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

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
      setMessage("Sitting created.");
      setSitInvigilatorIds([]);
      setShowCreate(false);
      await loadAll();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // ---- Assign learners, inline per sitting ----
  const [assignSittingId, setAssignSittingId] = useState<string | null>(null);
  const [assignLearnerIds, setAssignLearnerIds] = useState<string[]>([]);

  async function assignLearners(sittingId: string, e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      const res = await api.post<{ assigned: number; alreadyAssigned: number }>(
        `/sittings/${sittingId}/assign-learners`,
        { learnerIds: assignLearnerIds }
      );
      setMessage(`Assigned ${res.assigned} learner(s)${res.alreadyAssigned ? ` (${res.alreadyAssigned} already on this sitting)` : ""}.`);
      setAssignLearnerIds([]);
      setAssignSittingId(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const CheckChip = ({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: React.ReactNode }) => (
    <label className={"inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13.5px] cursor-pointer transition " + (checked ? "border-brand-600 bg-brand-50 text-brand-800" : "border-line-strong text-ink-muted hover:bg-surface-2")}>
      <input type="checkbox" className="accent-brand-600" checked={checked} onChange={onChange} />
      {children}
    </label>
  );

  return (
    <>
      <PageHeader
        title="Exam Sittings"
        subtitle="A scheduled window where a cohort sits a specific instrument, with its proctoring settings and assigned assessor and invigilators."
        action={
          <button className="btn whitespace-nowrap" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "Close" : <><PlusIcon /> New sitting</>}
          </button>
        }
      />

      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}

      {showCreate && (
        <Card className="mb-5">
          <CardHead title="New sitting" />
          <form onSubmit={createSitting} className="px-5 pt-4 pb-5 space-y-4">
            <div className="grid grid-cols-2 gap-3.5">
              <div>
                <label className="field-lbl">Qualification</label>
                <select className="inp" value={sitQualId} onChange={(e) => setSitQualId(e.target.value)} required>
                  <option value="">Select…</option>
                  {qualifications.map((q) => <option key={q.id} value={q.id}>{q.title}</option>)}
                </select>
              </div>
              <div>
                <label className="field-lbl">Instrument</label>
                <select className="inp" value={sitInstrId} onChange={(e) => setSitInstrId(e.target.value)} required>
                  <option value="">Select…</option>
                  {instruments.filter((i) => !sitQualId || i.qualificationId === sitQualId).map((i) => (
                    <option key={i.id} value={i.id}>{i.version} · {i.questions.length} questions · {i.timeAllocationMinutes} min</option>
                  ))}
                </select>
              </div>
              <div><label className="field-lbl">Start</label><input className="inp" type="datetime-local" value={sitStart} onChange={(e) => setSitStart(e.target.value)} required /></div>
              <div><label className="field-lbl">End</label><input className="inp" type="datetime-local" value={sitEnd} onChange={(e) => setSitEnd(e.target.value)} required /></div>
              <div>
                <label className="field-lbl">Assessor</label>
                <select className="inp" value={sitAssessorId} onChange={(e) => setSitAssessorId(e.target.value)} required>
                  <option value="">Select…</option>
                  {assessors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                {assessors.length === 0 && <p className="text-xs text-amber-700 mt-1.5">No assessors registered yet — add one on the Users page.</p>}
              </div>
              <div className="flex items-end pb-1">
                <CheckChip checked={sitIndependent} onChange={() => setSitIndependent((v) => !v)}>
                  Requires independent (external) invigilation
                </CheckChip>
              </div>
            </div>
            <div>
              <label className="field-lbl">Invigilators {sitIndependent && <span className="normal-case font-normal text-ink-faint">— external accounts only</span>}</label>
              <div className="flex flex-wrap gap-2">
                {invigilators.filter((inv) => !sitIndependent || inv.employmentRelationship === "external").map((inv) => (
                  <CheckChip key={inv.id} checked={sitInvigilatorIds.includes(inv.id)} onChange={() => toggle(setSitInvigilatorIds, inv.id)}>{inv.name}</CheckChip>
                ))}
                {invigilators.length === 0 && <span className="text-xs text-ink-faint">No invigilators registered yet.</span>}
              </div>
            </div>
            <button className="btn">Create sitting</button>
          </form>
        </Card>
      )}

      <Card>
        <CardHead title="All sittings" />
        <div className="px-2 pb-2">
          {sittings.length ? (
            <table className="data">
              <thead>
                <tr><th>Qualification</th><th>Window</th><th>Assessor</th><th className="text-right">Learners</th></tr>
              </thead>
              <tbody>
                {sittings.map((s) => (
                  <Fragment key={s.id}>
                    <tr>
                      <td>
                        <div className="font-semibold">{qualTitle(s.qualificationId)}</div>
                        <div className="t-sub">{qualifications.find((q) => q.id === s.qualificationId)?.qctoRegistrationType.toUpperCase()}</div>
                      </td>
                      <td>{fmt(s.startTime)} <span className="text-ink-faint">→</span> {fmt(s.endTime)}</td>
                      <td>{users.find((u) => u.id === s.assignedAssessorId)?.name ?? "—"}</td>
                      <td className="text-right">
                        <button
                          className="lnk"
                          onClick={() => { setAssignSittingId(assignSittingId === s.id ? null : s.id); setAssignLearnerIds([]); }}
                        >
                          {assignSittingId === s.id ? "Cancel" : "Assign learners"}
                        </button>
                      </td>
                    </tr>
                    {assignSittingId === s.id && (
                      <tr>
                        <td colSpan={4} className="!pt-0">
                          <form onSubmit={(e) => assignLearners(s.id, e)} className="rounded-lg border border-line bg-surface-2 p-3.5 space-y-3">
                            <div className="flex flex-wrap gap-2">
                              {learners.map((l) => (
                                <CheckChip key={l.id} checked={assignLearnerIds.includes(l.id)} onChange={() => toggle(setAssignLearnerIds, l.id)}>{l.name}</CheckChip>
                              ))}
                              {learners.length === 0 && <span className="text-xs text-ink-faint">No learners registered yet.</span>}
                            </div>
                            <button className="btn btn-sm" disabled={assignLearnerIds.length === 0}>Assign {assignLearnerIds.length || ""} learner{assignLearnerIds.length === 1 ? "" : "s"}</button>
                          </form>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No sittings yet — create the first one above.</Empty>
          )}
        </div>
      </Card>
    </>
  );
}
