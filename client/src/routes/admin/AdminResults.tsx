import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { PageHeader, Card, CardHead, Notice, Badge, TypePill, Empty } from "../../components/ui";
import type { IntakeRoute } from "@shared/types";
import { RouteBadge } from "../../components/intake";

interface ResultRow {
  sessionId: string;
  learnerName: string;
  learnerEmail: string;
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
}

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

// Administrator's read-only view of released results and whether each has
// reached FPTStaff (where moderation and verification run). Nothing here can
// change a result: sign-off is the assessor's and is final.
export default function AdminResults() {
  const [rows, setRows] = useState<ResultRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<ResultRow[]>("/assessments/results")
      .then(setRows)
      .catch((err) => setError((err as Error).message));
  }, []);

  const competent = rows?.filter((r) => r.outcome === "competent").length ?? 0;
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
        <CardHead title="Released results" subtitle="Most recent first" />
        {!rows ? (
          <Empty>Loading…</Empty>
        ) : rows.length === 0 ? (
          <Empty>No results have been signed off yet.</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Learner</th>
                <th>Assessment</th>
                <th>Sat</th>
                <th>Result</th>
                <th>Signed off</th>
                <th>FPTStaff</th>
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
                    {r.pushStatus === "sent" ? (
                      <Badge tone="green">Sent {fmt(r.pushSentAt)}</Badge>
                    ) : r.pushStatus === "failed" ? (
                      <Badge tone="amber">Failed — will retry</Badge>
                    ) : (
                      <Badge tone="gray">Queued</Badge>
                    )}
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
