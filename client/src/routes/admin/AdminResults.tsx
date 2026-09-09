import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { PageHeader, Card, CardHead, Notice, Badge, TypePill, Empty } from "../../components/ui";
import type { IntakeRoute, Cohort, Qualification } from "@shared/types";
import { RouteBadge } from "../../components/intake";

interface ResultRow {
  sessionId: string;
  learnerId: string;
  learnerName: string;
  learnerEmail: string;
  studentNumber: string | null;
  idNumberMasked: string | null;
  cohortId: string | null;
  cohortName: string | null;
  sittingName: string | null;
  qualificationTitle: string;
  qctoRegistrationType: "fisa" | "eisa" | "non_qcto";
  intakeRoute: IntakeRoute;
  instrumentVersion: string;
  sittingStart: string;
  outcome: "competent" | "not_yet_competent" | null;
  totalMark: number | null;
  totalMax: number | null;
  signedOffAt: string;
  assessorName: string;
  pushStatus: "pending" | "sent" | "failed" | null;
  pushSentAt: string | null;
  resultEmail: { status: "sent" | "not_connected" | "queued" | "failed"; detail: string | null; at: string | null } | null;
}

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

// Administrator's read-only view of released results and whether each has
// reached FPTStaff (where moderation and verification run). Nothing here can
// change a result: sign-off is the assessor's and is final.
export default function AdminResults() {
  const [rows, setRows] = useState<ResultRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [qualifications, setQualifications] = useState<Qualification[]>([]);
  const [f, setF] = useState({ cohortId: "", qualificationId: "", outcome: "", from: "", to: "", q: "" });
  const debouncedQ = useDebounced(f.q, 300);

  const query = () => {
    const p = new URLSearchParams();
    if (f.cohortId) p.set("cohortId", f.cohortId);
    if (f.qualificationId) p.set("qualificationId", f.qualificationId);
    if (f.outcome) p.set("outcome", f.outcome);
    if (f.from) p.set("from", new Date(f.from).toISOString());
    if (f.to) { const d = new Date(f.to); d.setHours(23, 59, 59, 999); p.set("to", d.toISOString()); }
    if (debouncedQ.trim()) p.set("q", debouncedQ.trim());
    return p.toString();
  };

  useEffect(() => {
    api.get<Cohort[]>("/cohorts").then(setCohorts).catch(() => {});
    api.get<Qualification[]>("/qualifications").then(setQualifications).catch(() => {});
  }, []);
  useEffect(() => {
    api
      .get<ResultRow[]>(`/assessments/results?${query()}`)
      .then(setRows)
      .catch((err) => setError((err as Error).message));
  }, [f.cohortId, f.qualificationId, f.outcome, f.from, f.to, debouncedQ]); // eslint-disable-line react-hooks/exhaustive-deps

  const competent = rows?.filter((r) => r.outcome === "competent").length ?? 0;
  async function resend(r: ResultRow) {
    try {
      await api.post(`/sessions/${r.sessionId}/resend-result-email`);
      setRows((rows) => rows?.map((x) => (x.sessionId === r.sessionId ? { ...x, resultEmail: { status: "queued", detail: null, at: null } } : x)) ?? null);
    } catch (err) { setError((err as Error).message); }
  }
  const pending = rows?.filter((r) => r.pushStatus !== "sent").length ?? 0;

  return (
    <>
      <PageHeader
        title="Results"
        subtitle="Signed-off results and their hand-over to FPTStaff, where moderation and verification run for passed learners."
      />
      {error && <Notice kind="error">{error}</Notice>}

      <div className="grid grid-cols-3 gap-4 mb-6">
        <Card className="p-5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Results released</p>
          <p className="font-display text-3xl font-extrabold mt-1 tabular">{rows ? rows.length : "—"}</p>
        </Card>
        <Card className="p-5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Competent</p>
          <p className="font-display text-3xl font-extrabold mt-1 tabular text-brand-700">{rows ? competent : "—"}</p>
          <p className="t-sub">{rows && rows.length ? `${Math.round((competent / rows.length) * 100)}% of released results` : ""}</p>
        </Card>
        <Card className="p-5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Awaiting FPTStaff hand-over</p>
          <p className="font-display text-3xl font-extrabold mt-1 tabular text-amber-700">{rows ? pending : "—"}</p>
          <p className="t-sub">Delivered automatically once FPTStaff is connected</p>
        </Card>
      </div>

      <Card>
        <CardHead title="Released results" subtitle="Most recent first" right={<a className="btn-ghost btn-sm" href={`/api/assessments/results/export.csv?${query()}`}>Export results sheet (CSV)</a>} />
        <div className="px-5 pb-3 flex items-center gap-2 flex-wrap border-b border-line">
          <input className="inp max-w-[220px]" placeholder="Search learner…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
          <select className="inp !w-auto max-w-[240px]" value={f.cohortId} onChange={(e) => setF({ ...f, cohortId: e.target.value })}>
            <option value="">All cohorts</option>
            {cohorts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className="inp !w-auto max-w-[260px]" value={f.qualificationId} onChange={(e) => setF({ ...f, qualificationId: e.target.value })}>
            <option value="">All qualifications</option>
            {qualifications.map((q) => <option key={q.id} value={q.id}>{q.title}</option>)}
          </select>
          <select className="inp !w-auto" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}>
            <option value="">Any outcome</option>
            <option value="competent">Competent</option>
            <option value="not_yet_competent">Not yet competent</option>
          </select>
          <span className="t-sub">signed off</span>
          <input className="inp !w-auto" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
          <span className="t-sub">to</span>
          <input className="inp !w-auto" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
          {(f.cohortId || f.qualificationId || f.outcome || f.from || f.to || f.q) && <button type="button" className="btn-ghost btn-sm" onClick={() => setF({ cohortId: "", qualificationId: "", outcome: "", from: "", to: "", q: "" })}>Clear</button>}
        </div>
        {!rows ? (
          <Empty>Loading…</Empty>
        ) : rows.length === 0 ? (
          <Empty>{f.cohortId || f.qualificationId || f.outcome || f.from || f.to || f.q ? "No released results match these filters." : "No results have been signed off yet."}</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Learner</th>
                <th>Cohort</th>
                <th>Assessment</th>
                <th>Sat</th>
                <th>Result</th>
                <th>Signed off</th>
                <th>Learner told</th>
                <th>FPTStaff</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sessionId}>
                  <td>
                    <Link to={`/admin/people/${r.learnerId}`} className="font-semibold hover:underline">{r.learnerName}</Link>
                    <p className="t-sub">{r.idNumberMasked ?? r.learnerEmail}{r.studentNumber ? ` · ${r.studentNumber}` : ""}</p>
                  </td>
                  <td>{r.cohortId ? <Link to={`/admin/cohorts/${r.cohortId}`} className="lnk">{r.cohortName}</Link> : <span className="text-ink-faint">—</span>}</td>
                  <td>
                    <div className="flex items-center gap-2">
                      <TypePill type={r.qctoRegistrationType} />
                      <span>{r.qualificationTitle}</span>
                    </div>
                    <p className="t-sub">Paper {r.instrumentVersion} · <RouteBadge route={r.intakeRoute} small /></p>
                  </td>
                  <td className="whitespace-nowrap">{fmt(r.sittingStart)}</td>
                  <td>
                    {r.outcome === "competent" ? <Badge tone="green">Competent</Badge> : <Badge tone="amber">Not yet competent</Badge>}
                    {r.totalMax ? (
                      <p className="t-sub tabular">
                        {r.totalMark}/{r.totalMax} · {Math.round(((r.totalMark ?? 0) / r.totalMax) * 100)}%
                      </p>
                    ) : null}
                  </td>
                  <td>
                    <p className="whitespace-nowrap">{fmt(r.signedOffAt)}</p>
                    <p className="t-sub">{r.assessorName}</p>
                  </td>
                  <td>
                    {r.resultEmail?.status === "sent" ? (
                      <Badge tone="green">Emailed {fmt(r.resultEmail.at)}</Badge>
                    ) : r.resultEmail?.status === "not_connected" ? (
                      <span title={r.resultEmail.detail ?? ""}><Badge tone="amber">Email not connected</Badge></span>
                    ) : r.resultEmail?.status === "failed" ? (
                      <span title={r.resultEmail.detail ?? ""}><Badge tone="amber">Email failed</Badge></span>
                    ) : r.resultEmail ? (
                      <Badge tone="gray">Sending…</Badge>
                    ) : (
                      <Badge tone="gray">—</Badge>
                    )}
                    {r.resultEmail && r.resultEmail.status !== "sent" && r.resultEmail.status !== "queued" && (
                      <button type="button" className="lnk block mt-1 text-[12px]" onClick={() => resend(r)}>Send again</button>
                    )}
                  </td>
                  <td>
                    {r.pushStatus === "sent" ? (
                      <Badge tone="green">Sent {fmt(r.pushSentAt)}</Badge>
                    ) : r.pushStatus === "failed" ? (
                      <Badge tone="amber">Failed — will retry</Badge>
                    ) : (
                      <Badge tone="gray">Queued</Badge>
                    )}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <a href={`/api/sessions/${r.sessionId}/statement.pdf`} target="_blank" rel="noreferrer" className="lnk">Statement</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
