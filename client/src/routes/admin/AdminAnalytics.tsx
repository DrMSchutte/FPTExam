import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { PageHeader, Card, CardHead, Notice, Badge, Empty } from "../../components/ui";
import type { AnalyticsOverviewResponse, AnalyticsRow, ItemAnalysisResponse, Qualification } from "@shared/types";

// Block 8d: what the exams are telling us. Every figure comes from the same
// sealed record the reports are rendered from, filtered by when the exams were
// WRITTEN (the sitting date), so a window means what it says.
//
// The tables answer, in order: how did the run go (headline and funnel), where
// do the results differ (qualification / cohort / paper / venue / sitting /
// month), are the questions doing their job (item analysis), are the assessors
// marking consistently (against the AI suggestion, which is only a mirror -
// the assessor's mark is the mark), and what is the proctoring actually
// catching (finding frequency). Everything exports to CSV for Excel.

type Cut = "qualification" | "cohort" | "paper" | "venue" | "sitting" | "month";
const CUT_LABEL: Record<Cut, string> = { qualification: "Qualification", cohort: "Cohort", paper: "Paper", venue: "Venue", sitting: "Sitting", month: "Month" };
const PRESETS = [
  { key: "12m", label: "Last 12 months", from: () => { const d = new Date(); d.setMonth(d.getMonth() - 12); return d; } },
  { key: "ytd", label: "This year", from: () => new Date(new Date().getFullYear(), 0, 1) },
  { key: "90d", label: "Last 90 days", from: () => new Date(Date.now() - 90 * 86400000) },
  { key: "all", label: "Everything", from: () => new Date(2020, 0, 1) },
] as const;

