import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import type { Qualification, AssessmentInstrument, SittingListRow, Cohort, CohortAllocation, SittingRosterRow, PeopleListResponse, StaffingInfo, StaffingProblem } from "@shared/types";
import { PageHeader, Card, CardHead, Notice, Empty, PlusIcon, Badge, typeWord } from "../../components/ui";
import { StatusBadge } from "./AdminUsers";
import SeriesPlanner from "./SeriesPlanner";
import SittingsCalendar from "./SittingsCalendar";
import MarkingWorkload from "./MarkingWorkload";

type View = "list" | "calendar" | "workload";

const fmt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export default function AdminSittings() {
  const [params, setParams] = useSearchParams();
  const [qualifications, setQualifications] = useState<Qualification[]>([]);
  const [instruments, setInstruments] = useState<AssessmentInstrument[]>([]);
  const [sittings, setSittings] = useState<SittingListRow[]>([]);
  const [staffing, setStaffing] = useState<StaffingInfo | null>(null);
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState<"none" | "single" | "series">(params.get("cohort") ? "single" : "none");
  const [openId, setOpenId] = useState<string | null>(params.get("open"));
  const [view, setView] = useState<View>((params.get("view") as View) || "list");
  const [pendingWarnings, setPendingWarnings] = useState<StaffingProblem[] | null>(null);

  async function loadAll() {
    const [q, i, s, c] = await Promise.all([
      api.get<Qualification[]>("/qualifications"),
      api.get<AssessmentInstrument[]>("/instruments"),
      api.get<SittingListRow[]>("/sittings"),
      api.get<Cohort[]>("/cohorts?status=active"),
    ]);
    setQualifications(q);
    setInstruments(i);
    setSittings(s);
    setCohorts(c);
  }
  useEffect(() => { loadAll().catch((e) => setError((e as Error).message)); }, []);

  const assessors = staffing?.assessors ?? [];
  const invigilators = staffing?.invigilators ?? [];
  const qualTitle = (id: string) => qualifications.find((q) => q.id === id)?.title ?? "—";
  // The standard check is the gate: only ready/override papers may be sat.
  const schedulable = instruments.filter((i) => i.intakeStatus === "ready" || i.intakeStatus === "override");

  // ---- Create sitting ----
  const [sitCohortId, setSitCohortId] = useState(params.get("cohort") ?? "");
  const [sitQualId, setSitQualId] = useState("");
  const [sitInstrId, setSitInstrId] = useState("");
  const [sitName, setSitName] = useState("");
  const [sitStart, setSitStart] = useState("");
  const [sitEnd, setSitEnd] = useState("");
  const [sitAssessorId, setSitAssessorId] = useState("");
  const [sitInvigilatorIds, setSitInvigilatorIds] = useState<string[]>([]);
  const [sitIndependent, setSitIndependent] = useState(false);
  const [sitVenue, setSitVenue] = useState("");
  const [sitCapacity, setSitCapacity] = useState("");
  const [creating, setCreating] = useState(false);

  const chosenCohort = cohorts.find((c) => c.id === sitCohortId);
  useEffect(() => {
    const p = new URLSearchParams();
    if (sitQualId) p.set("qualificationId", sitQualId);
    if (sitStart && sitEnd && new Date(sitEnd) > new Date(sitStart)) { p.set("start", new Date(sitStart).toISOString()); p.set("end", new Date(sitEnd).toISOString()); }
    api.get<StaffingInfo>(`/sittings/staffing?${p}`).then(setStaffing).catch(() => {});
  }, [sitQualId, sitStart, sitEnd]);
  // Papers for the cohort's qualification first, the rest after.
  const papersOrdered = [...schedulable].sort((a, b) => {
    const aq = chosenCohort?.qualificationId && a.qualificationId === chosenCohort.qualificationId ? 0 : 1;
    const bq = chosenCohort?.qualificationId && b.qualificationId === chosenCohort.qualificationId ? 0 : 1;
    return aq - bq;
  });
  const ratioNeeded = chosenCohort ? Math.max(1, Math.ceil(chosenCohort.members / 30)) : 0;

  const toggle = (setter: React.Dispatch<React.SetStateAction<string[]>>, id: string) =>
    setter((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  async function createSitting(e: React.FormEvent | null, acceptWarnings = false) {
    e?.preventDefault();
    setError(null);
    setMessage(null);
    setCreating(true);
    try {
      const res = await api.post<{ id: string; allocation: CohortAllocation | null; warnings: string[] }>("/sittings", {
        qualificationId: sitQualId,
        instrumentId: sitInstrId,
        cohortId: sitCohortId || undefined,
        name: sitName || undefined,
        venue: sitVenue || undefined,
        capacity: sitCapacity ? Number(sitCapacity) : undefined,
        startTime: new Date(sitStart).toISOString(),
        endTime: new Date(sitEnd).toISOString(),
        assignedAssessorId: sitAssessorId,
        invigilatorIds: sitInvigilatorIds,
        independentInvigilationRequired: sitIndependent,
        acceptWarnings,
      });
      setPendingWarnings(null);
      const a = res.allocation;
      setMessage(
        a
          ? `Sitting created for ${a.cohortName}: ${a.assigned} student${a.assigned === 1 ? "" : "s"} allocated${a.skipped ? ` (${a.skipped} suspended or archived left out)` : ""}.`
          : "Sitting created. Open its roster to add students."
      );
      setSitInvigilatorIds([]);
      setSitName("");
      setShowCreate("none");
      setParams({});
      await loadAll();
      setOpenId(res.id);
      setView("list");
    } catch (err) {
      // 409 with needsAcceptance: the server wants the Administrator to see the
      // warnings (scope not recorded, marking cap) and confirm.
      const m = (err as Error).message;
      const body = (err as Error & { body?: { needsAcceptance?: boolean; problems?: StaffingProblem[] } }).body;
      if (body?.needsAcceptance && body.problems) setPendingWarnings(body.problems);
      else setError(m);
    } finally {
      setCreating(false);
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
        title="Schedule the Sitting"
        subtitle="A proctored window in which a cohort writes one paper, with its assessor and invigilators. Choose the cohort and everyone in it is on the roster at once. Only papers that passed the standard check (or carry an override) can be chosen."
        action={
          <div className="flex items-center gap-2">
            <button className="btn-ghost whitespace-nowrap" onClick={() => setShowCreate(showCreate === "series" ? "none" : "series")}>
              {showCreate === "series" ? "Close" : "Plan a series"}
            </button>
            <button className="btn whitespace-nowrap" onClick={() => setShowCreate(showCreate === "single" ? "none" : "single")}>
              {showCreate === "single" ? "Close" : <><PlusIcon /> New sitting</>}
            </button>
          </div>
        }
      />

      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}

      {pendingWarnings && (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50/60 p-4 space-y-2">
          <div className="font-display font-semibold text-[13.5px]">Before this sitting is created, note:</div>
          <ul className="text-[13px] list-disc pl-5 space-y-0.5">{pendingWarnings.map((p, i) => <li key={i}>{p.message}</li>)}</ul>
          <div className="flex gap-2 pt-1">
            <button type="button" className="btn btn-sm" disabled={creating} onClick={() => createSitting(null, true)}>Create anyway</button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setPendingWarnings(null)}>Go back and change it</button>
          </div>
        </div>
      )}

      {showCreate === "series" && (
        <SeriesPlanner cohorts={cohorts} instruments={instruments} qualifications={qualifications} onCreated={async (m) => { setMessage(m); setError(null); setShowCreate("none"); await loadAll(); setView("calendar"); }} onError={(m) => setError(m || null)} />
      )}

      {showCreate === "single" && (
        <Card className="mb-5">
          <CardHead title="New sitting" />
          <form onSubmit={createSitting} className="px-5 pt-4 pb-5 space-y-4">
            <div className="grid grid-cols-2 gap-3.5">
              <div>
                <label className="field-lbl">Who is writing</label>
                <select className="inp" value={sitCohortId} onChange={(e) => setSitCohortId(e.target.value)}>
                  <option value="">— add students to the roster afterwards —</option>
                  {cohorts.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.members.toLocaleString()} student{c.members === 1 ? "" : "s"}</option>)}
                </select>
                {chosenCohort && (
                  <p className="t-sub mt-1.5">
                    All {chosenCohort.members.toLocaleString()} students in {chosenCohort.name} go on the roster when you create the sitting.
                    {chosenCohort.members > 0 && ` At 1 invigilator to 30 learners you need ${ratioNeeded} invigilator${ratioNeeded === 1 ? "" : "s"}.`}
                  </p>
                )}
                {cohorts.length === 0 && <p className="t-sub mt-1.5">No cohorts yet — <Link to="/admin/cohorts" className="lnk">create one</Link> to schedule a whole group at once.</p>}
              </div>
              <div>
                <label className="field-lbl">Sitting name <span className="normal-case font-normal text-ink-faint">— optional</span></label>
                <input className="inp" value={sitName} onChange={(e) => setSitName(e.target.value)} placeholder={chosenCohort ? `${chosenCohort.name} · FISA` : "e.g. ND Payroll FISA · Durban · 14 Oct"} />
              </div>
              <div className="col-span-2">
                <label className="field-lbl">Paper</label>
                <select
                  className="inp"
                  value={sitInstrId}
                  onChange={(e) => {
                    const inst = instruments.find((i) => i.id === e.target.value);
                    setSitInstrId(e.target.value);
                    setSitQualId(inst?.qualificationId ?? "");
                  }}
                  required
                >
                  <option value="">Choose a paper…</option>
                  {papersOrdered.map((i) => (
                    <option key={i.id} value={i.id}>
                      {qualTitle(i.qualificationId)} — {i.version} · {i.questions.length} questions · {i.timeAllocationMinutes} min
                      {i.intakeStatus === "override" ? " · override" : ""}
                      {chosenCohort?.qualificationId && i.qualificationId !== chosenCohort.qualificationId ? " · other qualification" : ""}
                    </option>
                  ))}
                </select>
                {schedulable.length === 0 && (
                  <p className="text-xs text-amber-700 mt-1.5">
                    No paper is ready to schedule yet. Bring one in under Set up an Assessment; it becomes available once it passes the standard check.
                  </p>
                )}
                {instruments.length > schedulable.length && (
                  <p className="t-sub mt-1.5">{instruments.length - schedulable.length} paper(s) hidden because they are blocked or still being checked.</p>
                )}
              </div>
              <div><label className="field-lbl">Start</label><input className="inp" type="datetime-local" value={sitStart} onChange={(e) => setSitStart(e.target.value)} required /></div>
              <div><label className="field-lbl">End</label><input className="inp" type="datetime-local" value={sitEnd} onChange={(e) => setSitEnd(e.target.value)} required /></div>
              <div><label className="field-lbl">Venue / room <span className="normal-case font-normal text-ink-faint">— optional</span></label><input className="inp" value={sitVenue} onChange={(e) => setSitVenue(e.target.value)} placeholder="e.g. Durban Lab 2" /></div>
              <div><label className="field-lbl">Seats <span className="normal-case font-normal text-ink-faint">— optional</span></label><input className="inp tabular" type="number" min={1} value={sitCapacity} onChange={(e) => setSitCapacity(e.target.value)} placeholder="room capacity" /></div>
              <div>
                <label className="field-lbl">Assessor <span className="normal-case font-normal text-ink-faint">— scripts in flight / cap</span></label>
                <select className="inp" value={sitAssessorId} onChange={(e) => setSitAssessorId(e.target.value)} required>
                  <option value="">Select…</option>
                  {assessors.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.inFlight}/{a.cap}{a.inScope === false ? " · not in scope" : a.inScope === null && sitQualId ? " · scope not recorded" : ""}</option>)}
                </select>
                {assessors.length === 0 && <p className="text-xs text-amber-700 mt-1.5">No assessors registered yet — add one under Register People.</p>}
              </div>
              <div className="flex items-end pb-1">
                <CheckChip checked={sitIndependent} onChange={() => setSitIndependent((v) => !v)}>
                  Requires independent (external) invigilation
                </CheckChip>
              </div>
            </div>
            <div>
              <label className="field-lbl">
                Invigilators {sitIndependent && <span className="normal-case font-normal text-ink-faint">— external accounts only</span>}
                {chosenCohort && chosenCohort.members > 0 && (
                  <span className={"normal-case font-normal ml-2 " + (sitInvigilatorIds.length >= ratioNeeded ? "text-brand-700" : "text-amber-700")}>
                    {sitInvigilatorIds.length} of {ratioNeeded} needed
                  </span>
                )}
              </label>
              <div className="flex flex-wrap gap-2">
                {invigilators.filter((inv) => !sitIndependent || inv.employment === "external").map((inv) => (
                  <CheckChip key={inv.id} checked={sitInvigilatorIds.includes(inv.id)} onChange={() => toggle(setSitInvigilatorIds, inv.id)}>
                    {inv.name}{inv.busy.length ? <span className="text-amber-700" title={`Already on ${inv.busy[0].name ?? "another sitting"} at this time`}> ⚠ busy</span> : null}
                  </CheckChip>
                ))}
                {invigilators.length === 0 && <span className="text-xs text-ink-faint">No invigilators registered yet.</span>}
              </div>
            </div>
            <button className="btn" disabled={creating}>{creating ? "Creating…" : chosenCohort ? `Create sitting and allocate ${chosenCohort.members.toLocaleString()} students` : "Create sitting"}</button>
          </form>
        </Card>
      )}

      <div className="flex gap-1 border-b border-line mb-4">
        {([["list", "All sittings"], ["calendar", "Calendar"], ["workload", "Marking workload"]] as [View, string][]).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setView(k)} className={"px-3.5 py-2.5 -mb-px font-display text-[13.5px] font-semibold border-b-2 transition " + (view === k ? "text-brand-700 border-brand-600" : "text-ink-muted border-transparent hover:text-ink")}>{label}</button>
        ))}
      </div>

      {view === "calendar" && <SittingsCalendar onOpen={(id) => { setView("list"); setOpenId(id); }} />}
      {view === "workload" && <MarkingWorkload />}

      {view === "list" && <Card>
        <CardHead title="All sittings" subtitle={sittings.length ? `${sittings.length} scheduled` : undefined} />
        <div className="px-2 pb-2">
          {sittings.length ? (
            <table className="data">
              <thead>
                <tr><th>Sitting</th><th>Cohort</th><th>Window</th><th>Assessor</th><th className="text-right">On the roster</th><th></th></tr>
              </thead>
              <tbody>
                {sittings.map((s) => (
                  <Fragment key={s.id}>
                    <tr className={openId === s.id ? "bg-brand-50/30" : ""}>
                      <td>
                        <div className="font-semibold">{s.name ?? s.qualificationTitle}</div>
                        <div className="t-sub">{s.name ? s.qualificationTitle + " · " : ""}{typeWord(qualifications.find((q) => q.id === s.qualificationId)?.qctoRegistrationType)}{s.venue ? ` · ${s.venue}` : ""}{s.capacity ? ` · ${s.capacity} seats` : ""}</div>
                      </td>
                      <td>{s.cohortId ? <Link to={`/admin/cohorts/${s.cohortId}`} className="lnk">{s.cohortName}</Link> : <span className="text-ink-faint">—</span>}</td>
                      <td>{fmt(s.startTime)} <span className="text-ink-faint">→</span> {fmt(s.endTime)}</td>
                      <td>{s.assessorName}</td>
                      <td className="text-right tabular">{s.learners.toLocaleString()}</td>
                      <td className="text-right">
                        <button className="lnk" onClick={() => setOpenId(openId === s.id ? null : s.id)}>
                          {openId === s.id ? "Close roster" : "Roster"}
                        </button>
                      </td>
                    </tr>
                    {openId === s.id && (
                      <tr>
                        <td colSpan={6} className="!pt-0">
                          <Roster sitting={s} cohorts={cohorts} onChanged={async (m) => { setMessage(m); setError(null); await loadAll(); }} onError={setError} />
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
      </Card>}
    </>
  );
}

// ---- Roster: who is on the sitting -------------------------------------------------------

const SESSION_LABEL: Record<string, string> = { scheduled: "Scheduled", checked_in: "Checked in", in_progress: "Writing", submitted: "Submitted", sealed: "Sealed" };

function Roster({ sitting, cohorts, onChanged, onError }: { sitting: SittingListRow; cohorts: Cohort[]; onChanged: (m: string) => Promise<void>; onError: (m: string) => void }) {
  const [data, setData] = useState<{ rows: SittingRosterRow[]; total: number; byStatus: Record<string, number> } | null>(null);
  const [q, setQ] = useState("");
  const debounced = useDebounced(q, 300);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addCohortId, setAddCohortId] = useState("");
  const [addMode, setAddMode] = useState<"none" | "search">("none");
  const PAGE = 100;

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE) });
    if (debounced.trim()) params.set("q", debounced.trim());
    try {
      setData(await api.get(`/sittings/${sitting.id}/learners?${params}`));
    } catch (err) { onError((err as Error).message); }
  }, [sitting.id, page, debounced]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [debounced]);

  async function addCohort() {
    if (!addCohortId) return;
    try {
      const r = await api.post<CohortAllocation>(`/sittings/${sitting.id}/assign-cohort`, { cohortId: addCohortId });
      await onChanged(`${r.cohortName}: ${r.assigned} allocated${r.alreadyAssigned ? `, ${r.alreadyAssigned} already on the roster` : ""}${r.skipped ? `, ${r.skipped} suspended/archived left out` : ""}.`);
      setAddCohortId("");
      await load();
    } catch (err) { onError((err as Error).message); }
  }

  async function removeSelected() {
    if (!selected.size) return;
    if (!window.confirm(`Take ${selected.size} student${selected.size === 1 ? "" : "s"} off this sitting? Only students who have not started can be removed.`)) return;
    try {
      const r = await api.del<{ removed: number; notRemoved: number }>(`/sittings/${sitting.id}/learners`, { learnerIds: [...selected] });
      await onChanged(`${r.removed} removed from the roster${r.notRemoved ? ` (${r.notRemoved} had already started and stay)` : ""}.`);
      setSelected(new Set());
      await load();
    } catch (err) { onError((err as Error).message); }
  }

  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE));
  const total = data?.total ?? 0;
  const statusLine = data ? Object.entries(data.byStatus).map(([k, v]) => `${v} ${SESSION_LABEL[k]?.toLowerCase() ?? k}`).join(" · ") : "";

  return (
    <div className="rounded-lg border border-line bg-surface-2 p-3.5 space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-display font-semibold text-[13.5px]">Roster · {total.toLocaleString()} student{total === 1 ? "" : "s"}</span>
        {statusLine && <span className="t-sub">{statusLine}</span>}
        <span className="flex-1" />
        <select className="inp w-auto" value={addCohortId} onChange={(e) => setAddCohortId(e.target.value)}>
          <option value="">Add a whole cohort…</option>
          {cohorts.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.members}</option>)}
        </select>
        <button type="button" className="btn btn-sm" disabled={!addCohortId} onClick={addCohort}>Add cohort</button>
        <button type="button" className="btn-ghost btn-sm" onClick={() => setAddMode(addMode === "search" ? "none" : "search")}>{addMode === "search" ? "Done" : "Add individual students"}</button>
      </div>
      {addMode === "search" && <AddIndividuals sittingId={sitting.id} onAdded={async (m) => { await onChanged(m); await load(); }} onError={onError} />}
      <div className="flex items-center gap-3">
        <input className="inp max-w-xs" placeholder="Find a student on this roster…" value={q} onChange={(e) => setQ(e.target.value)} />
        {selected.size > 0 && <button type="button" className="btn-ghost btn-sm" onClick={removeSelected}>Remove {selected.size} from roster</button>}
        <span className="flex-1" />
        {pages > 1 && (
          <span className="t-sub flex items-center gap-2">
            <button type="button" className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>←</button>
            Page {page} of {pages}
            <button type="button" className="btn-ghost btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>→</button>
          </span>
        )}
      </div>
      {data && data.rows.length === 0 ? (
        <p className="t-sub">{total === 0 ? "Nobody on the roster yet. Add a cohort above." : "No student on this roster matches."}</p>
      ) : (
        <div className="rounded-md border border-line bg-surface overflow-hidden">
          <table className="data">
            <thead><tr><th className="w-8"></th><th>Name</th><th>Email</th><th>ID number</th><th>Account</th><th>Exam</th></tr></thead>
            <tbody>
              {(data?.rows ?? []).map((r) => (
                <tr key={r.sessionId}>
                  <td><input type="checkbox" className="accent-brand-600" disabled={r.sessionStatus !== "scheduled"} checked={selected.has(r.learnerId)} onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(r.learnerId)) n.delete(r.learnerId); else n.add(r.learnerId); return n; })} /></td>
                  <td><Link to={`/admin/people/${r.learnerId}`} className="font-semibold hover:underline">{r.name}</Link></td>
                  <td className="text-ink-muted">{r.email}</td>
                  <td className="tabular text-ink-muted">{r.idNumberMasked ?? "—"}</td>
                  <td><StatusBadge status={r.accountStatus} /></td>
                  <td><Badge tone={r.sessionStatus === "scheduled" ? "gray" : r.sessionStatus === "in_progress" ? "blue" : "green"}>{SESSION_LABEL[r.sessionStatus] ?? r.sessionStatus}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AddIndividuals({ sittingId, onAdded, onError }: { sittingId: string; onAdded: (m: string) => Promise<void>; onError: (m: string) => void }) {
  const [q, setQ] = useState("");
  const debounced = useDebounced(q, 300);
  const [results, setResults] = useState<PeopleListResponse | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!debounced.trim()) return setResults(null);
    api.get<PeopleListResponse>(`/people?type=students&pageSize=15&q=${encodeURIComponent(debounced.trim())}`).then(setResults).catch((e) => onError((e as Error).message));
  }, [debounced]); // eslint-disable-line react-hooks/exhaustive-deps
  async function add() {
    try {
      const r = await api.post<{ assigned: number; alreadyAssigned: number }>(`/sittings/${sittingId}/assign-learners`, { learnerIds: [...picked] });
      await onAdded(`${r.assigned} added to the roster${r.alreadyAssigned ? ` (${r.alreadyAssigned} already on it)` : ""}.`);
      setPicked(new Set()); setQ(""); setResults(null);
    } catch (err) { onError((err as Error).message); }
  }
  return (
    <div className="rounded-md border border-line bg-surface p-3 space-y-2">
      <div className="flex items-center gap-3">
        <input className="inp max-w-sm" autoFocus placeholder="Search a student by name, email, student number or ID last four…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn btn-sm" disabled={!picked.size} onClick={add}>Add {picked.size || ""} to roster</button>
      </div>
      {results && (
        <div className="divide-y divide-line max-h-60 overflow-auto">
          {results.rows.length === 0 && <p className="t-sub p-2">No students match.</p>}
          {results.rows.map((r) => (
            <label key={r.id} className="flex items-center gap-3 px-2 py-1.5 text-[13.5px] cursor-pointer hover:bg-surface-2">
              <input type="checkbox" className="accent-brand-600" checked={picked.has(r.id)} onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} />
              <span className="font-semibold w-56 truncate">{r.name}</span>
              <span className="text-ink-muted flex-1 truncate">{r.email}</span>
              <span className="text-ink-faint text-[12px]">{r.cohorts.map((x) => x.name).join(", ")}</span>
            </label>
          ))}
        </div>
      )}
    </div>
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
