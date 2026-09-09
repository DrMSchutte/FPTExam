import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import type { WorkloadRow } from "@shared/types";
import { Card, CardHead, Badge, Empty } from "../../components/ui";
import { StatusBadge } from "./AdminUsers";

// Marking workload board (Block 3): every assessor's scripts waiting, in flight
// against their cap, overdue scripts, throughput and turnaround.

export default function MarkingWorkload() {
  const [data, setData] = useState<{ overdueAfterDays: number; assessors: WorkloadRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.get<typeof data>("/sittings/workload").then(setData).catch((e) => setError((e as Error).message)); }, []);

  const rows = data?.assessors ?? [];
  const totals = rows.reduce((t, r) => ({ waiting: t.waiting + r.waiting, overdue: t.overdue + r.overdue, inFlight: t.inFlight + r.inFlight, cap: t.cap + r.cap }), { waiting: 0, overdue: 0, inFlight: 0, cap: 0 });
  const sorted = [...rows].sort((a, b) => b.overdue - a.overdue || b.waiting - a.waiting || a.name.localeCompare(b.name));

  return (
    <Card>
      <CardHead
        title="Marking workload"
        subtitle={data ? `${totals.waiting} scripts waiting to be marked · ${totals.overdue} overdue (older than ${data.overdueAfterDays} days) · ${totals.inFlight} of ${totals.cap} marking seats in use across ${rows.length} assessors` : "Loading…"}
      />
      {error && <p className="text-red-700 text-sm px-5 py-3">{error}</p>}
      <div className="px-2 pb-2">
        {data && rows.length === 0 ? (
          <Empty>No assessors registered yet.</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Assessor</th>
                <th>Scope</th>
                <th className="text-right">Waiting</th>
                <th className="text-right">Overdue</th>
                <th>In flight / cap</th>
                <th className="text-right">Signed off (30 d)</th>
                <th className="text-right">Avg turnaround</th>
                <th className="text-right">Upcoming sittings</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const pct = Math.min(100, Math.round((r.inFlight / Math.max(1, r.cap)) * 100));
                return (
                  <tr key={r.id}>
                    <td>
                      <div className="font-semibold">{r.name}</div>
                      {r.status !== "active" && <StatusBadge status={r.status} />}
                    </td>
                    <td className="text-ink-muted text-[12.5px] max-w-[260px]">{r.scope.length ? r.scope.join(", ") : <span className="text-amber-700">not recorded</span>}</td>
                    <td className="text-right tabular">{r.waiting}</td>
                    <td className="text-right tabular">{r.overdue ? <Badge tone="amber">{r.overdue}</Badge> : <span className="text-ink-faint">0</span>}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-28 rounded-full bg-surface-2 overflow-hidden"><div className={"h-full " + (pct >= 100 ? "bg-amber-500" : "bg-brand-500")} style={{ width: `${pct}%` }} /></div>
                        <span className="tabular text-[12.5px]">{r.inFlight} / {r.cap}</span>
                      </div>
                    </td>
                    <td className="text-right tabular">{r.signedOff30d}</td>
                    <td className="text-right tabular">{r.avgTurnaroundHours == null ? <span className="text-ink-faint">—</span> : r.avgTurnaroundHours < 48 ? `${r.avgTurnaroundHours} h` : `${Math.round(r.avgTurnaroundHours / 24)} d`}</td>
                    <td className="text-right tabular">{r.upcomingSittings}</td>
                    <td className="text-right"><Link to={`/admin/people/${r.id}`} className="lnk">Open</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}
