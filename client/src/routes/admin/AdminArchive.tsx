import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { PageHeader, Card, CardHead, Notice, Badge, Empty } from "../../components/ui";
import type { ArchiveRow, SittingRegisterResponse, RegisterLearner } from "@shared/types";

// Block 8c: the evidence archive - the register of every sitting that has run
// and what the record holds for it. This is where the reports live once an
// exam has been written, marked and released: the Portfolio of Evidence for the
// governing body (one ZIP per sitting), the sitting register, the paper's
// alignment matrix, and per learner the evidence pack, Statement of Results,
// captures and recording. Nothing is copied into a folder somewhere - every
// report is produced from the sealed record when it is asked for, so it always
// matches what was written and signed off. Every download is audited.

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "—");
const fmtDT = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const mb = (n: number) => (n >= 1024 * 1024 * 1024 ? `${(n / 1024 / 1024 / 1024).toFixed(1)} GB` : n >= 1024 * 1024 ? `${Math.round(n / 1024 / 1024)} MB` : `${Math.round(n / 1024)} KB`);
const REC_TONE = { clear: "green", review: "amber", investigate: "red" } as const;

type Filter = "all" | "complete" | "marking" | "recorded";

export default function AdminArchive() {
  const [rows, setRows] = useState<ArchiveRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");

  useEffect(() => { api.get<ArchiveRow[]>("/sittings/archive").then(setRows).catch((e) => setError(e.message)); }, []);

  const shown = (rows ?? []).filter((r) => {
    if (filter === "complete" && !r.complete) return false;
    if (filter === "marking" && r.marking === 0) return false;
    if (filter === "recorded" && !r.fullRecording) return false;
    if (q) { const s = `${r.name ?? ""} ${r.qualificationTitle} ${r.paper} ${r.venue ?? ""} ${r.cohort ?? ""} ${r.assessor}`.toLowerCase(); if (!s.includes(q.toLowerCase())) return false; }
    return true;
  });
  const totals = (rows ?? []).reduce((t, r) => ({ sittings: t.sittings + 1, learners: t.learners + r.learners, released: t.released + r.released, bytes: t.bytes + r.stills.bytes + r.recording.bytes }), { sittings: 0, learners: 0, released: 0, bytes: 0 });

  return (
    <div>
      <PageHeader title="Evidence archive" subtitle="Every sitting that has run, and everything the record holds for it — the portfolio of evidence for QCTO, the SETA, moderators and verifiers." />
      {error && <Notice kind="error">{error}</Notice>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <Stat n={totals.sittings} l="sittings on record" />
        <Stat n={totals.learners} l="learner sittings" />
        <Stat n={totals.released} l="results released" />
        <Stat n={mb(totals.bytes)} l="of captures and recordings held" />
      </div>

      <Card>
        <CardHead
          title="Sittings"
          subtitle="Newest first. Open a sitting to reach each learner's evidence pack, statement, captures and recording."
          right={
            <div className="flex items-center gap-2 flex-wrap">
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="inp h-8 text-xs w-40" />
              <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} className="inp h-8 text-xs">
                <option value="all">All sittings</option>
                <option value="complete">Complete (every result released)</option>
                <option value="marking">Still being marked</option>
                <option value="recorded">Fully recorded</option>
              </select>
            </div>
          }
        />
        {rows === null ? <Empty>Loading…</Empty> : shown.length === 0 ? <Empty>{rows.length === 0 ? "No sitting has closed yet. Sittings appear here once their time window has passed." : "Nothing matches."}</Empty> : (
          <div className="overflow-x-auto">
            <table className="data table-fixed">
              <colgroup><col className="w-[19%]" /><col className="w-[20%]" /><col className="w-[15%]" /><col className="w-[14%]" /><col className="w-[16%]" /><col className="w-[16%]" /></colgroup>
              <thead>
                <tr>
                  <th>Sitting</th><th>Assessment</th><th>Learners &amp; results</th><th>Integrity</th><th>Evidence held</th><th>Portfolio of Evidence</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <ArchiveLine key={r.id} r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="t-sub mt-4 max-w-3xl">
        Reports are rendered from the sealed record at the moment you download them, so there is no separate copy that can drift from what was written and signed off. Statements, evidence-pack records, marks and the audit trail are kept permanently; captures and recordings are deleted 12 months after the sitting unless the sitting is placed on hold. Every download is written to the audit trail with your name.
      </p>
    </div>
  );
}

function Stat({ n, l }: { n: number | string; l: string }) {
  return (
    <div className="card p-4">
      <p className="font-display text-2xl font-extrabold tabular">{n}</p>
      <p className="text-xs text-ink-muted">{l}</p>
    </div>
  );
}

function ArchiveLine({ r, open, onToggle }: { r: ArchiveRow; open: boolean; onToggle: () => void }) {
  const [reg, setReg] = useState<SittingRegisterResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open && !reg) api.get<SittingRegisterResponse>(`/sittings/${r.id}/register`).then(setReg).catch((e) => setErr(e.message)); }, [open, reg, r.id]);
  return (
    <>
      <tr className={"cursor-pointer " + (open ? "bg-surface-2" : "")} onClick={onToggle}>
        <td>
          <p className="font-semibold">{r.name ?? `${r.qualificationTitle} · ${r.paper}`}</p>
          <p className="t-sub">{fmtDay(r.startTime)} · {fmtTime(r.startTime)}–{fmtTime(r.endTime)}{r.venue ? ` · ${r.venue}` : ""}{r.cohort ? ` · ${r.cohort}` : ""}</p>
        </td>
        <td>
          <p className="text-sm truncate" title={r.qualificationTitle}>{r.qualificationTitle}</p>
          <p className="t-sub truncate">Paper {r.paper} · {r.assessor}</p>
        </td>
        <td>
          <p className="tabular text-sm whitespace-nowrap">{r.submitted}<span className="text-ink-muted">/{r.learners}</span> <span className="t-sub">sat</span></p>
          <p className="mt-1">{r.complete ? <Badge tone="green">Complete · {r.competent} competent</Badge> : r.released > 0 ? <Badge tone="blue">{r.released} released · {r.marking} marking</Badge> : r.submitted > 0 ? <Badge tone="amber">{r.marking} being marked</Badge> : <Badge tone="gray">No scripts</Badge>}</p>
        </td>
        <td className="text-xs">
          {r.integrity.investigate > 0 && <Badge tone="red">{r.integrity.investigate} investigate</Badge>}{" "}
          {r.integrity.review > 0 && <Badge tone="amber">{r.integrity.review} review</Badge>}{" "}
          {r.integrity.clear > 0 && <Badge tone="green">{r.integrity.clear} clear</Badge>}
          {r.integrity.clear + r.integrity.review + r.integrity.investigate === 0 && <span className="text-ink-faint">—</span>}
        </td>
        <td className="text-xs">
          <p className="whitespace-nowrap">{r.fullRecording ? "Full recording" : "Stills"} · {mb(r.stills.bytes + r.recording.bytes)}</p>
          <p className="t-sub">{r.stills.n} stills{r.fullRecording ? ` · ${r.recording.n} min video` : ""}</p>
          <p className="t-sub">Kept until {fmtDay(r.retentionUntil)}</p>
        </td>
        <td onClick={(e) => e.stopPropagation()}>
          <div className="flex flex-col gap-1 text-xs">
            <a className="btn btn-sm whitespace-nowrap self-start" href={`/api/sittings/${r.id}/portfolio.zip`}>Download (ZIP)</a>
            {r.fullRecording && r.recording.n > 0 && <a className="lnk" href={`/api/sittings/${r.id}/portfolio.zip?video=1`}>…with video ({mb(r.recording.bytes)})</a>}
            {r.portfolioDownloads > 0 && <span className="t-sub">Taken {r.portfolioDownloads}× · last {fmtDT(r.portfolioLastDownloadedAt)}</span>}
          </div>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} className="bg-surface-2/60 p-0">
            <div className="px-4 py-4 space-y-4">
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <span className="font-semibold text-ink-muted uppercase tracking-wide text-[11px]">Sitting reports</span>
                <a className="lnk" href={`/api/sittings/${r.id}/register.pdf`} target="_blank" rel="noreferrer">Sitting register (PDF)</a>
                <a className="lnk" href={`/api/instruments/${r.instrumentId}/alignment.pdf`} target="_blank" rel="noreferrer">Alignment matrix of the paper (PDF)</a>
                <Link className="lnk" to={`/admin/sittings/${r.id}/console`}>Console (as it was)</Link>
                <Link className="lnk" to={`/admin/assessments/${r.instrumentId}`}>The paper</Link>
              </div>
              {err && <Notice kind="error">{err}</Notice>}
              {!reg && !err && <p className="t-sub">Loading learners…</p>}
              {reg && <LearnerTable sittingId={r.id} learners={reg.learners} fullRecording={r.fullRecording} />}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function LearnerTable({ sittingId, learners, fullRecording }: { sittingId: string; learners: RegisterLearner[]; fullRecording: boolean }) {
  if (!learners.length) return <Empty>No learners were on this sitting.</Empty>;
  return (
    <table className="data text-xs">
      <thead>
        <tr><th>Learner</th><th>Sat</th><th>Integrity</th><th>Result</th><th>Evidence &amp; reports</th></tr>
      </thead>
      <tbody>
        {learners.map((l) => (
          <tr key={l.sessionId}>
            <td>
              <p className="font-semibold">{l.name}</p>
              <p className="t-sub">{l.idNumberMasked ?? "no ID"}{l.studentNumber ? ` · ${l.studentNumber}` : ""} · pack {l.packNumber}</p>
            </td>
            <td className="whitespace-nowrap">{l.submittedAt ? <>Submitted {fmtTime(l.submittedAt)}{l.extraMinutes ? <span className="t-sub"> (+{l.extraMinutes} min)</span> : null}</> : l.status === "scheduled" ? <span className="text-ink-faint">Did not sit</span> : <span className="text-amber-700">{l.status.replace(/_/g, " ")}</span>}</td>
            <td>{l.integrity ? <><Badge tone={REC_TONE[l.integrity.recommendation]}>{l.integrity.recommendation}</Badge>{l.integrity.high > 0 && <span className="t-sub"> · {l.integrity.high} high</span>}</> : <span className="text-ink-faint">—</span>}</td>
            <td className="whitespace-nowrap">
              {l.result ? <><Badge tone={l.result.outcome === "competent" ? "green" : "amber"}>{l.result.outcome === "competent" ? "Competent" : "Not yet competent"}</Badge> <span className="tabular">{l.result.totalMark}/{l.result.totalMax}</span></> : l.marking === "in_progress" ? <Badge tone="blue">Being marked</Badge> : l.marking === "waiting" ? <Badge tone="amber">Awaiting marking</Badge> : <span className="text-ink-faint">—</span>}
            </td>
            <td>
              <p className="whitespace-nowrap t-sub mb-1">{l.stills.n} stills{fullRecording ? ` · ${l.recording.n} min video` : ""} · {mb(l.stills.bytes + l.recording.bytes)}</p>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                <a className="lnk" href={`/api/sittings/${sittingId}/learners/${l.learnerId}/evidence-pack.pdf`} target="_blank" rel="noreferrer">Evidence pack (PDF)</a>
                <a className="lnk" href={`/api/sittings/${sittingId}/learners/${l.learnerId}/evidence-pack.zip`}>Files (ZIP)</a>
                {fullRecording && l.recording.n > 0 && <a className="lnk" href={`/api/sittings/${sittingId}/learners/${l.learnerId}/evidence-pack.zip?video=1`}>…with video</a>}
                {l.result && <a className="lnk" href={`/api/sessions/${l.sessionId}/statement.pdf`} target="_blank" rel="noreferrer">Statement of Results</a>}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