const n = (v: number | null | undefined, suffix = "") => (v === null || v === undefined ? "—" : `${v}${suffix}`);
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export default function AdminAnalytics() {
  const [preset, setPreset] = useState<(typeof PRESETS)[number]["key"]>("12m");
  const [qualificationId, setQualificationId] = useState("");
  const [quals, setQuals] = useState<Qualification[]>([]);
  const [data, setData] = useState<AnalyticsOverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [cut, setCut] = useState<Cut>("paper");
  const [paperId, setPaperId] = useState("");
  const [items, setItems] = useState<ItemAnalysisResponse | null>(null);

  const query = useMemo(() => {
    const from = (PRESETS.find((p) => p.key === preset) ?? PRESETS[0]).from();
    const params = new URLSearchParams({ from: from.toISOString(), to: new Date(Date.now() + 86400000).toISOString() });
    if (qualificationId) params.set("qualificationId", qualificationId);
    return params.toString();
  }, [preset, qualificationId]);

  useEffect(() => { api.get<Qualification[]>("/qualifications").then(setQuals).catch(() => setQuals([])); }, []);
  useEffect(() => {
    setLoading(true);
    api.get<AnalyticsOverviewResponse>(`/analytics/overview?${query}`).then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [query]);
  useEffect(() => {
    if (!paperId) { setItems(null); return; }
    api.get<ItemAnalysisResponse>(`/analytics/items/${paperId}`).then(setItems).catch((e) => setError(e.message));
  }, [paperId]);

  const h = data?.headline;
  const rows: AnalyticsRow[] = data ? ({ qualification: data.byQualification, cohort: data.byCohort, paper: data.byPaper, venue: data.byVenue, sitting: data.bySitting, month: data.byMonth }[cut]) : [];

  return (
    <div>
      <PageHeader
        title="Analytics"
        subtitle="What the exams are telling us — pass rates, the questions themselves, marking consistency and what the proctoring catches."
        action={
          <div className="flex items-center gap-2">
            <select value={qualificationId} onChange={(e) => setQualificationId(e.target.value)} className="inp h-9 text-xs max-w-[16rem]">
              <option value="">All qualifications</option>
              {quals.map((q) => <option key={q.id} value={q.id}>{q.title}</option>)}
            </select>
            <select value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)} className="inp h-9 text-xs">
              {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </div>
        }
      />
      {error && <Notice kind="error">{error}</Notice>}
      {loading && !data && <Empty>Working out the figures…</Empty>}

      {h && data && (
        <>
          <p className="t-sub mb-3">Exams written between {day(data.window.from)} and {day(data.window.to)}{qualificationId ? ` · ${quals.find((q) => q.id === qualificationId)?.title ?? ""}` : ""}.</p>

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-5">
            <Tile n={h.sittings} l="sittings" sub={`${h.recordedSittings} fully recorded`} />
            <Tile n={h.submitted} l="papers written" sub={`of ${h.registered} registered`} />
            <Tile n={n(h.passRate, "%")} l="pass rate" sub={`${h.competent} competent · ${h.notYetCompetent} not yet`} tone={h.passRate !== null && h.passRate < 50 ? "amber" : "green"} />
            <Tile n={n(h.avgPercentage, "%")} l="average mark" sub={h.avgMinutesWritten ? `${h.avgMinutesWritten} min written` : undefined} />
            <Tile n={h.avgMarkHours === null ? "—" : `${h.avgMarkHours} h`} l="to mark a script" sub={h.awaitingMarking ? `${h.awaitingMarking} still waiting` : "nothing waiting"} tone={h.awaitingMarking ? "amber" : undefined} />
            <Tile n={n(h.flagRate, "%")} l="flagged for a look" sub={`${h.integrity.investigate} investigate · ${h.integrity.review} review`} tone={h.integrity.investigate ? "red" : undefined} />
          </div>

          <Card className="mb-5">
            <CardHead title="Who actually sat" subtitle="Where learners fall out between being registered for a sitting and having a released result." right={<a className="lnk text-xs" href={`/api/analytics/export/headline.csv?${query}`}>Export (CSV)</a>} />
            <div className="p-5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 text-center">
              <Step n={h.registered} l="Registered" />
              <Step n={h.checkedIn} l="Checked in" loss={h.noShows} lossLabel="never arrived" />
              <Step n={h.opened} l="Opened the paper" loss={h.didNotOpen} lossLabel="checked in, never opened" />
              <Step n={h.submitted} l="Submitted" loss={h.didNotFinish} lossLabel="opened, never submitted" />
              <Step n={h.released} l="Result released" loss={h.awaitingMarking} lossLabel="still being marked" />
            </div>
          </Card>

          <Card className="mb-5">
            <CardHead
              title="Results by…"
              subtitle="The same measures cut different ways. A pass rate is a description, not a target — read it next to the average mark and the number who sat."
              right={
                <div className="flex items-center gap-2">
                  <select value={cut} onChange={(e) => setCut(e.target.value as Cut)} className="inp h-8 text-xs">
                    {(Object.keys(CUT_LABEL) as Cut[]).map((c) => <option key={c} value={c}>{CUT_LABEL[c]}</option>)}
                  </select>
                  <a className="lnk text-xs whitespace-nowrap" href={`/api/analytics/export/${cut}.csv?${query}`}>Export (CSV)</a>
                </div>
              }
            />
            {rows.length === 0 ? <Empty>No sittings in this window.</Empty> : (
              <div className="overflow-x-auto">
                <table className="data text-sm">
                  <thead>
                    <tr>
                      <th>{CUT_LABEL[cut]}</th><th>Sat</th><th>Released</th><th>Pass rate</th><th>Average</th><th>To mark</th><th>Didn't sit / finish</th><th>Integrity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key ?? r.label}>
                        <td className="max-w-[22rem]"><p className="font-semibold truncate" title={r.label}>{r.label}</p></td>
                        <td className="tabular whitespace-nowrap">{r.submitted}<span className="text-ink-muted">/{r.registered}</span></td>
                        <td className="tabular">{r.released}{r.awaitingMarking > 0 && <span className="t-sub"> · {r.awaitingMarking} waiting</span>}</td>
                        <td className="tabular">{r.passRate === null ? <span className="text-ink-faint">—</span> : <Badge tone={r.passRate >= 70 ? "green" : r.passRate >= 50 ? "blue" : "amber"}>{r.passRate}%</Badge>}</td>
                        <td className="tabular">{n(r.avgPercentage, "%")}</td>
                        <td className="tabular whitespace-nowrap">{r.avgMarkHours === null ? "—" : `${r.avgMarkHours} h`}</td>
                        <td className="text-xs whitespace-nowrap">{r.noShows + r.didNotOpen + r.didNotFinish === 0 ? <span className="text-ink-faint">—</span> : <>{r.noShows ? `${r.noShows} no-show ` : ""}{r.didNotOpen ? `${r.didNotOpen} never opened ` : ""}{r.didNotFinish ? `${r.didNotFinish} unfinished` : ""}</>}</td>
                        <td className="text-xs whitespace-nowrap">
                          {r.integrity.investigate > 0 && <Badge tone="red">{r.integrity.investigate}</Badge>}{" "}
                          {r.integrity.review > 0 && <Badge tone="amber">{r.integrity.review}</Badge>}{" "}
                          {r.integrity.clear > 0 && <Badge tone="green">{r.integrity.clear}</Badge>}
                          {r.flagRate === null && <span className="text-ink-faint">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="mb-5">
            <CardHead
              title="Are the questions doing their job?"
              subtitle="Facility is the share of available marks learners earned. Discrimination compares the strongest third of the cohort with the weakest — at or below zero, the question disagrees with the rest of the paper."
              right={
                <div className="flex items-center gap-2">
                  <select value={paperId} onChange={(e) => setPaperId(e.target.value)} className="inp h-8 text-xs max-w-[20rem]">
                    <option value="">Choose a paper…</option>
                    {data.papers.map((p) => <option key={p.id} value={p.id}>{p.qualificationTitle} · {p.version} ({p.sat} sat)</option>)}
                  </select>
                  {paperId && <a className="lnk text-xs whitespace-nowrap" href={`/api/analytics/items/${paperId}/export.csv`}>Export (CSV)</a>}
                </div>
              }
            />
            {!paperId ? <Empty>Pick a paper to see every question in it.</Empty> : !items ? <Empty>Working through the scripts…</Empty> : (
              <>
                <p className="px-5 pt-4 t-sub">{items.note} {items.avgPercentage !== null && <>Average for this paper: <span className="font-semibold">{items.avgPercentage}%</span> of {items.instrument.totalMarks} marks.</>} <Link className="lnk" to={`/admin/assessments/${items.instrument.id}`}>Open the paper</Link></p>
                <div className="overflow-x-auto mt-3">
                  <table className="data text-sm">
                    <thead>
                      <tr><th>#</th><th>Question</th><th>Marks</th><th>Average</th><th>Facility</th><th>Discrimination</th><th>Zero / full / blank</th><th>Worth a look</th></tr>
                    </thead>
                    <tbody>
                      {items.items.map((i) => (
                        <tr key={i.questionId}>
                          <td className="tabular">{i.index}</td>
                          <td className="max-w-[26rem]">
                            <p className="truncate" title={i.prompt}>{i.prompt}</p>
                            <p className="t-sub">{i.type.replace(/_/g, " ")}{i.bloomLevel ? ` · ${i.bloomLevel}` : ""}{i.eloRef ? ` · ${i.eloRef}` : ""}{i.acRef ? ` · ${i.acRef}` : ""}</p>
                          </td>
                          <td className="tabular">{i.maxMark}</td>
                          <td className="tabular">{n(i.avgMark)}</td>
                          <td className="tabular">{i.facility === null ? "—" : <Badge tone={i.facility >= 90 ? "amber" : i.facility <= 30 ? "amber" : "green"}>{i.facility}%</Badge>}</td>
                          <td className="tabular">{i.discrimination === null ? "—" : <Badge tone={i.discrimination <= 0 ? "red" : i.discrimination < 20 ? "amber" : "green"}>{i.discrimination}</Badge>}</td>
                          <td className="tabular whitespace-nowrap text-xs">{i.zeroes} / {i.fullMarks} / {i.blank}</td>
                          <td className="text-xs">{i.flags.length === 0 ? <span className="text-ink-faint">—</span> : <ul className="space-y-0.5">{i.flags.map((f, k) => <li key={k}>{f}</li>)}</ul>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Card>

          <Card className="mb-5">
            <CardHead
              title="Marking consistency"
              subtitle="How each assessor's marks sat against the AI's suggestion. The assessor's mark is the mark — this is here to show an assessor who accepts everything unchanged, one who overrides everything, and a paper whose memo the AI reads badly."
              right={<a className="lnk text-xs" href={`/api/analytics/export/assessors.csv?${query}`}>Export (CSV)</a>}
            />
            {data.assessors.length === 0 ? <Empty>No results signed off in this window.</Empty> : (
              <div className="overflow-x-auto">
                <table className="data text-sm">
                  <thead>
                    <tr><th>Assessor</th><th>Signed off</th><th>Time to mark</th><th>Average awarded</th><th>Pass rate</th><th>Accepted the AI unchanged</th><th>Typical difference</th><th>Above / below</th><th>Outcome differed</th></tr>
                  </thead>
                  <tbody>
                    {data.assessors.map((a) => (
                      <tr key={a.assessorId}>
                        <td className="font-semibold">{a.name}</td>
                        <td className="tabular">{a.signedOff}</td>
                        <td className="tabular whitespace-nowrap">{a.avgTurnaroundHours === null ? "—" : `${a.avgTurnaroundHours} h`}</td>
                        <td className="tabular">{n(a.avgPercentage, "%")}</td>
                        <td className="tabular">{n(a.passRate, "%")}</td>
                        <td className="tabular">{a.questionsCompared === 0 ? <span className="text-ink-faint">no comparison yet</span> : <><Badge tone={a.acceptedUnchanged !== null && a.acceptedUnchanged >= 98 ? "amber" : "green"}>{a.acceptedUnchanged}%</Badge> <span className="t-sub">of {a.questionsCompared}</span></>}</td>
                        <td className="tabular whitespace-nowrap">{a.meanAbsDiffMarks === null ? "—" : <>{a.meanAbsDiffMarks} marks <span className="t-sub">({a.meanAbsDiffPct}%)</span></>}</td>
                        <td className="tabular whitespace-nowrap text-xs">{a.markedAbove} / {a.markedBelow}</td>
                        <td className="tabular">{a.outcomeDiffered}{a.overrides ? <span className="t-sub"> · {a.overrides} overridden</span> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <CardHead
              title="What the proctoring caught"
              subtitle="How often each integrity finding came up. A rule that fires on everyone, or never fires, is worth questioning."
              right={<a className="lnk text-xs" href={`/api/analytics/export/findings.csv?${query}`}>Export (CSV)</a>}
            />
            {data.findings.length === 0 ? <Empty>No integrity reports in this window.</Empty> : (
              <table className="data text-sm">
                <thead><tr><th>Finding</th><th>Severity</th><th>Scripts</th><th>Share of scripts with a report</th></tr></thead>
                <tbody>
                  {data.findings.map((f) => {
                    const total = h.integrity.clear + h.integrity.review + h.integrity.investigate;
                    return (
                      <tr key={f.code}>
                        <td><p className="font-semibold">{f.title}</p><p className="t-sub">{f.code}</p></td>
                        <td><Badge tone={f.severity === "high" ? "red" : f.severity === "medium" ? "amber" : f.severity === "low" ? "blue" : "gray"}>{f.severity}</Badge></td>
                        <td className="tabular">{f.sessions}</td>
                        <td className="tabular">{total ? `${Math.round((f.sessions / total) * 1000) / 10}%` : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function Tile({ n: value, l, sub, tone }: { n: number | string; l: string; sub?: string; tone?: "green" | "amber" | "red" }) {
  const colour = tone === "red" ? "text-red-700" : tone === "amber" ? "text-amber-700" : tone === "green" ? "text-brand-700" : "";
  return (
    <div className="card p-4">
      <p className={"font-display text-2xl font-extrabold tabular " + colour}>{value}</p>
      <p className="text-xs font-semibold text-ink-muted">{l}</p>
      {sub && <p className="t-sub mt-0.5 leading-tight">{sub}</p>}
    </div>
  );
}

function Step({ n: value, l, loss, lossLabel }: { n: number; l: string; loss?: number; lossLabel?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <p className="font-display text-xl font-extrabold tabular">{value}</p>
      <p className="text-xs font-semibold text-ink-muted">{l}</p>
      {loss !== undefined && loss > 0 && <p className="t-sub mt-1 text-amber-700">−{loss} {lossLabel}</p>}
    </div>
  );
}
