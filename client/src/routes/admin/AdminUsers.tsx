import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import type { UserRole, EmploymentRelationship, PersonRow, PeopleListResponse, PersonType, UserStatus, ImportPreviewRow, Cohort } from "@shared/types";
import { PageHeader, Card, CardHead, Notice, Badge, Empty, PlusIcon } from "../../components/ui";
import SetupLinkPanel, { type SetupIssue } from "../../components/SetupLinkPanel";
import type { BadgeTone } from "../../components/ui";

// Register People at scale (build plan Block 1): one tab per kind of person,
// server-side search / filter / paging, account status, bulk import with a
// preview, CSV export, and "chase" for everyone who has not used their set-up
// link. Roles are the underlying model; the tabs are how the Administrator
// thinks about it.

type RegisterType = "student" | "assessor" | "invigilator" | "administrator";

const TABS: { key: PersonType; label: string; short: string; registerAs: RegisterType }[] = [
  { key: "students", label: "Students", short: "Students", registerAs: "student" },
  { key: "assessors", label: "Assessors & Moderators", short: "Assessors", registerAs: "assessor" },
  { key: "invigilators", label: "Invigilators", short: "Invigilators", registerAs: "invigilator" },
  { key: "administrators", label: "Administrators", short: "Admins", registerAs: "administrator" },
];

const REGISTER_TYPES: { key: RegisterType; label: string; role: UserRole; fromFptstaff: boolean }[] = [
  { key: "student", label: "Student", role: "learner", fromFptstaff: true },
  { key: "assessor", label: "Assessor", role: "assessor", fromFptstaff: true },
  { key: "invigilator", label: "Invigilator", role: "invigilator", fromFptstaff: true },
  { key: "administrator", label: "Administrator", role: "administrator", fromFptstaff: false },
];

const ROLE_OPTIONS: { value: UserRole; label: string }[] = [
  { value: "learner", label: "Learner" },
  { value: "assessor", label: "Assessor" },
  { value: "invigilator", label: "Invigilator" },
  { value: "administrator", label: "Administrator" },
];

const ROLE_TONE: Record<string, BadgeTone> = { administrator: "green", assessor: "blue", invigilator: "amber", learner: "gray" };

