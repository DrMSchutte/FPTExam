import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { Card, CardHead, Badge, Notice } from "../../components/ui";

// Block 6: the FPTStaff connection on Register People - what FPT Exam is
// connected to, a live test, FPTStaff's sections to pull into cohorts, the
// staff pull, and the people added here still to go across.

export interface FptstaffStatus {
  connected: boolean;
  sample: boolean;
  host: string | null;
  pendingResults: number;
  unpushedLearners: number;
  probe?: { ok: boolean; step: string; message: string; sections?: number; staff?: number; ms: number };
}
interface Section { id: string; name: string; qualificationTitle?: string | null; saqaQualificationId?: string | null; site?: string | null; intake?: string | null; learnerCount?: number; status?: string; cohort: { id: string; name: string; members: number; pulledAt: string } | null }
interface PullResult { section: Section; cohortId: string; cohortName: string; cohortCreated: boolean; pulled: number; created: number; updated: number; unchanged: number; addedToCohort: number; rejected: { email: string; reasons: string[] }[]; emailed: number; links: { name: string; email: string; setupUrl: string }[] }

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function ConnectionLine({ status, onProbe, probing, label }: { status: FptstaffStatus | null; onProbe: () => void; probing: boolean; label?: string }) {
  if (!status) return null;
  return (
    <div className="flex items-center gap-3 flex-wrap rounded-lg border border-line bg-surface px-3.5 py-2 text-[13px]">
      <span className={"h-2.5 w-2.5 rounded-full " + (status.probe ? (status.probe.ok ? "bg-brand-500" : "bg-red-500") : status.connected ? "bg-brand-300" : "bg-ink-faint")} />
      <span className="font-semibold">{label ?? "FPTStaff"} · {status.connected ? (status.sample ? "sample" : `connected · ${status.host}`) : "not connected"}</span>
      {status.sample && <Badge tone="amber">Sample data — remove FPTSTAFF_MOCK when FPTStaff is live</Badge>}
      {status.probe && <span className={status.probe.ok ? "text-ink-muted" : "text-red-700"}>{status.probe.message}{status.probe.ok ? ` ${status.probe.sections ?? 0} sections · ${status.probe.staff ?? 0} staff · ${status.probe.ms} ms` : ""}</span>}
      <span className="flex-1" />
      {status.connected && <button type="button" className="btn-ghost btn-sm" onClick={onProbe} disabled={probing}>{probing ? "Testing…" : "Test connection"}</button>}
    </div>
  );
}

