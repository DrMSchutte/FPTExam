import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { PageHeader, Card, CardHead, Notice, Badge, Empty } from "../../components/ui";
import type { SystemHealth, RemindersResponse, ReminderRow, RetentionResponse, AuditResponse } from "@shared/types";

// Blocks 8e and 8a: the operational screen. Four questions, in the order an
// Administrator asks them: is anything wrong, is the system telling people what
// they need to know, what is the retention rule about to delete, and who did
// what.

type Tab = "attention" | "reminders" | "retention" | "audit";
const TABS: { key: Tab; label: string }[] = [
  { key: "attention", label: "Needs attention" },
  { key: "reminders", label: "Reminders sent" },
  { key: "retention", label: "Evidence retention" },
  { key: "audit", label: "Audit trail" },
];

const fmtDT = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const mb = (n: number) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.round(n / 1024)} KB`);
const KIND_LABEL: Record<string, string> = {
  assessor_scripts_waiting: "Assessor · scripts waiting",
  assessor_overdue: "Assessor · overdue",
  invigilator_sitting_tomorrow: "Sitting tomorrow",
  admin_digest: "Daily digest",
  admin_health_alert: "Needs attention",
};
const STATUS: Record<string, { tone: "green" | "amber" | "red" | "gray"; word: string }> = {
  sent: { tone: "green", word: "Sent" },
  not_connected: { tone: "amber", word: "Held back — email not connected" },
  failed: { tone: "red", word: "Failed" },
  pending: { tone: "gray", word: "Waiting to go" },
};

export default function AdminSystem() {
  const [tab, setTab] = useState<Tab>("attention");
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadHealth = () => api.get<SystemHealth>("/admin/health").then(setHealth).catch((e) => setError(e.message));
  useEffect(() => { loadHealth(); }, []);

  return (
    <div>
      <PageHeader
        title="System"
        subtitle="What needs attention, what the system has told people, what the retention rule will delete, and everything that has been done."
        action={
          <div className="flex gap-1">
            {TABS.map((t) => (
              <button key={t.key} type="button" onClick={() => setTab(t.key)} className={"btn-ghost btn-sm " + (tab === t.key ? "bg-brand-50 text-brand-700 border-brand-100" : "")}>{t.label}</button>
            ))}
          </div>
        }
      />
      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}

      {tab === "attention" && <Attention health={health} onRefresh={loadHealth} />}
      {tab === "reminders" && <Reminders onRan={(m) => { setMessage(m); loadHealth(); }} onError={setError} />}
      {tab === "retention" && <Retention onDone={(m) => setMessage(m)} onError={setError} />}
      {tab === "audit" && <Audit onError={setError} />}
    </div>
  );
}

function Attention({ health, onRefresh }: { health: SystemHealth | null; onRefresh: () => void }) {
  if (!health) return <Empty>Checking…</Empty>;
  return (
    <>
      <Card className="mb-5">
        <CardHead
          title={health.problems.length === 0 ? "Nothing needs attention" : `${health.problems.length} thing${health.problems.length === 1 ? "" : "s"} need attention`}
          subtitle={`Checked ${fmtDT(health.at)}. This is what the daily digest and the alert emails are built from.`}
          right={<button type="button" className="btn-ghost btn-sm" onClick={onRefresh}>Check again</button>}
        />
        <div className="p-5">
          {health.problems.length === 0 ? (
            <p className="text-sm text-ink-muted">Every script is within the {health.overdueDays}-day marking rule, no job has given up, every result has reached FPTStaff, and every sitting in the next three days has its codes.</p>
          ) : (
            <ul className="space-y-2">
              {health.problems.map((p, i) => (
                <li key={i} className="flex gap-3 text-sm">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-500" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <div className="grid md:grid-cols-2 gap-5">
        <Card>
          <CardHead title="Email" subtitle="Everything the system sends — set-up links, results, reminders — needs these secrets." />
          <div className="p-5 text-sm">
            {health.emailConnected
              ? <p><Badge tone="green">Connected</Badge> <span className="text-ink-muted ml-2">Reminders and result emails are going out.</span></p>
              : <p><Badge tone="amber">Not connected</Badge> <span className="text-ink-muted ml-2">Set <code>SMTP_HOST</code>, <code>SMTP_USER</code> and <code>SMTP_PASS</code> in the Repl's Secrets. Until then every reminder is kept here so you can send it by hand, and nothing is lost.</span></p>}
            {health.remindersOff && <p className="mt-3"><Badge tone="gray">Reminders switched off</Badge> <span className="t-sub ml-2">The secret <code>REMINDERS</code> is set to off.</span></p>}
          </div>
        </Card>
        <Card>
          <CardHead title="Jobs that gave up" subtitle="Background work that failed three times and stopped retrying." />
          {health.failedJobs.length === 0 ? <Empty>None in the last week.</Empty> : (
            <table className="data text-sm">
              <thead><tr><th>Job</th><th>Times</th><th>Last reason</th></tr></thead>
              <tbody>
                {health.failedJobs.map((j) => (
                  <tr key={j.jobType}><td className="font-semibold">{j.jobType.replace(/_/g, " ")}</td><td className="tabular">{j.n}</td><td className="text-xs text-ink-muted">{j.detail ?? "—"}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {health.recordingGaps.length > 0 && (
        <Card className="mt-5">
          <CardHead title="Recordings that did not all arrive" subtitle="Fully recorded sittings in the last week where much less video reached the server than the learner wrote. Usually the room's upload speed." />
          <table className="data text-sm">
            <thead><tr><th>Sitting</th><th>Learner</th><th>Minutes written</th><th>Minutes of video</th></tr></thead>
            <tbody>
              {health.recordingGaps.map((g, i) => (
                <tr key={i}><td>{g.sittingName ?? "—"}</td><td className="font-semibold">{g.learnerName}</td><td className="tabular">{g.expected}</td><td className="tabular text-amber-700">{g.got}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function Reminders({ onRan, onError }: { onRan: (m: string) => void; onError: (m: string) => void }) {
  const [data, setData] = useState<RemindersResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const load = () => api.get<RemindersResponse>("/admin/notifications?limit=120").then(setData).catch((e) => onError(e.message));
  useEffect(() => { load(); }, []);

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ sweep: { queued: number; kinds: Record<string, number> }; sent: { sent: number; notConnected: number; failed: number } }>("/admin/notifications/run-now", {});
      onRan(r.sweep.queued === 0 ? "Nothing new to send — everything due today has already gone out." : `${r.sweep.queued} reminder${r.sweep.queued === 1 ? "" : "s"} worked out: ${r.sent.sent} emailed, ${r.sent.notConnected} held back because email is not connected, ${r.sent.failed} failed.`);
      load();
    } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };

  if (!data) return <Empty>Loading…</Empty>;
  return (
    <Card>
      <CardHead
        title="Reminders"
        subtitle="Assessors are told each morning what is waiting; everyone working a sitting is told the afternoon before; you get a digest and an alert when something needs attention. Each one goes once."
        right={
          <div className="flex items-center gap-3">
            <span className="t-sub">{data.counts.sent} sent · {data.counts.notConnected} held back · {data.counts.failed} failed</span>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={run}>{busy ? "Working…" : "Run the reminders now"}</button>
          </div>
        }
      />
      {data.rows.length === 0 ? <Empty>Nothing yet. Reminders are worked out on the hour.</Empty> : (
        <table className="data text-sm table-fixed">
          <colgroup><col className="w-[11%]" /><col className="w-[15%]" /><col className="w-[20%]" /><col className="w-[34%]" /><col className="w-[20%]" /></colgroup>
          <thead><tr><th>When</th><th>Kind</th><th>To</th><th>Subject</th><th>Status</th></tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <ReminderLine key={r.id} r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function ReminderLine({ r, open, onToggle }: { r: ReminderRow; open: boolean; onToggle: () => void }) {
  const s = STATUS[r.status] ?? STATUS.pending;
  return (
    <>
      <tr className="cursor-pointer" onClick={onToggle}>
        <td className="whitespace-nowrap t-sub">{fmtDT(r.createdAt)}</td>
        <td className="whitespace-nowrap">{KIND_LABEL[r.kind] ?? r.kind.replace(/_/g, " ")}</td>
        <td className="t-sub truncate" title={r.toEmail}>{r.toEmail}</td>
        <td className="font-semibold truncate" title={r.subject}>{r.subject}</td>
        <td><Badge tone={s.tone}>{s.word}</Badge></td>
      </tr>
      {open && (
        <tr><td colSpan={5} className="bg-surface-2/60">
          <pre className="whitespace-pre-wrap text-xs p-4 font-sans">{r.body}</pre>
          {r.detail && <p className="px-4 pb-3 t-sub">{r.detail}</p>}
        </td></tr>
      )}
    </>
  );
}

function Retention({ onDone, onError }: { onDone: (m: string) => void; onError: (m: string) => void }) {
  const [data, setData] = useState<RetentionResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get<RetentionResponse>("/admin/retention").then(setData).catch((e) => onError(e.message));
  useEffect(() => { load(); }, []);

  const sweep = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await api.post<{ sittings: number; stills: number; segments: number; bytesFreed: number; heldSkipped: number; dryRun: boolean }>(`/admin/retention/sweep${dryRun ? "?dryRun=1" : ""}`, {});
      onDone(dryRun
        ? `Nothing was deleted. If you run it, ${r.sittings} sitting${r.sittings === 1 ? "" : "s"} would lose ${r.stills} still${r.stills === 1 ? "" : "s"} and ${r.segments} recording segment${r.segments === 1 ? "" : "s"} (${mb(r.bytesFreed)}).`
        : `Deleted ${r.stills} still${r.stills === 1 ? "" : "s"} and ${r.segments} recording segment${r.segments === 1 ? "" : "s"} from ${r.sittings} sitting${r.sittings === 1 ? "" : "s"}, freeing ${mb(r.bytesFreed)}. Every hash, mark and statement is untouched.`);
      load();
    } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };

  if (!data) return <Empty>Loading…</Empty>;
  return (
    <>
      <Card className="mb-5">
        <CardHead
          title={`Kept for ${data.retentionMonths} months`}
          subtitle={`Captures and recordings from sittings that ended before ${fmtDay(data.cutoff)} are due to be deleted. The sweep runs nightly; the hashes, marks, statements and audit trail are kept permanently.`}
          right={
            <div className="flex gap-2">
              <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => sweep(true)}>What would go?</button>
              <button type="button" className="btn btn-sm" disabled={busy || data.due.length === 0} onClick={() => sweep(false)}>Run the sweep now</button>
            </div>
          }
        />
        <div className="p-5 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div><p className="font-display text-2xl font-extrabold tabular">{data.due.length}</p><p className="t-sub">sittings due</p></div>
          <div><p className="font-display text-2xl font-extrabold tabular">{mb(data.dueBytes)}</p><p className="t-sub">would be freed</p></div>
          <div><p className="font-display text-2xl font-extrabold tabular">{data.onHold.length}</p><p className="t-sub">on hold (never swept)</p></div>
          <div><p className="font-display text-2xl font-extrabold tabular">{data.purgedSittings}</p><p className="t-sub">already cleared</p></div>
        </div>
      </Card>

      <Card className="mb-5">
        <CardHead title="Due now" subtitle="Older than the rule and not on hold." />
        {data.due.length === 0 ? <Empty>Nothing is due. Nothing has aged past the rule, or it is all on hold.</Empty> : (
          <table className="data text-sm">
            <thead><tr><th>Sitting</th><th>Qualification</th><th>Ended</th><th>Stills</th><th>Video segments</th><th>Size</th><th>Learners on hold</th></tr></thead>
            <tbody>
              {data.due.map((d) => (
                <tr key={d.id}>
                  <td className="font-semibold">{d.name ?? "—"}</td>
                  <td className="t-sub">{d.qualificationTitle}</td>
                  <td className="whitespace-nowrap">{fmtDay(d.endTime)}</td>
                  <td className="tabular">{d.stills}</td>
                  <td className="tabular">{d.segments}</td>
                  <td className="tabular whitespace-nowrap">{mb(d.bytes)}</td>
                  <td className="tabular">{d.heldSessions || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="grid md:grid-cols-2 gap-5">
        <Card>
          <CardHead title="On hold" subtitle="An appeal, an investigation or a QCTO request. Put a sitting or one learner on hold from the Evidence Archive." />
          {data.onHold.length === 0 ? <Empty>Nothing is on hold.</Empty> : (
            <table className="data text-sm">
              <thead><tr><th>Sitting</th><th>Ended</th><th>Why</th></tr></thead>
              <tbody>
                {data.onHold.map((h) => (
                  <tr key={h.id}>
                    <td><p className="font-semibold">{h.name ?? "—"}</p><p className="t-sub">{h.qualificationTitle}</p></td>
                    <td className="whitespace-nowrap">{fmtDay(h.endTime)}</td>
                    <td className="text-xs">{h.holdReason ?? (h.heldSessions ? `${h.heldSessions} learner${h.heldSessions === 1 ? "" : "s"} held individually` : "—")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card>
          <CardHead title="Coming up in the next month" subtitle="Sittings that will pass the rule soon — put anything under appeal on hold before then." />
          {data.dueWithinAMonth.length === 0 ? <Empty>Nothing in the next month.</Empty> : (
            <table className="data text-sm">
              <thead><tr><th>Sitting</th><th>Ended</th><th>Due</th></tr></thead>
              <tbody>
                {data.dueWithinAMonth.map((d) => {
                  const due = new Date(new Date(d.endTime).setMonth(new Date(d.endTime).getMonth() + data.retentionMonths));
                  return <tr key={d.id}><td className="font-semibold">{d.name ?? "—"}</td><td className="whitespace-nowrap">{fmtDay(d.endTime)}</td><td className="whitespace-nowrap">{fmtDay(due.toISOString())}</td></tr>;
                })}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}

function Audit({ onError }: { onError: (m: string) => void }) {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [q, setQ] = useState("");
  const [action, setAction] = useState("");
  const [offset, setOffset] = useState(0);
  const limit = 100;

  const params = () => {
    const p = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (q.trim()) p.set("q", q.trim());
    if (action) p.set("action", action);
    return p.toString();
  };
  useEffect(() => {
    const t = setTimeout(() => { api.get<AuditResponse>(`/admin/audit?${params()}`).then(setData).catch((e) => onError(e.message)); }, 250);
    return () => clearTimeout(t);
  }, [q, action, offset]);

  return (
    <Card>
      <CardHead
        title="Audit trail"
        subtitle="Every recorded action, newest first. Nothing here can be edited or deleted from the application."
        right={
          <div className="flex items-center gap-2">
            <input value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} placeholder="Search…" className="inp h-8 text-xs w-40" />
            <select value={action} onChange={(e) => { setAction(e.target.value); setOffset(0); }} className="inp h-8 text-xs max-w-[15rem]">
              <option value="">Every action</option>
              {(data?.actions ?? []).map((a) => <option key={a.action} value={a.action}>{a.label} ({a.n})</option>)}
            </select>
            <a className="lnk text-xs whitespace-nowrap" href={`/api/admin/audit.csv?${params()}`}>Export (CSV)</a>
          </div>
        }
      />
      {!data ? <Empty>Loading…</Empty> : data.rows.length === 0 ? <Empty>Nothing matches.</Empty> : (
        <>
          <table className="data text-sm">
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>On</th><th>Detail</th></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap t-sub">{fmtDT(r.at)}</td>
                  <td><p className="font-semibold">{r.actor}</p>{r.actorEmail && <p className="t-sub">{r.actorEmail}</p>}</td>
                  <td className="whitespace-nowrap">{r.label}</td>
                  <td className="t-sub whitespace-nowrap">{r.targetType ?? "—"}</td>
                  <td className="text-xs text-ink-muted max-w-[34rem]">{r.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between p-4 text-xs">
            <span className="t-sub">{offset + 1}–{Math.min(offset + limit, data.total)} of {data.total}</span>
            <div className="flex gap-2">
              <button type="button" className="btn-ghost btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Newer</button>
              <button type="button" className="btn-ghost btn-sm" disabled={offset + limit >= data.total} onClick={() => setOffset(offset + limit)}>Older</button>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}
