import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { PageHeader, Card, Badge, Notice } from "../../components/ui";
import type { MySittingRow } from "@shared/types";

// Block 5c: the sittings this person is on - live ones first, then today's
// and upcoming, then those that have ended (kept for a day). Refreshes every
// 30 s so the counts move without a reload.

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short" });
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });
const PHASE: Record<MySittingRow["phase"], { label: string; tone: "green" | "blue" | "teal" | "amber" | "gray" }> = {
  live: { label: "Live now", tone: "blue" },
  check_in: { label: "Check-in open", tone: "teal" },
  upcoming: { label: "Upcoming", tone: "gray" },
  ended: { label: "Ended", tone: "green" },
};

export default function MySittings({ consolePath, title = "My sittings", subtitle }: { consolePath: (id: string) => string; title?: string; subtitle?: string }) {
  const [rows, setRows] = useState<MySittingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = () => api.get<MySittingRow[]>("/sittings/mine").then((r) => { setRows(r); setError(null); }).catch((e) => setError((e as Error).message));
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);
  const order: MySittingRow["phase"][] = ["live", "check_in", "upcoming", "ended"];
  const sorted = (rows ?? []).slice().sort((a, b) => order.indexOf(a.phase) - order.indexOf(b.phase) || a.startTime.localeCompare(b.startTime));
  return (
    <>
      <PageHeader title={title} subtitle={subtitle ?? "Open a sitting to watch the room, release locked papers, message learners and record what you see."} />
      {error && <Notice kind="error">{error}</Notice>}
      {rows && rows.length === 0 && <Card className="p-8 text-center text-sm text-ink-muted">You are not on any sitting today or coming up. The Administrator assigns invigilators when a sitting is scheduled.</Card>}
      {sorted.length > 0 && (
        <Card>
          <table className="data">
            <thead><tr><th>Sitting</th><th>When</th><th>Where</th><th>Roster</th><th>Right now</th><th></th></tr></thead>
            <tbody>
              {sorted.map((s) => (
                <tr key={s.id} className={s.phase === "live" ? "bg-blue-50/40" : ""}>
                  <td>
                    <div className="font-semibold">{s.name}</div>
                    <div className="t-sub">{s.qualificationTitle} · Paper {s.paper} · {s.minutes} min</div>
                  </td>
                  <td className="whitespace-nowrap"><div>{fmtDay(s.startTime)}</div><div className="t-sub">{hhmm(s.startTime)}–{hhmm(s.endTime)}</div></td>
                  <td className="text-ink-muted">{s.venue ?? "—"}</td>
                  <td className="tabular">{s.learners}<span className="t-sub"> · {s.invigilators} invigilator{s.invigilators === 1 ? "" : "s"}</span></td>
                  <td>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge tone={PHASE[s.phase].tone}>{PHASE[s.phase].label}</Badge>
                      {s.phase !== "upcoming" && <span className="t-sub">{s.checkedIn} checked in · {s.writing} writing{s.locked ? <span className="text-amber-700 font-semibold"> · {s.locked} locked</span> : ""} · {s.submitted} submitted</span>}
                    </div>
                  </td>
                  <td className="text-right whitespace-nowrap"><Link to={consolePath(s.id)} className={s.phase === "live" || s.phase === "check_in" ? "btn btn-sm" : "btn-ghost btn-sm"}>{s.phase === "ended" ? "Review" : "Open console"}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