export function StatusBadge({ status }: { status: UserStatus }) {
  const map: Record<UserStatus, { tone: BadgeTone; label: string }> = {
    invited: { tone: "amber", label: "Invited" },
    active: { tone: "green", label: "Active" },
    suspended: { tone: "gray", label: "Suspended" },
    archived: { tone: "gray", label: "Archived" },
  };
  const m = map[status] ?? map.active;
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

const FPTSTAFF_CONNECTED = false;
const PAGE_SIZE = 50;
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—");

export default function AdminUsers() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.key === params.get("type"))?.key ?? "students") as PersonType;
  const status = (params.get("status") as UserStatus | null) ?? "";
  const page = Math.max(1, Number(params.get("page") ?? 1));
  const cohortId = params.get("cohort") ?? "";
  const [q, setQ] = useState(params.get("q") ?? "");
  const [cohortList, setCohortList] = useState<Cohort[]>([]);
  useEffect(() => { api.get<Cohort[]>("/cohorts").then(setCohortList).catch(() => {}); }, []);
  const debounced = useDebounced(q, 300);

  const [data, setData] = useState<PeopleListResponse | null>(null);
  const [summary, setSummary] = useState<Record<string, { total: number; invited: number }>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ name: string; email: string; issue: SetupIssue } | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [chaseLinks, setChaseLinks] = useState<{ name: string; email: string; setupUrl: string }[] | null>(null);

  const setParam = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v === null || v === "" ? next.delete(k) : next.set(k, v);
    if (!("page" in patch)) next.delete("page");
    setParams(next, { replace: true });
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ type: tab, page: String(page), pageSize: String(PAGE_SIZE) });
      if (debounced.trim()) qs.set("q", debounced.trim());
      if (status) qs.set("status", status);
      if (cohortId && tab === "students") qs.set("cohortId", cohortId);
      const [list, sum] = await Promise.all([api.get<PeopleListResponse>(`/people?${qs}`), api.get<Record<string, { total: number; invited: number }>>("/people/summary")]);
      setData(list);
      setSummary(sum);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [tab, page, debounced, status, cohortId]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if ((params.get("q") ?? "") !== debounced) setParam({ q: debounced || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  async function sendSetupLink(u: PersonRow) {
    const supervisory = !(u.roles.length === 1 && u.roles[0] === "learner");
    if (!window.confirm(`Send ${u.name} a new set-up link? Any earlier link stops working${supervisory ? ", and their current authenticator entry will need to be set up again" : ""}.`)) return;
    setError(null);
    setMessage(null);
    try {
      const r = await api.post<{ setup: SetupIssue }>(`/users/${u.id}/setup-link`);
      setMessage(r.setup.emailSent ? `Set-up link emailed to ${u.email}.` : `Set-up link ready for ${u.name}.`);
      setSetup({ name: u.name, email: u.email, issue: r.setup });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function chase() {
    const n = summary[tab]?.invited ?? 0;
    if (!n) return;
    if (!window.confirm(`Re-send set-up links to all ${n} invited ${TABS.find((t) => t.key === tab)!.label.toLowerCase()}? Earlier links stop working.`)) return;
    setError(null);
    setMessage(null);
    try {
      const r = await api.post<{ total: number; emailed: number; links: { name: string; email: string; setupUrl: string }[] }>(`/people/chase-setup-links?type=${tab}`);
      setMessage(r.emailed === r.total ? `Set-up links emailed to ${r.emailed} people.` : `${r.total} links issued — ${r.emailed} emailed; ${r.links.length} to send by hand (below).`);
      setChaseLinks(r.links.length ? r.links : null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function exportCsv() {
    const qs = new URLSearchParams({ type: tab });
    if (debounced.trim()) qs.set("q", debounced.trim());
    if (status) qs.set("status", status);
    if (cohortId && tab === "students") qs.set("cohortId", cohortId);
    window.open(`/api/people/export.csv?${qs}`, "_blank");
  }

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = TABS.find((t) => t.key === tab)!;
  const invitedHere = summary[tab]?.invited ?? 0;

  return (
    <>
      <PageHeader
        title="Register People"
        subtitle="Students, assessors and moderators, invigilators and administrators — searched, filtered and imported in bulk. Pulled from FPTStaff once it is connected."
        action={
          <div className="flex items-center gap-2">
            <button className="btn-ghost whitespace-nowrap" onClick={() => { setShowImport((v) => !v); setShowCreate(false); }}>
              {showImport ? "Close import" : "Import from file"}
            </button>
            <button className="btn whitespace-nowrap" onClick={() => { setShowCreate((v) => !v); setShowImport(false); }}>
              {showCreate ? "Close" : <><PlusIcon /> Register a person</>}
            </button>
          </div>
        }
      />

      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}
      {setup && <SetupLinkPanel name={setup.name} email={setup.email} issue={setup.issue} onClose={() => setSetup(null)} />}
      {chaseLinks && (
        <Card className="mb-5">
          <CardHead title="Set-up links to send by hand" subtitle="Email is not connected, so these were not sent. Copy each link to the person." right={<button className="btn-ghost btn-sm" onClick={() => setChaseLinks(null)}>Done</button>} />
          <ul className="divide-y divide-line">
            {chaseLinks.map((l) => (
              <li key={l.email} className="px-5 py-2.5 flex items-center gap-3 text-[13px]">
                <span className="font-semibold w-48 truncate">{l.name}</span>
                <span className="text-ink-muted w-56 truncate">{l.email}</span>
                <code className="flex-1 truncate text-[12px] select-all">{l.setupUrl}</code>
                <button type="button" className="btn-ghost btn-sm" onClick={() => navigator.clipboard.writeText(l.setupUrl)}>Copy</button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {showCreate && <RegisterForm defaultType={current.registerAs} onDone={(m, s) => { setMessage(m); setSetup(s); setShowCreate(false); load(); }} onError={setError} />}
      {showImport && <ImportPanel defaultType={tab} onDone={(m) => { setMessage(m); load(); }} onError={setError} />}

      {/* ---- Tabs ---- */}
      <div className="flex items-end justify-between gap-4 border-b border-line mb-4">
        <div className="flex gap-1">
          {TABS.map((t) => {
            const s = summary[t.key];
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => { setParam({ type: t.key, status: null, page: null }); }}
                className={
                  "px-3.5 py-2.5 -mb-px font-display text-[13.5px] font-semibold border-b-2 transition flex items-center gap-2 " +
                  (tab === t.key ? "text-brand-700 border-brand-600" : "text-ink-muted border-transparent hover:text-ink")
                }
              >
                {t.label}
                <span className={"rounded-full px-1.5 py-px text-[11px] tabular " + (tab === t.key ? "bg-brand-50 text-brand-700" : "bg-surface-2 text-ink-faint")}>{s?.total ?? 0}</span>
                {s?.invited ? <span className="rounded-full bg-amber-50 text-amber-700 px-1.5 py-px text-[11px] tabular" title="Invited — set-up link not yet used">{s.invited}</span> : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* ---- Toolbar ---- */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-md">
          <input
            className="inp pl-9"
            placeholder={tab === "students" ? "Search name, email, student number or ID last four…" : "Search name or email…"}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-faint">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
          </svg>
        </div>
        {tab === "students" && cohortList.length > 0 && (
          <select className="inp !w-auto max-w-[260px]" value={cohortId} onChange={(e) => setParam({ cohort: e.target.value || null, page: null })}>
            <option value="">All cohorts</option>
            {cohortList.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.members})</option>)}
          </select>
        )}
        <select className="inp !w-auto" value={status} onChange={(e) => setParam({ status: e.target.value || null })}>
          <option value="">All statuses{data ? ` (${Object.values(data.counts).reduce((a, b) => a + (b ?? 0), 0)})` : ""}</option>
          <option value="invited">Invited{data?.counts.invited ? ` (${data.counts.invited})` : ""}</option>
          <option value="active">Active{data?.counts.active ? ` (${data.counts.active})` : ""}</option>
          <option value="suspended">Suspended{data?.counts.suspended ? ` (${data.counts.suspended})` : ""}</option>
          <option value="archived">Archived{data?.counts.archived ? ` (${data.counts.archived})` : ""}</option>
        </select>
        <span className="flex-1" />
        {invitedHere > 0 && (
          <button type="button" className="btn-ghost btn-sm whitespace-nowrap" onClick={chase}>
            Chase {invitedHere} unused set-up link{invitedHere === 1 ? "" : "s"}
          </button>
        )}
        <button type="button" className="btn-ghost btn-sm whitespace-nowrap" onClick={exportCsv} disabled={!total}>
          Export CSV
        </button>
      </div>

      {/* ---- Table ---- */}
      <Card>
        <div className="px-2 pb-2">
          {!data ? (
            <Empty>Loading…</Empty>
          ) : data.rows.length === 0 ? (
            <Empty>{q || status ? "No one matches." : `No ${current.label.toLowerCase()} registered yet.`}</Empty>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  {tab === "students" && <th>ID number</th>}
                  {tab === "students" && <th>Cohort</th>}
                  {tab === "students" && <th>Student no.</th>}
                  {tab === "assessors" && <th>Registration no.</th>}
                  {(tab === "assessors" || tab === "invigilators") && <th>Employment</th>}
                  {tab === "administrators" && <th>Roles</th>}
                  <th>Status</th>
                  <th>Registered</th>
                  <th className="text-right"></th>
                </tr>
              </thead>
              <tbody className={loading ? "opacity-60" : ""}>
                {data.rows.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <Link to={`/admin/people/${u.id}`} className="font-semibold hover:underline">{u.name}</Link>
                      {u.roles.length > 1 && <p className="t-sub">{u.roles.map((r) => ROLE_OPTIONS.find((o) => o.value === r)?.label ?? r).join(" · ")}</p>}
                    </td>
                    <td className="text-ink-muted">{u.email}</td>
                    {tab === "students" && <td className="tabular text-ink-muted">{u.idNumberMasked ?? <span className="text-ink-faint">—</span>}</td>}
                    {tab === "students" && <td>{u.cohorts.length ? u.cohorts.map((c, i) => <Fragment key={c.id}>{i > 0 && ", "}<Link to={`/admin/cohorts/${c.id}`} className="lnk">{c.name}</Link></Fragment>) : <span className="text-ink-faint">—</span>}</td>}
                    {tab === "students" && <td className="tabular text-ink-muted">{u.studentNumber ?? <span className="text-ink-faint">—</span>}</td>}
                    {tab === "assessors" && <td className="tabular">{u.registrationNumber ?? <span className="text-ink-faint">—</span>}</td>}
                    {(tab === "assessors" || tab === "invigilators") && (
                      <td>{u.employmentRelationship ? <Badge tone={u.employmentRelationship === "external" ? "amber" : "gray"}>{u.employmentRelationship === "external" ? "External" : "Internal"}</Badge> : <span className="text-ink-faint">—</span>}</td>
                    )}
                    {tab === "administrators" && (
                      <td><span className="flex flex-wrap gap-1">{u.roles.map((r) => <Badge key={r} tone={ROLE_TONE[r] ?? "gray"}>{ROLE_OPTIONS.find((o) => o.value === r)?.label ?? r}</Badge>)}</span></td>
                    )}
                    <td><StatusBadge status={u.status} /></td>
                    <td className="whitespace-nowrap text-ink-muted">{fmtDate(u.createdAt)}</td>
                    <td className="text-right whitespace-nowrap">
                      <Link to={`/admin/people/${u.id}`} className="lnk mr-3">Open</Link>
                      {u.status !== "archived" && u.status !== "suspended" && (
                        <button type="button" className="lnk" onClick={() => sendSetupLink(u)}>
                          {u.status === "invited" ? "Re-send link" : "Send set-up link"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {data && total > 0 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-line text-[13px] text-ink-muted">
            <span className="tabular">
              {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total.toLocaleString()}
            </span>
            <div className="flex items-center gap-2">
              <button type="button" className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setParam({ page: String(page - 1) })}>← Previous</button>
              <span className="tabular">Page {page} of {pages}</span>
              <button type="button" className="btn-ghost btn-sm" disabled={page >= pages} onClick={() => setParam({ page: String(page + 1) })}>Next →</button>
            </div>
          </div>
        )}
      </Card>
    </>
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

// ---------------------------------------------------------------------------------
// Register one person
// ---------------------------------------------------------------------------------

function RegisterForm({ defaultType, onDone, onError }: { defaultType: RegisterType; onDone: (message: string, setup: { name: string; email: string; issue: SetupIssue }) => void; onError: (m: string) => void }) {
  const [type, setType] = useState<RegisterType>(defaultType);
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [cohortId, setCohortId] = useState("");
  useEffect(() => { api.get<Cohort[]>("/cohorts?status=active").then(setCohorts).catch(() => {}); }, []);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [studentNumber, setStudentNumber] = useState("");
  const [idNumber, setIdNumber] = useState("");
  const [registrationNumber, setRegistrationNumber] = useState("");
  const [roles, setRoles] = useState<UserRole[]>([REGISTER_TYPES.find((p) => p.key === defaultType)!.role]);
  const [employment, setEmployment] = useState<EmploymentRelationship | "">("");
  const [busy, setBusy] = useState(false);
  const current = REGISTER_TYPES.find((p) => p.key === type)!;

  function chooseType(t: RegisterType) {
    setType(t);
    setRoles([REGISTER_TYPES.find((p) => p.key === t)!.role]);
    if (t !== "invigilator" && t !== "assessor") setEmployment("");
  }
  const toggleRole = (role: UserRole) => setRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    onError("");
    setBusy(true);
    try {
      const created = await api.post<{ setup: SetupIssue }>("/users", {
        name,
        email,
        roles,
        employmentRelationship: employment || undefined,
        source: "manual",
        studentNumber: studentNumber.trim() || undefined,
        idNumber: idNumber.trim() || undefined,
        registrationNumber: registrationNumber.trim() || undefined,
        cohortId: type === "student" && cohortId ? cohortId : undefined,
      });
      onDone(created.setup.emailSent ? `${name} registered — set-up link emailed to ${email}.` : `${name} registered.`, { name, email, issue: created.setup });
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-5">
      <CardHead title="Register a person" subtitle="They receive a set-up link to choose their own password (and, for supervisory roles, link their authenticator). You never handle a password." />
      <form onSubmit={submit} className="px-5 pt-4 pb-5 space-y-5">
        <div>
          <label className="field-lbl">Who are you registering?</label>
          <div className="inline-flex rounded-lg border border-line-strong p-0.5 bg-surface-2">
            {REGISTER_TYPES.map((p) => (
              <button key={p.key} type="button" onClick={() => chooseType(p.key)} className={"px-3.5 py-1.5 rounded-md font-display text-[13px] font-semibold transition " + (type === p.key ? "bg-surface text-brand-700 shadow-card" : "text-ink-muted hover:text-ink")}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {current.fromFptstaff && !FPTSTAFF_CONNECTED && (
          <p className="t-sub">Until FPTStaff is connected, add their details here. Anyone added here is pushed across to FPTStaff automatically once the link is live. For many people at once, use <strong>Import from file</strong>.</p>
        )}

        <div className="rounded-lg border border-line bg-surface-2/60 p-4 space-y-3.5">
          <div className="grid grid-cols-2 gap-3.5">
            <div><label className="field-lbl">Full name</label><input className="inp" value={name} onChange={(e) => setName(e.target.value)} required /></div>
            <div><label className="field-lbl">Email</label><input className="inp" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="name@example.com" /></div>
            {type === "student" && (
              <>
                <div>
                  <label className="field-lbl">ID number <span className="normal-case font-normal text-ink-faint">— the student identifier; stored encrypted, shown masked</span></label>
                  <input className="inp tabular" inputMode="numeric" required pattern="[0-9 ]{13,16}" title="13 digits" value={idNumber} onChange={(e) => setIdNumber(e.target.value.replace(/[^\d ]/g, ""))} placeholder="13 digits" />
                </div>
                <div>
                  <label className="field-lbl">Student number <span className="normal-case font-normal text-ink-faint">— optional (Learnership Manager / FPTStaff reference)</span></label>
                  <input className="inp tabular" value={studentNumber} onChange={(e) => setStudentNumber(e.target.value)} placeholder="if one exists" />
                </div>
                <div>
                  <label className="field-lbl">Cohort <span className="normal-case font-normal text-ink-faint">— optional</span></label>
                  <select className="inp" value={cohortId} onChange={(e) => setCohortId(e.target.value)}>
                    <option value="">— none yet —</option>
                    {cohorts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              </>
            )}
            {type === "assessor" && (
              <div>
                <label className="field-lbl">Registration number <span className="normal-case font-normal text-ink-faint">(assessor / moderator)</span></label>
                <input className="inp tabular" value={registrationNumber} onChange={(e) => setRegistrationNumber(e.target.value)} placeholder="e.g. ASR-4471" />
              </div>
            )}
            {(type === "invigilator" || type === "assessor") && (
              <div>
                <label className="field-lbl">Employment</label>
                <select className="inp" value={employment} onChange={(e) => setEmployment(e.target.value as EmploymentRelationship | "")}>
                  <option value="">Not specified</option>
                  <option value="internal">Internal — FPT staff</option>
                  <option value="external">External — independent</option>
                </select>
                {type === "invigilator" && <p className="text-xs text-ink-faint mt-1.5">Only external invigilators can be assigned to sittings that require independent invigilation.</p>}
              </div>
            )}
          </div>
        </div>

        <div>
          <label className="field-lbl">Roles <span className="normal-case font-normal text-ink-faint">— pre-filled from the type above; adjust if needed</span></label>
          <div className="flex flex-wrap gap-2">
            {ROLE_OPTIONS.map((r) => {
              const on = roles.includes(r.value);
              return (
                <label key={r.value} className={"inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13.5px] cursor-pointer transition " + (on ? "border-brand-600 bg-brand-50 text-brand-800" : "border-line-strong text-ink-muted hover:bg-surface-2")}>
                  <input type="checkbox" className="accent-brand-600" checked={on} onChange={() => toggleRole(r.value)} />
                  {r.label}
                </label>
              );
            })}
          </div>
        </div>

        <button className="btn" disabled={roles.length === 0 || busy}>{busy ? "Registering…" : `Register ${current.label.toLowerCase()}`}</button>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------------
// Bulk import: file → preview → commit
// ---------------------------------------------------------------------------------

export function ImportPanel({ defaultType, cohortId, cohortName, onDone, onError }: { defaultType: PersonType; cohortId?: string; cohortName?: string; onDone: (message: string) => void; onError: (m: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [type, setType] = useState<PersonType | "">(defaultType);
  const [preview, setPreview] = useState<{ filename: string; rows: ImportPreviewRow[]; summary: Record<string, number> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sendLinks, setSendLinks] = useState(true);
  const [result, setResult] = useState<{ created: number; updated: number; rejected: { line: number; email: string; reasons: string[] }[]; emailed: number; links: { name: string; email: string; setupUrl: string }[]; addedToCohort?: number } | null>(null);
  const [show, setShow] = useState<"all" | "create" | "update" | "skip" | "reject">("all");

  async function doPreview() {
    if (!file) return onError("Choose a CSV or Excel file.");
    onError("");
    setBusy(true);
    setResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      if (type) form.append("type", type);
      setPreview(await api.postForm(`/people/import/preview`, form));
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview) return;
    const rows = preview.rows.filter((r) => r.action === "create" || r.action === "update");
    if (!rows.length) return onError("Nothing to import — every row is a skip or a reject.");
    setBusy(true);
    try {
      const r = await api.post<typeof result>(`/people/import/commit`, { rows, sendSetupLinks: sendLinks, cohortId });
      setResult(r);
      setPreview(null);
      setFile(null);
      onDone(`Imported: ${r!.created} created, ${r!.updated} updated${r!.rejected.length ? `, ${r!.rejected.length} rejected` : ""}${cohortName ? ` · ${r!.addedToCohort ?? 0} added to ${cohortName}` : ""}${sendLinks ? ` · ${r!.emailed} set-up links emailed` : ""}.`);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const ACTION_TONE: Record<string, BadgeTone> = { create: "green", update: "blue", skip: "gray", reject: "amber" };
  const visible = preview?.rows.filter((r) => show === "all" || r.action === show) ?? [];

  return (
    <Card className="mb-5">
      <CardHead
        title={cohortName ? `Import students into ${cohortName}` : "Import people from a file"}
        subtitle={`CSV or Excel. Columns: name, email, id_number (13 digits - the student identifier), type (student / assessor / invigilator / administrator), student_number, registration_number, employment. ${cohortName ? "Every student created or updated from the file is added to this cohort. " : ""}Nothing is saved until you confirm the preview.`}
        right={<a className="lnk text-[13px]" href="/api/people/import/template.csv">Download the template</a>}
      />
      <div className="px-5 pt-4 pb-5 space-y-4">
        {!preview && !result && (
          <div className="grid grid-cols-[1fr_220px_auto] gap-3.5 items-end">
            <div>
              <label className="field-lbl">File</label>
              <input type="file" accept=".csv,.xlsx,.xls" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-sm text-ink-muted file:mr-3 file:rounded-md file:border-0 file:bg-brand-50 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-brand-700" />
            </div>
            <div>
              <label className="field-lbl">If the file has no "type" column, they are</label>
              <select className="inp" value={type} onChange={(e) => setType(e.target.value as PersonType | "")}>
                <option value="">— take it from the file —</option>
                <option value="students">Students</option>
                <option value="assessors">Assessors / moderators</option>
                <option value="invigilators">Invigilators</option>
                <option value="administrators">Administrators</option>
              </select>
            </div>
            <button type="button" className="btn" onClick={doPreview} disabled={busy || !file}>{busy ? "Reading…" : "Preview"}</button>
          </div>
        )}

        {preview && (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[13px] text-ink-muted">{preview.filename} · {preview.rows.length} rows:</span>
              {(["create", "update", "skip", "reject"] as const).map((k) => (
                <button key={k} type="button" onClick={() => setShow(show === k ? "all" : k)} className={"badge " + (show === k ? "ring-2 ring-brand-300 " : "") + (k === "create" ? "bg-brand-50 text-brand-700" : k === "update" ? "bg-blue-50 text-blue-700" : k === "reject" ? "bg-amber-50 text-amber-700" : "bg-surface-2 text-ink-muted border border-line badge-plain")}>
                  {preview.summary[k] ?? 0} {k === "create" ? "to create" : k === "update" ? "to update" : k === "skip" ? "unchanged" : "rejected"}
                </button>
              ))}
            </div>
            <div className="max-h-[420px] overflow-auto rounded-lg border border-line">
              <table className="data">
                <thead className="sticky top-0 bg-surface">
                  <tr><th>Line</th><th>Name</th><th>Email</th><th>Type</th><th>Student no.</th><th>Action</th><th>Notes</th></tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={r.line}>
                      <td className="tabular text-ink-faint">{r.line}</td>
                      <td>{r.name || <span className="text-ink-faint">—</span>}</td>
                      <td className="text-ink-muted">{r.email || <span className="text-ink-faint">—</span>}</td>
                      <td>{r.type ?? <span className="text-ink-faint">?</span>}</td>
                      <td className="tabular">{r.studentNumber ?? ""}</td>
                      <td><Badge tone={ACTION_TONE[r.action]}>{r.action}</Badge></td>
                      <td className="text-[12.5px] text-ink-muted">{r.reasons.join("; ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-4">
              <button type="button" className="btn" onClick={commit} disabled={busy || ((preview.summary.create ?? 0) + (preview.summary.update ?? 0)) === 0}>
                {busy ? "Importing…" : `Import ${(preview.summary.create ?? 0) + (preview.summary.update ?? 0)} rows`}
              </button>
              <label className="text-[13px] flex items-center gap-2"><input type="checkbox" className="accent-brand-600" checked={sendLinks} onChange={(e) => setSendLinks(e.target.checked)} /> Send set-up links to new people</label>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setPreview(null)}>Choose another file</button>
              <span className="t-sub">Rejected rows are never imported; fix them in the file and import again.</span>
            </div>
          </>
        )}

        {result && (
          <div className="space-y-3">
            <p className="text-sm">
              <strong>{result.created}</strong> created · <strong>{result.updated}</strong> updated · <strong>{result.rejected.length}</strong> rejected{sendLinks ? <> · <strong>{result.emailed}</strong> set-up links emailed</> : null}
            </p>
            {result.rejected.length > 0 && (
              <ul className="text-[13px] text-amber-800 space-y-1">
                {result.rejected.map((r) => <li key={r.line}>Line {r.line} ({r.email || "no email"}): {r.reasons.join("; ")}</li>)}
              </ul>
            )}
            {result.links.length > 0 && (
              <div>
                <p className="field-lbl">Set-up links to send by hand (email not connected)</p>
                <ul className="divide-y divide-line rounded-lg border border-line max-h-60 overflow-auto">
                  {result.links.map((l) => (
                    <li key={l.email} className="px-3 py-2 flex items-center gap-3 text-[13px]">
                      <span className="font-semibold w-44 truncate">{l.name}</span>
                      <span className="text-ink-muted w-52 truncate">{l.email}</span>
                      <code className="flex-1 truncate text-[12px] select-all">{l.setupUrl}</code>
                      <button type="button" className="btn-ghost btn-sm" onClick={() => navigator.clipboard.writeText(l.setupUrl)}>Copy</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <button type="button" className="btn-ghost btn-sm" onClick={() => setResult(null)}>Import another file</button>
          </div>
        )}
      </div>
    </Card>
  );
}