export default function FptstaffPanel({ onDone, onError, onLinks }: { onDone: (m: string) => void; onError: (m: string) => void; onLinks: (links: { name: string; email: string; setupUrl: string }[]) => void }) {
  const [status, setStatus] = useState<FptstaffStatus | null>(null);
  const [probing, setProbing] = useState(false);
  const [sections, setSections] = useState<Section[] | null>(null);
  const [sectionsError, setSectionsError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [last, setLast] = useState<PullResult[] | null>(null);

  const loadStatus = () => api.get<FptstaffStatus>("/fptstaff/status").then(setStatus).catch((e) => onError((e as Error).message));
  const loadSections = () => api.get<Section[]>("/fptstaff/sections").then((s) => { setSections(s); setSectionsError(null); }).catch((e) => setSectionsError((e as Error).message));
  useEffect(() => { loadStatus().then(() => loadSections()); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function probe() { setProbing(true); try { setStatus(await api.get<FptstaffStatus>("/fptstaff/status?probe=1")); } catch (e) { onError((e as Error).message); } finally { setProbing(false); } }

  async function pullSections() {
    setBusy("sections");
    try {
      const r = await api.post<{ sections: PullResult[] }>("/fptstaff/pull-sections", { sectionIds: [...picked] });
      setLast(r.sections);
      const created = r.sections.reduce((n, s) => n + s.created, 0), updated = r.sections.reduce((n, s) => n + s.updated, 0), unchanged = r.sections.reduce((n, s) => n + s.unchanged, 0);
      onDone(`Pulled ${r.sections.length} section${r.sections.length === 1 ? "" : "s"} from FPTStaff: ${created} students registered, ${updated} updated, ${unchanged} already here — each in its cohort.`);
      const links = r.sections.flatMap((s) => s.links);
      if (links.length) onLinks(links);
      setPicked(new Set());
      await loadSections(); await loadStatus();
    } catch (e) { onError((e as Error).message); } finally { setBusy(null); }
  }
  async function pullStaff() {
    setBusy("staff");
    try {
      const r = await api.post<{ pulled: number; created: number; updated: number; unchanged: number; rolesAdded: number; links: { name: string; email: string; setupUrl: string }[] }>("/fptstaff/pull-staff", {});
      onDone(`Pulled ${r.pulled} staff from FPTStaff: ${r.created} registered, ${r.updated} updated, ${r.unchanged} already here${r.rolesAdded ? `, ${r.rolesAdded} second role${r.rolesAdded === 1 ? "" : "s"} added` : ""}.`);
      if (r.links.length) onLinks(r.links);
      await loadStatus();
    } catch (e) { onError((e as Error).message); } finally { setBusy(null); }
  }
  async function pushLearners() {
    setBusy("push");
    try { const r = await api.post<{ queued: number }>("/fptstaff/push-learners"); onDone(`${r.queued} student${r.queued === 1 ? "" : "s"} queued to go across to FPTStaff; they get their FPTStaff reference within a minute.`); await loadStatus(); }
    catch (e) { onError((e as Error).message); } finally { setBusy(null); }
  }

  if (status && !status.connected) {
    return (
      <Card className="mb-5">
        <CardHead title="FPTStaff" subtitle="People and cohorts are pulled from FPTStaff by section; people added here are pushed across; signed-off results and Statements are pushed on sign-off." />
        <div className="p-5 text-sm text-ink-muted space-y-2">
          <p className="font-display font-bold text-[15px] text-ink">FPTStaff is not connected yet</p>
          <p className="max-w-2xl">Once FPTStaff exposes its exam-sync (the contract is in <code className="text-[12px]">docs/fptstaff-contract.md</code>) and the two secrets are set on the Repl — <code className="text-[12px]">FPTSTAFF_BASE_URL</code> and <code className="text-[12px]">FPTSTAFF_API_KEY</code> — its sections appear here to pull in. Until then, register people here or import from file; everyone added here goes across automatically once the link is live{status.unpushedLearners ? ` (${status.unpushedLearners} student${status.unpushedLearners === 1 ? "" : "s"} waiting)` : ""}.</p>
          <p className="t-sub">To work with a sample of FPTStaff now, set the secret <code>FPTSTAFF_MOCK</code> = <code>yes</code>.</p>
        </div>
      </Card>
    );
  }

  return (
    <Card className="mb-5">
      <CardHead
        title="FPTStaff"
        subtitle="Pull a section and it becomes a cohort here, named after it; pull again any time to pick up new learners. Students matched by ID number, never duplicated."
        right={<div className="flex items-center gap-2"><button type="button" className="btn-ghost btn-sm" disabled={busy !== null} onClick={pullStaff}>{busy === "staff" ? "Pulling…" : "Pull assessors & invigilators"}</button>{status && status.unpushedLearners > 0 && <button type="button" className="btn-ghost btn-sm" disabled={busy !== null} onClick={pushLearners}>{busy === "push" ? "Queuing…" : `Push ${status.unpushedLearners} added here to FPTStaff`}</button>}</div>}
      />
      <div className="p-5 space-y-4">
        <ConnectionLine status={status} onProbe={probe} probing={probing} />
        {sectionsError && <Notice kind="error">{sectionsError}</Notice>}
        {!sections && !sectionsError && <p className="text-sm text-ink-muted">Reading sections from FPTStaff…</p>}
        {sections && sections.length === 0 && <p className="text-sm text-ink-muted">FPTStaff has no sections to pull.</p>}
        {sections && sections.length > 0 && (
          <>
            <table className="data">
              <thead><tr><th className="w-8"></th><th>Section on FPTStaff</th><th>Qualification</th><th>Learners</th><th>Cohort here</th></tr></thead>
              <tbody>
                {sections.map((s) => (
                  <tr key={s.id}>
                    <td><input type="checkbox" className="accent-brand-600" checked={picked.has(s.id)} onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })} /></td>
                    <td><div className="font-semibold">{s.name}</div><div className="t-sub">{[s.site, s.intake, s.status].filter(Boolean).join(" · ")}</div></td>
                    <td className="text-ink-muted">{s.qualificationTitle ?? "—"}{s.saqaQualificationId ? <span className="t-sub"> · SAQA {s.saqaQualificationId}</span> : null}</td>
                    <td className="tabular">{s.learnerCount ?? "—"}</td>
                    <td>{s.cohort ? <><Link to={`/admin/cohorts/${s.cohort.id}`} className="lnk">{s.cohort.name}</Link><div className="t-sub">{s.cohort.members} members · pulled {fmt(s.cohort.pulledAt)}</div></> : <span className="text-ink-faint">not pulled yet</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center gap-3">
              <button type="button" className="btn" disabled={picked.size === 0 || busy !== null} onClick={pullSections}>{busy === "sections" ? "Pulling…" : picked.size ? `Pull ${picked.size} section${picked.size === 1 ? "" : "s"} into cohorts` : "Pull into cohorts"}</button>
              <button type="button" className="lnk" onClick={() => setPicked(new Set(sections.map((s) => s.id)))}>Select all</button>
              {picked.size > 0 && <button type="button" className="lnk" onClick={() => setPicked(new Set())}>Clear</button>}
            </div>
          </>
        )}
        {last && (
          <div className="rounded-lg border border-line bg-surface-2 p-3.5 text-[13px] space-y-1.5">
            <div className="font-display font-semibold">Last pull</div>
            {last.map((r) => (
              <div key={r.cohortId} className="flex gap-3 flex-wrap">
                <Link to={`/admin/cohorts/${r.cohortId}`} className="lnk">{r.cohortName}</Link>
                <span className="text-ink-muted">{r.pulled} on FPTStaff · {r.created} registered · {r.updated} updated · {r.unchanged} already here · {r.addedToCohort} added to the cohort{r.cohortCreated ? " · cohort created" : ""}{r.rejected.length ? ` · ${r.rejected.length} rejected` : ""}</span>
                {r.rejected.length > 0 && <span className="text-amber-800">{r.rejected.slice(0, 3).map((x) => `${x.email}: ${x.reasons.join(", ")}`).join(" · ")}{r.rejected.length > 3 ? " …" : ""}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
