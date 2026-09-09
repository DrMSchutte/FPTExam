import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../lib/api";

// Block 5a: the print-out of sitting codes for one sitting - one line per
// learner, handed out in the room (or read out to the learner on the phone
// after an identity check). Viewing it is audited on the server.

interface CodesResponse {
  sitting: { id: string; name: string | null; venue: string | null; startTime: string; endTime: string; qualificationTitle: string };
  rows: { sessionId: string; name: string; idNumberLast4: string | null; studentNumber: string | null; code: string | null; entries: number; status: string }[];
}

export default function SittingCodesPrint() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<CodesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slips, setSlips] = useState(false);
  useEffect(() => { api.get<CodesResponse>(`/sittings/${id}/codes`).then(setData).catch((e) => setError((e as Error).message)); }, [id]);

  if (error) return <div className="p-8 text-sm text-red-700">{error}</div>;
  if (!data) return <div className="p-8 text-sm text-ink-muted">Loading…</div>;
  const s = data.sitting;
  const when = `${new Date(s.startTime).toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })} · ${new Date(s.startTime).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}–${new Date(s.endTime).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  const missing = data.rows.filter((r) => !r.code).length;

  return (
    <div className="min-h-screen bg-white text-[#1B2A22] print:bg-white">
      <style>{`@media print { .no-print { display: none !important; } .slip { break-inside: avoid; } @page { size: A4; margin: 14mm; } }`}</style>
      <div className="no-print sticky top-0 bg-surface border-b border-line px-6 py-3 flex items-center gap-3 text-[13.5px]">
        <Link to="/admin/sittings" className="lnk">← Schedule the Sitting</Link>
        <span className="flex-1" />
        {missing > 0 && <span className="text-amber-700">{missing} learner{missing === 1 ? " has" : "s have"} no code yet — issue codes from the roster first.</span>}
        <label className="inline-flex items-center gap-2"><input type="checkbox" className="accent-brand-600" checked={slips} onChange={() => setSlips((v) => !v)} /> Print as cut-out slips</label>
        <button type="button" className="btn btn-sm" onClick={() => window.print()}>Print</button>
      </div>

      <div className="mx-auto max-w-[900px] px-8 py-8">
        <div className="flex items-start justify-between border-b-2 border-[#6BBF3E] pb-3 mb-5">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[#2E86AB]">FPT Academy · FPT Exam · Confidential</div>
            <h1 className="font-display text-2xl font-extrabold mt-1">{s.name ?? s.qualificationTitle}</h1>
            <div className="text-sm text-ink-muted mt-0.5">{s.qualificationTitle}</div>
          </div>
          <div className="text-right text-sm">
            <div className="font-semibold">{when}</div>
            {s.venue && <div className="text-ink-muted">{s.venue}</div>}
            <div className="text-ink-muted">{data.rows.length} learners</div>
          </div>
        </div>

        <p className="text-[12.5px] text-ink-muted mb-4">
          Each learner enters their sitting code together with their own 13-digit ID number at <strong>{window.location.origin}/sit</strong>. A code works once; if a learner has to come back in, allow re-entry from the roster. Keep this list with the invigilator and destroy it after the sitting.
        </p>

        {!slips ? (
          <table className="w-full text-[13px] border-collapse">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-ink-muted border-b border-line">
                <th className="py-2 pr-3">#</th><th className="py-2 pr-3">Learner</th><th className="py-2 pr-3">ID number</th><th className="py-2 pr-3">Student no.</th><th className="py-2 pr-3">Sitting code</th><th className="py-2 pr-3">Signature</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={r.sessionId} className="border-b border-line/70">
                  <td className="py-2 pr-3 tabular text-ink-muted">{i + 1}</td>
                  <td className="py-2 pr-3 font-semibold">{r.name}</td>
                  <td className="py-2 pr-3 tabular">{r.idNumberLast4 ? `••••••••• ${r.idNumberLast4}` : "—"}</td>
                  <td className="py-2 pr-3 tabular">{r.studentNumber ?? ""}</td>
                  <td className="py-2 pr-3 font-mono text-[14px] tracking-wider font-bold">{r.code ?? <span className="text-amber-700 font-sans font-normal text-[12px]">not issued</span>}</td>
                  <td className="py-2 pr-3 w-40 border-b border-dotted border-ink-faint"></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {data.rows.map((r) => (
              <div key={r.sessionId} className="slip rounded-lg border border-dashed border-ink-faint p-4">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-[#2E86AB]">FPT Exam sitting code</div>
                <div className="font-semibold text-[15px] mt-1">{r.name}</div>
                <div className="text-[12px] text-ink-muted">{s.name ?? s.qualificationTitle} · {new Date(s.startTime).toLocaleDateString()}</div>
                <div className="font-mono text-2xl tracking-widest font-bold mt-3">{r.code ?? "—"}</div>
                <div className="text-[11.5px] text-ink-muted mt-2">Go to {window.location.host}/sit and enter this code with your ID number.</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
