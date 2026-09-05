import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import type { AssessorQueueItem } from "@shared/types";
import { PageHeader, Card, CardHead, Notice, Badge, Pill, Empty } from "../../components/ui";

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

function AiStatus({ s }: { s: AssessorQueueItem["aiReviewStatus"] }) {
  if (s === "done") return <Badge tone="green">AI review ready</Badge>;
  if (s === "failed") return <Badge tone="amber">AI review failed</Badge>;
  if (s === "none") return <Badge tone="gray">No AI review</Badge>;
  return <Badge tone="blue">AI reviewing…</Badge>;
}

function Progress({ item }: { item: AssessorQueueItem }) {
  if (item.decisionState === "signed_off") {
    return item.outcome === "competent" ? <Badge tone="green">Competent</Badge> : <Badge tone="amber">Not yet competent</Badge>;
  }
  if (item.decisionState === "draft") return <Badge tone="blue">Marking in progress</Badge>;
  return <Badge tone="gray">Not started</Badge>;
}

export default function AssessorQueue({ mode }: { mode: "open" | "signed" }) {
  const [items, setItems] = useState<AssessorQueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get<AssessorQueueItem[]>("/assessor/queue")
        .then((list) => alive && setItems(list))
        .catch((err) => alive && setError((err as Error).message));
    load();
    // The AI review lands in the background; refresh the list while any are running.
    const t = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [mode]);

  const rows = (items ?? []).filter((i) => (mode === "signed" ? i.decisionState === "signed_off" : i.decisionState !== "signed_off"));
  const open = (items ?? []).filter((i) => i.decisionState !== "signed_off").length;
  const done = (items ?? []).length - open;

  return (
    <>
      <PageHeader
        title={mode === "signed" ? "Signed off" : "Marking queue"}
        subtitle={
          mode === "signed"
            ? "Results you have released. Sign-off is final; each has been queued for FPTStaff."
            : "Submitted scripts on sittings where you are the Assessor of record. The AI review is a suggestion - your marks are the result."
        }
      />
      {error && <Notice kind="error">{error}</Notice>}

      <div className="grid grid-cols-3 gap-4 mb-6">
        <Card className="p-5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Awaiting your marks</p>
          <p className="font-display text-3xl font-extrabold mt-1 tabular">{items ? open : "—"}</p>
        </Card>
        <Card className="p-5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Signed off</p>
          <p className="font-display text-3xl font-extrabold mt-1 tabular">{items ? done : "—"}</p>
        </Card>
        <Card className="p-5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">AI reviews ready</p>
          <p className="font-display text-3xl font-extrabold mt-1 tabular">
            {items ? items.filter((i) => i.aiReviewStatus === "done" && i.decisionState !== "signed_off").length : "—"}
          </p>
        </Card>
      </div>

      <Card>
        <CardHead title={mode === "signed" ? "Released results" : "Scripts to mark"} subtitle={`${rows.length} script${rows.length === 1 ? "" : "s"}`} />
        {rows.length === 0 ? (
          <Empty>{mode === "signed" ? "Nothing signed off yet." : "No submitted scripts waiting for you."}</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Learner</th>
                <th>Qualification</th>
                <th>Submitted</th>
                <th>AI review</th>
                <th>{mode === "signed" ? "Outcome" : "Progress"}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sessionId}>
                  <td>
                    <p className="font-semibold">{r.learnerName}</p>
                    <p className="t-sub">{r.learnerEmail}</p>
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <Pill tone={r.qctoRegistrationType}>{r.qctoRegistrationType.toUpperCase()}</Pill>
                      <span>{r.qualificationTitle}</span>
                    </div>
                    <p className="t-sub">Paper {r.instrumentVersion}</p>
                  </td>
                  <td className="whitespace-nowrap">{fmt(r.submissionTime)}</td>
                  <td>
                    <AiStatus s={r.aiReviewStatus} />
                  </td>
                  <td>
                    <Progress item={r} />
                    {r.decisionState === "signed_off" && r.totalMax ? (
                      <p className="t-sub tabular">
                        {r.totalMark}/{r.totalMax} · {Math.round(((r.totalMark ?? 0) / r.totalMax) * 100)}%
                      </p>
                    ) : null}
                  </td>
                  <td className="text-right">
                    <Link to={`/assessor/sessions/${r.sessionId}`} className={r.decisionState === "signed_off" ? "lnk" : "btn btn-sm"}>
                      {r.decisionState === "signed_off" ? "View" : r.decisionState === "draft" ? "Continue marking" : "Mark"}
                    </Link>
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
