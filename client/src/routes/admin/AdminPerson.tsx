import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../lib/api";
import type { PersonDetail, EmploymentRelationship } from "@shared/types";
import { PageHeader, Card, CardHead, Notice, Badge, Empty } from "../../components/ui";
import SetupLinkPanel, { type SetupIssue } from "../../components/SetupLinkPanel";
import { StatusBadge } from "./AdminUsers";

// One person: who they are, how they sign in, and their history on the exam
// centre. Edits and status changes are audited; the ID number is shown masked
// and revealed only on request (which is itself audited).

const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
const ROLE_LABEL: Record<string, string> = { learner: "Learner", assessor: "Assessor", invigilator: "Invigilator", administrator: "Administrator" };
const ACTION_LABEL: Record<string, string> = {
  user_created: "Registered",
  user_edited: "Details edited",
  user_setup_link_sent: "Set-up link sent",
  user_setup_links_chased: "Set-up link re-sent (chase)",
  account_setup_completed: "Set-up completed by the person",
  user_status_suspended: "Suspended",
  user_status_archived: "Archived",
  user_status_active: "Reactivated",
  user_id_number_viewed: "ID number viewed",
  user_mfa_reset: "Authenticator reset",
};

export default function AdminPerson() {
  const { id } = useParams<{ id: string }>();
  const [p, setP] = useState<PersonDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [setup, setSetup] = useState<SetupIssue | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", studentNumber: "", idNumber: "", registrationNumber: "", employment: "" as EmploymentRelationship | "" });
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const d = await api.get<PersonDetail>(`/people/${id}`);
    setP(d);
    setForm({ name: d.name, email: d.email, studentNumber: d.studentNumber ?? "", idNumber: "", registrationNumber: d.registrationNumber ?? "", employment: d.employmentRelationship ?? "" });
  }, [id]);
  useEffect(() => {
    load().catch((err) => setError((err as Error).message));
  }, [load]);

  async function save() {
    if (!id) return;
    setError(null);
    setBusy(true);
    try {
      await api.patch(`/people/${id}`, {
        name: form.name,
        email: form.email,
        studentNumber: form.studentNumber || null,
        registrationNumber: form.registrationNumber || null,
        employmentRelationship: form.employment || null,
        ...(form.idNumber.trim() ? { idNumber: form.idNumber.trim() } : {}),
      });
      setEditing(false);
      setRevealed(null);
      setMessage("Details saved.");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: "active" | "suspended" | "archived") {
    if (!id || !p) return;
    const word = status === "active" ? "reactivate" : status;
    const reason = status === "active" ? "" : window.prompt(`Reason to ${word} ${p.name} (goes in the audit log):`) ?? "";
    if (status !== "active" && !reason.trim()) return;
    setError(null);
    try {
      await api.patch(`/people/${id}`, { status, reason: reason || undefined });
      setMessage(status === "active" ? `${p.name} can sign in again.` : `${p.name} ${status}. They cannot sign in.`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function sendLink() {
    if (!id || !p) return;
    setError(null);
    try {
      const r = await api.post<{ setup: SetupIssue }>(`/users/${id}/setup-link`);
      setSetup(r.setup);
      setMessage(r.setup.emailSent ? `Set-up link emailed to ${p.email}.` : "Set-up link ready to send.");
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function reveal() {
    if (!id) return;
    try {
      const r = await api.get<{ idNumber: string | null }>(`/people/${id}/id-number`);
      setRevealed(r.idNumber ?? "—");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!p) {
    return (
      <>
        <PageHeader title="Person" />
        {error ? <Notice kind="error">{error}</Notice> : <p className="text-sm text-ink-muted">Loading…</p>}
      </>
    );
  }

  const isLearner = p.roles.includes("learner");
  const isAssessor = p.roles.includes("assessor");
  const isInvigilator = p.roles.includes("invigilator");
  const backType = isLearner ? "students" : isAssessor ? "assessors" : isInvigilator ? "invigilators" : "administrators";

  return (
    <>
      <div className="mb-4">
        <Link to={`/admin/people?type=${backType}`} className="lnk">← Register People</Link>
      </div>
      <PageHeader
        title={p.name}
        subtitle={`${p.email}${p.studentNumber ? ` · Student no. ${p.studentNumber}` : ""}${p.registrationNumber ? ` · Reg. ${p.registrationNumber}` : ""} · registered ${fmt(p.createdAt)}`}
        action={
          <div className="flex items-center gap-2">
            {p.roles.map((r) => <Badge key={r} tone={r === "learner" ? "gray" : r === "assessor" ? "blue" : r === "invigilator" ? "amber" : "green"}>{ROLE_LABEL[r] ?? r}</Badge>)}
            <StatusBadge status={p.status} />
          </div>
        }
      />
      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}
      {setup && <SetupLinkPanel name={p.name} email={p.email} issue={setup} onClose={() => setSetup(null)} />}

      <div className="grid grid-cols-[1fr_360px] gap-5 items-start">
        <div className="space-y-5">
          {/* Details */}
          <Card>
            <CardHead
              title="Details"
              right={
                editing ? (
                  <div className="flex gap-2">
                    <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
                    <button type="button" className="btn btn-sm" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
                  </div>
                ) : (
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(true)}>Edit</button>
                )
              }
            />
            {editing ? (
              <div className="px-5 pb-5 grid grid-cols-2 gap-3.5">
                <div><label className="field-lbl">Full name</label><input className="inp" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
                <div><label className="field-lbl">Email</label><input className="inp" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
                {isLearner && (
                  <>
                    <div><label className="field-lbl">Student number <span className="normal-case font-normal text-ink-faint">— optional</span></label><input className="inp tabular" value={form.studentNumber} onChange={(e) => setForm({ ...form, studentNumber: e.target.value })} /></div>
                    <div>
                      <label className="field-lbl">ID number <span className="normal-case font-normal text-ink-faint">{p.idNumberMasked ? `(currently ${p.idNumberMasked}; type a new one to replace)` : "(none on record)"}</span></label>
                      <input className="inp tabular" inputMode="numeric" value={form.idNumber} onChange={(e) => setForm({ ...form, idNumber: e.target.value.replace(/[^\d ]/g, "") })} placeholder="leave blank to keep" />
                    </div>
                  </>
                )}
                {isAssessor && <div><label className="field-lbl">Registration number</label><input className="inp tabular" value={form.registrationNumber} onChange={(e) => setForm({ ...form, registrationNumber: e.target.value })} /></div>}
                {(isAssessor || isInvigilator) && (
                  <div>
                    <label className="field-lbl">Employment</label>
                    <select className="inp" value={form.employment} onChange={(e) => setForm({ ...form, employment: e.target.value as EmploymentRelationship | "" })}>
                      <option value="">Not specified</option>
                      <option value="internal">Internal — FPT staff</option>
                      <option value="external">External — independent</option>
                    </select>
                  </div>
                )}
              </div>
            ) : (
              <dl className="px-5 pb-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <div><dt className="field-lbl">Email</dt><dd>{p.email}</dd></div>
                <div><dt className="field-lbl">Source</dt><dd>{p.source === "fptstaff" ? `FPTStaff (${p.fptstaffId})` : "Added here"}</dd></div>
                {isLearner && (
                  <>
                    <div>
                      <dt className="field-lbl">ID number <span className="normal-case font-normal text-ink-faint">— student identifier</span></dt>
                      <dd className="tabular">
                        {revealed ? <span>{revealed}</span> : p.idNumberMasked ?? <span className="text-amber-700">not recorded — needed for the Statement of Results</span>}
                        {p.idNumberMasked && !revealed && <button type="button" className="lnk ml-3 text-[12px]" onClick={reveal}>Reveal (audited)</button>}
                      </dd>
                    </div>
                    <div><dt className="field-lbl">Student number</dt><dd className="tabular">{p.studentNumber ?? <span className="text-ink-faint">none</span>}</dd></div>
                    <div className="col-span-2">
                      <dt className="field-lbl">Cohorts</dt>
                      <dd>
                        {p.cohorts.length === 0
                          ? <span className="text-ink-faint">not in a cohort yet — <Link to="/admin/cohorts" className="lnk">Cohorts</Link></span>
                          : p.cohorts.map((c, i) => <span key={c.id}>{i > 0 && ", "}<Link to={`/admin/cohorts/${c.id}`} className="lnk">{c.name}</Link></span>)}
                      </dd>
                    </div>
                  </>
                )}
                {isAssessor && <div><dt className="field-lbl">Registration number</dt><dd className="tabular">{p.registrationNumber ?? <span className="text-ink-faint">not recorded</span>}</dd></div>}
                {(isAssessor || isInvigilator) && <div><dt className="field-lbl">Employment</dt><dd>{p.employmentRelationship === "external" ? "External — independent" : p.employmentRelationship === "internal" ? "Internal — FPT staff" : <span className="text-ink-faint">not specified</span>}</dd></div>}
              </dl>
            )}
          </Card>

          {/* History */}
          {isLearner && (
            <Card>
              <CardHead title="Sittings and results" subtitle={`${p.sittings.length} sitting${p.sittings.length === 1 ? "" : "s"}`} />
              {p.sittings.length === 0 ? (
                <Empty>Not yet allocated to a sitting.</Empty>
              ) : (
                <table className="data">
                  <thead><tr><th>Sitting</th><th>Assessment</th><th>Session</th><th>Result</th></tr></thead>
                  <tbody>
                    {p.sittings.map((s) => (
                      <tr key={s.sessionId}>
                        <td className="whitespace-nowrap">{fmt(s.startTime)}</td>
                        <td>{s.qualificationTitle}</td>
                        <td><Badge tone="gray">{s.sessionStatus.replace(/_/g, " ")}</Badge></td>
                        <td>
                          {s.signedOffAt ? (
                            <>
                              {s.outcome === "competent" ? <Badge tone="green">Competent</Badge> : <Badge tone="amber">Not yet competent</Badge>}
                              {s.totalMax ? <span className="t-sub tabular ml-2">{s.totalMark}/{s.totalMax}</span> : null}
                            </>
                          ) : (
                            <span className="text-ink-faint">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          )}
          {isAssessor && (
            <Card>
              <CardHead title="Marking" subtitle={`${p.assessing.length} sitting${p.assessing.length === 1 ? "" : "s"} assigned`} />
              {p.assessing.length === 0 ? (
                <Empty>No sittings assigned yet.</Empty>
              ) : (
                <table className="data">
                  <thead><tr><th>Sitting</th><th>Assessment</th><th>Scripts</th><th>Signed off</th></tr></thead>
                  <tbody>
                    {p.assessing.map((s) => (
                      <tr key={s.sittingId}>
                        <td className="whitespace-nowrap">{fmt(s.startTime)}</td>
                        <td>{s.qualificationTitle}</td>
                        <td className="tabular">{s.scripts}</td>
                        <td className="tabular">{s.signedOff}/{s.scripts}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          )}
          {isInvigilator && (
            <Card>
              <CardHead title="Invigilation duties" subtitle={`${p.invigilating.length} sitting${p.invigilating.length === 1 ? "" : "s"}`} />
              {p.invigilating.length === 0 ? (
                <Empty>No duties assigned yet.</Empty>
              ) : (
                <table className="data">
                  <thead><tr><th>Sitting</th><th>Ends</th><th>Assessment</th></tr></thead>
                  <tbody>
                    {p.invigilating.map((s) => (
                      <tr key={s.sittingId}><td className="whitespace-nowrap">{fmt(s.startTime)}</td><td className="whitespace-nowrap">{fmt(s.endTime)}</td><td>{s.qualificationTitle}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          )}
        </div>

        <div className="space-y-5">
          {/* Sign-in */}
          <Card>
            <CardHead title="Sign-in" />
            <div className="px-5 pb-5 space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-ink-muted">Status</span>
                <StatusBadge status={p.status} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-muted">First signed in / set up</span>
                <span>{p.setup.activatedAt ? fmt(p.setup.activatedAt) : <span className="text-ink-faint">not yet</span>}</span>
              </div>
              {p.setup.liveLinkExpiresAt && (
                <div className="flex items-center justify-between">
                  <span className="text-ink-muted">Set-up link</span>
                  <span>valid until {fmt(p.setup.liveLinkExpiresAt)}</span>
                </div>
              )}
              {!isLearner && (
                <div className="flex items-center justify-between">
                  <span className="text-ink-muted">Authenticator</span>
                  <span>{p.setup.hasAuthenticator ? "required at sign-in" : "not set"}</span>
                </div>
              )}
              <div className="pt-2 flex flex-col gap-2">
                {p.status !== "archived" && p.status !== "suspended" && (
                  <button type="button" className="btn-ghost btn-sm" onClick={sendLink}>
                    {p.status === "invited" ? "Re-send set-up link" : "Send set-up link (reset sign-in)"}
                  </button>
                )}
                {p.status === "active" || p.status === "invited" ? (
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setStatus("suspended")}>Suspend</button>
                ) : (
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setStatus("active")}>Reactivate</button>
                )}
                {p.status !== "archived" && (
                  <button type="button" className="btn-ghost btn-sm text-ink-muted" onClick={() => setStatus("archived")}>Archive</button>
                )}
              </div>
            </div>
          </Card>

          <Card>
            <CardHead title="Audit trail" subtitle="Most recent first" />
            {p.audit.length === 0 ? (
              <Empty>Nothing recorded.</Empty>
            ) : (
              <ul className="divide-y divide-line">
                {p.audit.map((a, i) => (
                  <li key={i} className="px-5 py-2.5 text-[13px]">
                    <p className="font-semibold">{ACTION_LABEL[a.action] ?? a.action}</p>
                    <p className="t-sub">{fmt(a.at)}{a.reason ? ` · ${a.reason}` : ""}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
