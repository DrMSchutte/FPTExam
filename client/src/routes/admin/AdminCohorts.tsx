import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import type { Cohort, Qualification } from "@shared/types";
import { PageHeader, Card, CardHead, Notice, Badge, Empty, PlusIcon } from "../../components/ui";

// Cohorts (build plan Block 2): the working unit for students. A cohort is a
// group such as "ND Payroll · Durban · Jan 2026 intake"; a sitting is scheduled
// for a cohort and its whole membership is allocated in one action.

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export default function AdminCohorts() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<Cohort[] | null>(null);
  const [qualifications, setQualifications] = useState<Qualification[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | "active" | "closed">("");
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  async function load() {
    try {
      const [c, quals] = await Promise.all([api.get<Cohort[]>(`/cohorts${status ? `?status=${status}` : ""}`), api.get<Qualification[]>("/qualifications")]);
      setRows(c);
      setQualifications(quals);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  useEffect(() => { load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const term = q.trim().toLowerCase();
  const visible = (rows ?? []).filter((c) => !term || [c.name, c.site, c.intake, c.qualificationTitle].some((v) => v?.toLowerCase().includes(term)));
  const totalStudents = (rows ?? []).reduce((s, c) => s + c.members, 0);

  return (
    <>
      <PageHeader
        title="Cohorts"
        subtitle="Groups of students who study and write together - for example ND Payroll · Durban · Jan 2026 intake. Schedule a sitting for a cohort and everyone in it is allocated at once. FPTStaff will own cohorts once it is connected."
        action={
          <button className="btn whitespace-nowrap" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "Close" : <><PlusIcon /> New cohort</>}
          </button>
        }
      />
      {error && <Notice kind="error">{error}</Notice>}

      {showCreate && (
        <CreateCohort
          qualifications={qualifications}
          onCreated={(c) => { setShowCreate(false); navigate(`/admin/cohorts/${c.id}`); }}
          onError={setError}
        />
      )}

      <Card>
        <div className="px-5 pt-4 pb-3 flex items-center gap-3 border-b border-line">
          <input className="inp max-w-xs" placeholder="Search cohorts…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="inp w-auto" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="">Active and closed</option>
            <option value="active">Active</option>
            <option value="closed">Closed</option>
          </select>
          <span className="flex-1" />
          <span className="t-sub">{rows ? `${rows.length} cohort${rows.length === 1 ? "" : "s"} · ${totalStudents.toLocaleString()} students` : "Loading…"}</span>
        </div>
        <div className="px-2 pb-2">
          {rows && visible.length === 0 ? (
            <Empty>{rows.length === 0 ? "No cohorts yet — create the first one above, or import students into a new cohort." : "No cohort matches that search."}</Empty>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Cohort</th>
                  <th>Qualification</th>
                  <th>Site · intake</th>
                  <th className="text-right">Students</th>
                  <th className="text-right">Sittings</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/admin/cohorts/${c.id}`} className="font-semibold hover:underline">{c.name}</Link>
                      <div className="t-sub">created {fmtDate(c.createdAt)}</div>
                    </td>
                    <td className="text-ink-muted">{c.qualificationTitle ?? "—"}</td>
                    <td className="text-ink-muted">{[c.site, c.intake].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="text-right tabular">{c.members.toLocaleString()}</td>
                    <td className="text-right tabular">{c.sittings}</td>
                    <td>{c.status === "active" ? <Badge tone="green">Active</Badge> : <Badge tone="gray">Closed</Badge>}</td>
                    <td className="text-right"><Link to={`/admin/cohorts/${c.id}`} className="lnk">Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </>
  );
}

export function CreateCohort({ qualifications, onCreated, onError, compact = false }: { qualifications: Qualification[]; onCreated: (c: Cohort) => void; onError: (m: string) => void; compact?: boolean }) {
  const [name, setName] = useState("");
  const [qualificationId, setQualificationId] = useState("");
  const [site, setSite] = useState("");
  const [intake, setIntake] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  // Suggest a name from the parts, the way FPT names its groups.
  const suggested = [qualifications.find((x) => x.id === qualificationId)?.title.replace(/^(National Diploma|National Certificate|Further Education and Training Certificate|Occupational Certificate):\s*/i, (m) => m.replace(/National Diploma/i, "ND").replace(/National Certificate/i, "NC").replace(/Further Education and Training Certificate/i, "FETC").replace(/Occupational Certificate/i, "OC")), site.trim(), intake.trim()].filter(Boolean).join(" · ");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    onError("");
    setBusy(true);
    try {
      const c = await api.post<Cohort>("/cohorts", { name: name.trim() || suggested, qualificationId: qualificationId || null, site: site || null, intake: intake || null, notes: notes || null });
      onCreated(c);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-5">
      <CardHead title="New cohort" subtitle="Give the group a name people will recognise on a roster. The qualification is optional but lets Schedule the Sitting offer the right papers first." />
      <form onSubmit={submit} className="px-5 pt-4 pb-5 space-y-4">
        <div className={"grid gap-3.5 " + (compact ? "grid-cols-2" : "grid-cols-3")}>
          <div>
            <label className="field-lbl">Qualification</label>
            <select className="inp" value={qualificationId} onChange={(e) => setQualificationId(e.target.value)}>
              <option value="">— none / general —</option>
              {qualifications.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
            </select>
          </div>
          <div><label className="field-lbl">Site / campus</label><input className="inp" value={site} onChange={(e) => setSite(e.target.value)} placeholder="e.g. Durban" /></div>
          <div><label className="field-lbl">Intake</label><input className="inp" value={intake} onChange={(e) => setIntake(e.target.value)} placeholder="e.g. Jan 2026" /></div>
          <div className={compact ? "col-span-2" : "col-span-2"}>
            <label className="field-lbl">Cohort name</label>
            <input className="inp" value={name} onChange={(e) => setName(e.target.value)} placeholder={suggested || "e.g. ND Payroll · Durban · Jan 2026 intake"} />
            {!name && suggested && <p className="t-sub mt-1">Will be named <span className="font-semibold text-ink">{suggested}</span> unless you type a name.</p>}
          </div>
          <div><label className="field-lbl">Notes</label><input className="inp" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" /></div>
        </div>
        <button className="btn" disabled={busy || (!name.trim() && !suggested)}>{busy ? "Creating…" : "Create cohort"}</button>
      </form>
    </Card>
  );
}
