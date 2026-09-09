import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import type { CalendarSitting } from "@shared/types";
import { Card, Empty } from "../../components/ui";

// Month view of sittings. Each day lists its sittings with students and the
// invigilator count against the 1:30 rule; a sitting short of invigilators is
// marked so it can be fixed before the day.

const monthLabel = (d: Date) => d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export default function SittingsCalendar({ onOpen }: { onOpen: (sittingId: string) => void }) {
  const [month, setMonth] = useState(() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; });
  const [rows, setRows] = useState<CalendarSitting[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const from = new Date(month);
    const to = new Date(month.getFullYear(), month.getMonth() + 1, 1);
    // Include the leading/trailing days shown in the grid.
    from.setDate(from.getDate() - ((from.getDay() + 6) % 7));
    to.setDate(to.getDate() + (7 - ((to.getDay() + 6) % 7)) % 7);
    api.get<CalendarSitting[]>(`/sittings/calendar?from=${from.toISOString()}&to=${to.toISOString()}`).then(setRows).catch((e) => setError((e as Error).message));
  }, [month]);

  const first = new Date(month);
  const gridStart = new Date(first); gridStart.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) { const d = new Date(gridStart); d.setDate(gridStart.getDate() + i); days.push(d); }
  const weeks = days.filter((d, i) => i < 35 || days.slice(35).some((x) => x.getMonth() === month.getMonth())).length / 7;
  const byDay = new Map<string, CalendarSitting[]>();
  for (const r of rows ?? []) { const k = dayKey(new Date(r.startTime)); byDay.set(k, [...(byDay.get(k) ?? []), r]); }
  const today = dayKey(new Date());
  const inMonth = (rows ?? []).filter((r) => new Date(r.startTime).getMonth() === month.getMonth());
  const short = inMonth.filter((r) => r.invigilators < r.invigilatorsNeeded);

  return (
    <Card>
      <div className="px-5 pt-4 pb-3 flex items-center gap-3 border-b border-line">
        <button type="button" className="btn-ghost btn-sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>←</button>
        <div className="font-display font-semibold text-[15px] w-44 text-center">{monthLabel(month)}</div>
        <button type="button" className="btn-ghost btn-sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>→</button>
        <button type="button" className="btn-ghost btn-sm" onClick={() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); setMonth(d); }}>Today</button>
        <span className="flex-1" />
        <span className="t-sub">
          {inMonth.length} sitting{inMonth.length === 1 ? "" : "s"} · {inMonth.reduce((s, r) => s + r.learners, 0).toLocaleString()} students
          {short.length ? <span className="text-amber-700"> · {short.length} short of invigilators</span> : ""}
        </span>
      </div>
      {error && <p className="text-red-700 text-sm px-5 py-3">{error}</p>}
      <div className="p-3">
        <div className="grid grid-cols-7 text-[11px] font-semibold uppercase tracking-wide text-ink-muted px-1 pb-1">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="px-1">{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-px bg-line rounded-lg overflow-hidden border border-line">
          {days.slice(0, weeks * 7).map((d) => {
            const k = dayKey(d);
            const list = byDay.get(k) ?? [];
            const other = d.getMonth() !== month.getMonth();
            return (
              <div key={k} className={"min-h-[104px] bg-surface p-1.5 " + (other ? "opacity-50" : "")}>
                <div className={"text-[12px] tabular mb-1 " + (k === today ? "inline-block rounded-full bg-brand-600 text-white px-1.5" : "text-ink-muted")}>{d.getDate()}</div>
                <div className="space-y-1">
                  {list.map((r) => {
                    const shortInv = r.invigilators < r.invigilatorsNeeded;
                    return (
                      <button key={r.id} type="button" onClick={() => onOpen(r.id)} title={`${r.name ?? r.qualificationTitle}\n${r.learners} students · ${r.invigilators}/${r.invigilatorsNeeded} invigilators · ${r.assessorName}`}
                        className={"block w-full text-left rounded px-1.5 py-1 text-[11.5px] leading-tight border " + (shortInv ? "bg-amber-50 border-amber-200 text-amber-900" : "bg-brand-50 border-brand-100 text-brand-900 hover:bg-brand-100")}>
                        <div className="font-semibold truncate">{hhmm(r.startTime)} {r.name ?? r.qualificationTitle}</div>
                        <div className="truncate text-[11px] opacity-80">{r.learners} students{r.venue ? ` · ${r.venue}` : ""}{shortInv ? ` · ${r.invigilators}/${r.invigilatorsNeeded} inv.` : ""}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        {rows && rows.length === 0 && <Empty>No sittings this month. <Link to="/admin/sittings" className="lnk">Schedule one</Link>.</Empty>}
      </div>
    </Card>
  );
}
