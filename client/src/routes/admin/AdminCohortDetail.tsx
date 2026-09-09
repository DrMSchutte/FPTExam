import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../lib/api";
import type { Cohort, CohortDetail, CohortMemberRow, PeopleListResponse, Qualification } from "@shared/types";
import { PageHeader, Card, CardHead, Notice, Badge, Empty } from "../../components/ui";
import { StatusBadge, ImportPanel } from "./AdminUsers";

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const PAGE_SIZE = 50;

export default function AdminCohortDetail() {
  const { id } = useParams<{ id: string }>();
  const [c, setC] = useState<CohortDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [panel, setPanel] = useState<"none" | "add" | "import" | "edit">("none");

  // Members
  const [q, setQ] = useState("");
  const debounced = useDebounced(q, 300);
  const [page, setPage] = useState(1);
  const [members, setMembers] = useState<{ rows: CohortMemberRow[]; total: number } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allCohorts, setAllCohorts] = useState<Cohort[]>([]);
  const [moveTo, setMoveTo] = useState("");

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setC(await api.get<CohortDetail>(`/cohorts/${id}`));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  const loadMembers = useCallback(async () => {
    if (!id) return;
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (debounced.trim()) params.set("q", debounced.trim());
    try {
      setMembers(await api.get(`/cohorts/${id}/members?${params}`));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id, page, debounced]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadMembers(); }, [loadMembers]);
  useEffect(() => { setPage(1); }, [debounced]);
  useEffect(() => { api.get<Cohort[]>("/cohorts?status=active").then(setAllCohorts).catch(() => {}); }, [id]);

  const refresh = async () => { await Promise.all([load(), loadMembers()]); setSelected(new Set()); };
  const say = (m: string) => { setMessage(m); setError(null); };

  async function removeSelected() {
    if (!id || !selected.size || !c) return;
    if (!window.confirm(`Remove ${selected.size} student${selected.size === 1 ? "" : "s"} from ${c.name}? They stay registered; only the cohort membership goes.`)) return;
    try {
      const r = await api.del<{ removed: number }>(`/cohorts/${id}/members`, { learnerIds: [...selected] });
      say(`${r.removed} removed from ${c.name}.`);
      await refresh();
    } catch (err) { setError((err as Error).message); }
  }

  async function moveSelected() {
    if (!id || !selected.size || !moveTo) return;
    try {
      const r = await api.post<{ moved: number; toCohortName: string }>(`/cohorts/${id}/members/move`, { learnerIds: [...selected], toCohortId: moveTo });
      say(`${r.moved} moved to ${r.toCohortName}.`);
      setMoveTo("");
      await refresh();
    } catch (err) { setError((err as Error).message); }
  }

  async function setStatus(status: "active" | "closed") {
    if (!id || !c) return;
    try {
      await api.patch(`/cohorts/${id}`, { status });
      say(status === "closed" ? `${c.name} closed. No more students or sittings can be added until it is reopened.` : `${c.name} reopened.`);
      await load();
    } catch (err) { setError((err as Error).message); }
  }

  if (!c) {
    return (<><PageHeader title="Cohort" />{error ? <Notice kind="error">{error}</Notice> : <p className="t-sub px-1">Loading…</p>}</>);
  }

  const pages = Math.max(1, Math.ceil((members?.total ?? 0) / PAGE_SIZE));
  const allOnPageSelected = !!members?.rows.length && members.rows.every((r) => selected.has(r.id));

  return (
    <>
      <div className="mb-2"><Link to="/admin/cohorts" className="lnk text-[13px]">← Cohorts</Link></div>
      <PageHeader
        title={c.name}
        subtitle={[c.qualificationTitle, [c.site, c.intake].filter(Boolean).join(" · "), `${c.members.toLocaleString()} student${c.members === 1 ? "" : "s"}`, `${c.sittings} sitting${c.sittings === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
        action={
          <div className="flex items-center gap-2">
            {c.status === "active" ? <Badge tone="green">Active</Badge> : <Badge tone="gray">Closed</Badge>}
            {c.status === "active" && (
              <>
                <button className="btn-ghost whitespace-nowrap" onClick={() => setPanel(panel === "import" ? "none" : "import")}>{panel === "import" ? "Close import" : "Import students"}</button>
                <button className="btn whitespace-nowrap" onClick={() => setPanel(panel === "add" ? "none" : "add")}>{panel === "add" ? "Done adding" : "Add students"}</button>
              </>
            )}
          </div>
        }
      />
      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}

      {panel === "import" && <ImportPanel defaultType="students" cohortId={c.id} cohortName={c.name} onDone={(m) => { say(m); refresh(); }} onError={(m) => setError(m || null)} />}
      {panel === "add" && <AddStudents cohortId={c.id} cohortName={c.name} onAdded={(m) => { say(m); refresh(); }} onError={(m) => setError(m || null)} />}
      {panel === "edit" && <EditCohort cohort={c} onSaved={(m) => { say(m); setPanel("none"); load(); }} onCancel={() => setPanel("none")} onError={(m) => setError(m || null)} />}

      <div className="grid grid-cols-[1fr_300px] gap-5 items-start">
        <div className="space-y-5">
          <Card>
            <CardHead title="Sittings" subtitle={c.sittingList.length ? `${c.sittingList.length} scheduled for this cohort` : "None yet"} right={c.status === "active" ? <Link to={`/admin/sittings?cohort=${c.id}`} className="btn btn-sm">Schedule a sitting for this cohort</Link> : undefined} />
            <div className="px-2 pb-2">
              {c.sittingList.length === 0 ? (
                <Empty>When you schedule a sitting for this cohort, every student in it is allocated in one action.</Empty>
              ) : (
                <table className="data">
                  <thead><tr><th>Paper</th><th>Window</th><th>Assessor</th><th className="text-right">On the roster</th><th className="text-right">Submitted</th><th></th></tr></thead>
                  <tbody>
                    {c.sittingList.map((s) => (
                      <tr key={s.id}>
                        <td><div className="font-semibold">{s.name ?? s.paper}</div>{s.name && <div className="t-sub">{s.paper}</div>}</td>
                        <td>{fmt(s.startTime)} <span className="text-ink-faint">→</span> {fmt(s.endTime)}</td>
                        <td>{s.assessorName}</td>
                        <td className="text-right tabular">{s.learners} <span className="t-sub">of {c.members}</span></td>
                        <td className="text-right tabular">{s.submitted}</td>
                        <td className="text-right"><Link to={`/admin/sittings?open=${s.id}`} className="lnk">Roster</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Card>
          <Card>
            <div className="px-5 pt-4 pb-3 flex items-center gap-3 border-b border-line">
              <input className="inp max-w-xs" placeholder="Search name, email, student number or ID last four…" value={q} onChange={(e) => setQ(e.target.value)} />
              <span className="t-sub">{members ? `${members.total.toLocaleString()} student${members.total === 1 ? "" : "s"}` : "…"}</span>
              <span className="flex-1" />
              {selected.size > 0 && (
                <>
                  <span className="text-[13px] font-semibold text-brand-700">{selected.size} selected</span>
                  <select className="inp w-auto" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                    <option value="">Move to…</option>
                    {allCohorts.filter((x) => x.id !== c.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                  <button type="button" className="btn-ghost btn-sm" disabled={!moveTo} onClick={moveSelected}>Move</button>
                  <button type="button" className="btn-ghost btn-sm" onClick={removeSelected}>Remove</button>
                </>
              )}
              <a className="btn-ghost btn-sm whitespace-nowrap" href={`/api/cohorts/${c.id}/members/export.csv`}>Export CSV</a>
            </div>
            <div className="px-2 pb-2">
              {members && members.rows.length === 0 ? (
                <Empty>{members.total === 0 && !debounced ? "No students in this cohort yet. Add them by search, or import a file." : "No student matches that search."}</Empty>
              ) : (
                <table className="data">
                  <thead>
                    <tr>
                      <th className="w-8"><input type="checkbox" className="accent-brand-600" checked={allOnPageSelected} onChange={() => setSelected((s) => { const n = new Set(s); if (allOnPageSelected) members!.rows.forEach((r) => n.delete(r.id)); else members!.rows.forEach((r) => n.add(r.id)); return n; })} /></th>
                      <th>Name</th><th>Email</th><th>ID number</th><th>Student no.</th><th>Status</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(members?.rows ?? []).map((r) => (
                      <tr key={r.id} className={selected.has(r.id) ? "bg-brand-50/40" : ""}>
                        <td><input type="checkbox" className="accent-brand-600" checked={selected.has(r.id)} onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} /></td>
                        <td><Link to={`/admin/people/${r.id}`} className="font-semibold hover:underline">{r.name}</Link></td>
                        <td className="text-ink-muted">{r.email}</td>
                        <td className="tabular text-ink-muted">{r.idNumberMasked ?? "—"}</td>
                        <td className="tabular text-ink-muted">{r.studentNumber ?? "—"}</td>
                        <td><StatusBadge status={r.status} /></td>
                        <td className="text-right"><Link to={`/admin/people/${r.id}`} className="lnk">Open</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {pages > 1 && (
                <div className="flex items-center justify-between px-3 py-3 text-[13px] text-ink-muted">
                  <span>{(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, members?.total ?? 0)} of {(members?.total ?? 0).toLocaleString()}</span>
                  <div className="flex items-center gap-2">
                    <button type="button" className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Previous</button>
                    <span>Page {page} of {pages}</span>
                    <button type="button" className="btn-ghost btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next →</button>
                  </div>
                </div>
              )}
            </div>
          </Card>

        </div>

        <div className="space-y-5">
          <Card>
            <CardHead title="Details" right={<button type="button" className="btn-ghost btn-sm" onClick={() => setPanel(panel === "edit" ? "none" : "edit")}>{panel === "edit" ? "Cancel" : "Edit"}</button>} />
            <div className="px-5 pb-5 text-[13.5px] space-y-2.5">
              <Row k="Qualification" v={c.qualificationTitle ?? "—"} />
              <Row k="Site / campus" v={c.site ?? "—"} />
              <Row k="Intake" v={c.intake ?? "—"} />
              <Row k="FPTStaff reference" v={c.externalRef ?? "not linked yet"} />
              {c.notes && <Row k="Notes" v={c.notes} />}
              <Row k="Created" v={fmtDate(c.createdAt)} />
              <div className="pt-2 border-t border-line">
                <div className="field-lbl mb-1.5">Students by status</div>
                <div className="flex flex-wrap gap-1.5">
                  {(["active", "invited", "suspended", "archived"] as const).filter((s) => c.memberStatus[s]).map((s) => (
                    <span key={s} className="inline-flex items-center gap-1.5"><StatusBadge status={s} /><span className="tabular">{c.memberStatus[s]}</span></span>
                  ))}
                  {!Object.keys(c.memberStatus).length && <span className="t-sub">none yet</span>}
                </div>
              </div>
              <div className="pt-2 flex flex-col gap-2">
                {c.status === "active"
                  ? <button type="button" className="btn-ghost btn-sm text-ink-muted" onClick={() => setStatus("closed")}>Close cohort</button>
                  : <button type="button" className="btn-ghost btn-sm" onClick={() => setStatus("active")}>Reopen cohort</button>}
              </div>
            </div>
          </Card>

          <Card>
            <CardHead title="Audit trail" subtitle="Most recent first" />
            <div className="px-5 pb-4 text-[13px]">
              {c.audit.length === 0 ? <p className="t-sub">Nothing yet.</p> : (
                <ul className="divide-y divide-line">
                  {c.audit.map((a, i) => (
                    <li key={i} className="py-2">
                      <div className="font-semibold">{auditLabel(a.action)}</div>
                      {a.reason && <div className="text-ink-muted">{a.reason}</div>}
                      <div className="t-sub">{fmt(a.at)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (<div className="flex items-start justify-between gap-4"><span className="text-ink-muted shrink-0">{k}</span><span className="text-right">{v}</span></div>);
}

const auditLabel = (a: string) =>
  ({
    cohort_created: "Created",
    cohort_edited: "Details edited",
    cohort_closed: "Closed",
    cohort_reopened: "Reopened",
    cohort_members_added: "Students added",
    cohort_members_removed: "Students removed",
    cohort_members_moved_out: "Students moved out",
    cohort_members_moved_in: "Students moved in",
    cohort_members_exported: "Student list exported",
  })[a] ?? a.replace(/_/g, " ");

// ---- Add students by search ------------------------------------------------------------

function AddStudents({ cohortId, cohortName, onAdded, onError }: { cohortId: string; cohortName: string; onAdded: (m: string) => void; onError: (m: string) => void }) {
  const [q, setQ] = useState("");
  const debounced = useDebounced(q, 300);
  const [results, setResults] = useState<PeopleListResponse | null>(null);
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [fromCohort, setFromCohort] = useState("");
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  useEffect(() => { api.get<Cohort[]>("/cohorts").then(setCohorts).catch(() => {}); }, []);

  useEffect(() => {
    const params = new URLSearchParams({ type: "students", pageSize: "20", notInCohortId: cohortId });
    if (debounced.trim()) params.set("q", debounced.trim());
    if (fromCohort) params.set("cohortId", fromCohort);
    api.get<PeopleListResponse>(`/people?${params}`).then(setResults).catch((e) => onError((e as Error).message));
  }, [debounced, cohortId, fromCohort]); // eslint-disable-line react-hooks/exhaustive-deps

  async function add(ids: string[]) {
    setBusy(true);
    try {
      const r = await api.post<{ added: number; alreadyMembers: number; archived: number }>(`/cohorts/${cohortId}/members`, { learnerIds: ids });
      onAdded(`${r.added} added to ${cohortName}${r.alreadyMembers ? ` (${r.alreadyMembers} already in it)` : ""}${r.archived ? ` · ${r.archived} archived students skipped` : ""}.`);
      setPicked(new Map());
      setResults(null);
      setQ("");
    } catch (err) { onError((err as Error).message); } finally { setBusy(false); }
  }

  async function addAllMatching() {
    // Everyone matching the current search, not just the 20 shown.
    const params = new URLSearchParams({ type: "students", pageSize: "200", notInCohortId: cohortId });
    if (debounced.trim()) params.set("q", debounced.trim());
    if (fromCohort) params.set("cohortId", fromCohort);
    setBusy(true);
    try {
      const ids: string[] = [];
      for (let page = 1; page <= 25; page++) {
        const r = await api.get<PeopleListResponse>(`/people?${params}&page=${page}`);
        ids.push(...r.rows.map((x) => x.id));
        if (r.rows.length < 200) break;
      }
      if (!ids.length) return onError("Nobody matches that search.");
      if (!window.confirm(`Add all ${ids.length} matching students to ${cohortName}?`)) return;
      await add(ids);
    } catch (err) { onError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <Card className="mb-5">
      <CardHead title={`Add students to ${cohortName}`} subtitle="Search registered students who are not yet in this cohort, tick them and add. To bring in a whole other cohort or everyone matching a search, use Add all matching." />
      <div className="px-5 pt-4 pb-5 space-y-3">
        <div className="flex items-center gap-3">
          <input className="inp max-w-sm" autoFocus placeholder="Search name, email, student number or ID last four…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="inp w-auto" value={fromCohort} onChange={(e) => setFromCohort(e.target.value)}>
            <option value="">Any cohort or none</option>
            {cohorts.filter((x) => x.id !== cohortId).map((x) => <option key={x.id} value={x.id}>in {x.name}</option>)}
          </select>
          <span className="flex-1" />
          <button type="button" className="btn-ghost btn-sm" disabled={busy || !results?.total} onClick={addAllMatching}>Add all {results?.total ? results.total.toLocaleString() : ""} matching</button>
          <button type="button" className="btn btn-sm" disabled={busy || picked.size === 0} onClick={() => add([...picked.keys()])}>{busy ? "Adding…" : `Add ${picked.size || ""} selected`}</button>
        </div>
        {results && (
          <div className="rounded-lg border border-line divide-y divide-line max-h-80 overflow-auto">
            {results.rows.length === 0 && <p className="t-sub p-3">No students match{fromCohort ? " in that cohort" : ""} (students already in this cohort are not shown).</p>}
            {results.rows.map((r) => (
              <label key={r.id} className="flex items-center gap-3 px-3 py-2 text-[13.5px] cursor-pointer hover:bg-surface-2">
                <input type="checkbox" className="accent-brand-600" checked={picked.has(r.id)} onChange={() => setPicked((p) => { const n = new Map(p); if (n.has(r.id)) n.delete(r.id); else n.set(r.id, r.name); return n; })} />
                <span className="font-semibold w-56 truncate">{r.name}</span>
                <span className="text-ink-muted flex-1 truncate">{r.email}</span>
                <span className="tabular text-ink-muted">{r.idNumberMasked ?? ""}</span>
                <span className="text-ink-faint text-[12px]">{r.cohorts.map((x) => x.name).join(", ")}</span>
                <StatusBadge status={r.status} />
              </label>
            ))}
            {results.total > results.rows.length && <p className="t-sub p-2.5">Showing {results.rows.length} of {results.total.toLocaleString()} — narrow the search, or use Add all matching.</p>}
          </div>
        )}
      </div>
    </Card>
  );
}

// ---- Edit -------------------------------------------------------------------------------

function EditCohort({ cohort, onSaved, onCancel, onError }: { cohort: CohortDetail; onSaved: (m: string) => void; onCancel: () => void; onError: (m: string) => void }) {
  const [qualifications, setQualifications] = useState<Qualification[]>([]);
  const [form, setForm] = useState({ name: cohort.name, qualificationId: cohort.qualificationId ?? "", site: cohort.site ?? "", intake: cohort.intake ?? "", notes: cohort.notes ?? "", externalRef: cohort.externalRef ?? "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get<Qualification[]>("/qualifications").then(setQualifications).catch(() => {}); }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.patch(`/cohorts/${cohort.id}`, { ...form, qualificationId: form.qualificationId || null, site: form.site || null, intake: form.intake || null, notes: form.notes || null, externalRef: form.externalRef || null });
      onSaved("Cohort details saved.");
    } catch (err) { onError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <Card className="mb-5">
      <CardHead title="Edit cohort" />
      <form onSubmit={save} className="px-5 pt-4 pb-5 space-y-4">
        <div className="grid grid-cols-3 gap-3.5">
          <div className="col-span-2"><label className="field-lbl">Cohort name</label><input className="inp" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
          <div>
            <label className="field-lbl">Qualification</label>
            <select className="inp" value={form.qualificationId} onChange={(e) => setForm({ ...form, qualificationId: e.target.value })}>
              <option value="">— none / general —</option>
              {qualifications.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
            </select>
          </div>
          <div><label className="field-lbl">Site / campus</label><input className="inp" value={form.site} onChange={(e) => setForm({ ...form, site: e.target.value })} /></div>
          <div><label className="field-lbl">Intake</label><input className="inp" value={form.intake} onChange={(e) => setForm({ ...form, intake: e.target.value })} /></div>
          <div><label className="field-lbl">FPTStaff reference</label><input className="inp" value={form.externalRef} onChange={(e) => setForm({ ...form, externalRef: e.target.value })} placeholder="filled in when FPTStaff is connected" /></div>
          <div className="col-span-3"><label className="field-lbl">Notes</label><input className="inp" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
        </div>
        <div className="flex gap-2">
          <button className="btn" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </Card>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => setV(value), ms);
    return () => { if (t.current) clearTimeout(t.current); };
  }, [value, ms]);
  return v;
}
