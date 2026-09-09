import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import type { AssessmentInstrument, Cohort, Qualification, SeriesResponse, SeriesSlotInput, StaffingInfo } from "@shared/types";
import { Card, CardHead, Badge } from "../../components/ui";

// Block 3: one paper, one or more cohorts, several sittings - rooms, dates,
// times - planned and staffed in one go. The server splits the students across
// the slots by capacity, checks every rule (1:30, scope, marking cap, clashes)
// and shows the plan before anything is created.

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const fmtT = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

interface Slot { start: string; durationMin: number; venue: string; capacity: string; invigilatorIds: string[] }

export default function SeriesPlanner({ cohorts, instruments, qualifications, onCreated, onError }: {
  cohorts: Cohort[];
  instruments: AssessmentInstrument[];
  qualifications: Qualification[];
  onCreated: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [cohortIds, setCohortIds] = useState<string[]>([]);
  const [instrumentId, setInstrumentId] = useState("");
  const [assessorId, setAssessorId] = useState("");
  const [independent, setIndependent] = useState(false);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [staffing, setStaffing] = useState<StaffingInfo | null>(null);
  const [preview, setPreview] = useState<SeriesResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const paper = instruments.find((i) => i.id === instrumentId);
  const chosen = cohorts.filter((c) => cohortIds.includes(c.id));
  const students = chosen.reduce((s, c) => s + c.members, 0);
  const qualTitle = (id: string) => qualifications.find((q) => q.id === id)?.title ?? "";

  // Papers for the chosen cohorts' qualification first.
  const papers = useMemo(() => {
    const qs = new Set(chosen.map((c) => c.qualificationId).filter(Boolean));
    return [...instruments].filter((i) => i.intakeStatus === "ready" || i.intakeStatus === "override").sort((a, b) => Number(!qs.has(a.qualificationId)) - Number(!qs.has(b.qualificationId)));
  }, [instruments, chosen]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (paper) params.set("qualificationId", paper.qualificationId);
    if (slots.length) {
      const starts = slots.map((s) => new Date(s.start).getTime()).filter(Boolean);
      if (starts.length) {
        params.set("start", new Date(Math.min(...starts)).toISOString());
        params.set("end", new Date(Math.max(...slots.map((s) => new Date(s.start).getTime() + s.durationMin * 60000))).toISOString());
      }
    }
    api.get<StaffingInfo>(`/sittings/staffing?${params}`).then(setStaffing).catch(() => {});
  }, [paper?.qualificationId, slots.length]); // eslint-disable-line react-hooks/exhaustive-deps

  function addSlot() {
    const last = slots[slots.length - 1];
    const start = last ? new Date(new Date(last.start).getTime() + (last.durationMin + 60) * 60000) : (() => { const d = new Date(Date.now() + 7 * 86400000); d.setHours(9, 0, 0, 0); return d; })();
    setSlots([...slots, { start: toLocalInput(start), durationMin: last?.durationMin ?? paper?.timeAllocationMinutes ?? 180, venue: last?.venue ?? "", capacity: last?.capacity ?? "", invigilatorIds: [] }]);
    setPreview(null);
  }
  const update = (i: number, patch: Partial<Slot>) => { setSlots(slots.map((s, k) => (k === i ? { ...s, ...patch } : s))); setPreview(null); };
  const remove = (i: number) => { setSlots(slots.filter((_, k) => k !== i)); setPreview(null); };

  // How many sittings would the cohort need at a given room size?
  const [roomSize, setRoomSize] = useState(60);
  function autoSlots() {
    if (!students || !roomSize) return;
    const n = Math.ceil(students / roomSize);
    const d = new Date(Date.now() + 7 * 86400000); d.setHours(9, 0, 0, 0);
    const dur = paper?.timeAllocationMinutes ?? 180;
    const out: Slot[] = [];
    for (let i = 0; i < n; i++) {
      const start = new Date(d.getTime() + Math.floor(i / 2) * 86400000 + (i % 2) * (dur + 90) * 60000);
      out.push({ start: toLocalInput(start), durationMin: dur, venue: "", capacity: String(roomSize), invigilatorIds: [] });
    }
    setSlots(out);
    setPreview(null);
  }

  function body(dryRun: boolean, acceptWarnings = false) {
    const slotInputs: SeriesSlotInput[] = slots.map((s) => ({
      startTime: new Date(s.start).toISOString(),
      endTime: new Date(new Date(s.start).getTime() + s.durationMin * 60000).toISOString(),
      venue: s.venue || undefined,
      capacity: s.capacity ? Number(s.capacity) : undefined,
      invigilatorIds: s.invigilatorIds,
    }));
    return { name: name.trim() || `${chosen.map((c) => c.name).join(" + ")} · ${paper?.version ?? "paper"}`, instrumentId, cohortIds, assessorId, independentInvigilationRequired: independent, slots: slotInputs, dryRun, acceptWarnings };
  }

  async function check() {
    if (!cohortIds.length || !instrumentId || !assessorId || !slots.length) return onError("Choose the cohort(s), the paper, the assessor and at least one sitting first.");
    setBusy(true); onError("");
    try {
      setPreview(await api.post<SeriesResponse>("/sittings/series", body(true)));
    } catch (err) {
      // A blocking problem comes back as 400 with the plan attached; show it.
      const body = (err as Error & { body?: SeriesResponse }).body;
      if (body?.plan) setPreview(body);
      else onError((err as Error).message);
    } finally { setBusy(false); }
  }

  async function create() {
    if (!preview) return;
    setBusy(true); onError("");
    try {
      const r = await api.post<SeriesResponse>("/sittings/series", body(false, true));
      onCreated(`${r.sittings?.length} sittings created for ${chosen.map((c) => c.name).join(", ")}: ${r.placed} of ${r.totalLearners} students placed${r.unplaced ? ` (${r.unplaced} left off - no seat)` : ""}. Every one is on its roster.`);
      setSlots([]); setPreview(null); setName("");
    } catch (err) { onError((err as Error).message); } finally { setBusy(false); }
  }

  const invigilatorsFor = (s: Slot) => (staffing?.invigilators ?? []).filter((i) => !independent || i.employment === "external").map((i) => {
    const start = new Date(s.start).getTime(), end = start + s.durationMin * 60000;
    const inOther = slots.some((o) => o !== s && o.invigilatorIds.includes(i.id) && new Date(o.start).getTime() < end && new Date(o.start).getTime() + o.durationMin * 60000 > start);
    return { ...i, clash: i.busy.length > 0 || inOther };
  });
  const blocking = preview?.problems.filter((p) => p.blocking) ?? [];
  const warnings = preview?.problems.filter((p) => !p.blocking) ?? [];

  return (
    <Card className="mb-5">
      <CardHead title="Plan a series of sittings" subtitle="One paper, written by a cohort (or several) across more than one room, date or time. Students are split across the sittings by seat count; each sitting is checked against the 1-to-30 rule, the assessor's scope and marking cap, and clashes before anything is created." />
      <div className="px-5 pt-4 pb-5 space-y-5">
        <div className="grid grid-cols-3 gap-3.5">
          <div>
            <label className="field-lbl">Cohort(s)</label>
            <div className="rounded-lg border border-line max-h-40 overflow-auto divide-y divide-line">
              {cohorts.map((c) => (
                <label key={c.id} className="flex items-center gap-2 px-3 py-1.5 text-[13px] cursor-pointer hover:bg-surface-2">
                  <input type="checkbox" className="accent-brand-600" checked={cohortIds.includes(c.id)} onChange={() => { setCohortIds((v) => (v.includes(c.id) ? v.filter((x) => x !== c.id) : [...v, c.id])); setPreview(null); }} />
                  <span className="flex-1 truncate">{c.name}</span>
                  <span className="tabular text-ink-muted">{c.members}</span>
                </label>
              ))}
              {cohorts.length === 0 && <p className="t-sub p-3">No cohorts yet.</p>}
            </div>
            {students > 0 && <p className="t-sub mt-1.5">{students.toLocaleString()} students to place · {Math.ceil(students / 30)} invigilator-slots at 1:30</p>}
          </div>
          <div className="space-y-3.5">
            <div>
              <label className="field-lbl">Paper</label>
              <select className="inp" value={instrumentId} onChange={(e) => { setInstrumentId(e.target.value); setPreview(null); }}>
                <option value="">Choose a paper…</option>
                {papers.map((i) => <option key={i.id} value={i.id}>{qualTitle(i.qualificationId)} — {i.version} · {i.timeAllocationMinutes} min</option>)}
              </select>
            </div>
            <div>
              <label className="field-lbl">Assessor of record</label>
              <select className="inp" value={assessorId} onChange={(e) => { setAssessorId(e.target.value); setPreview(null); }}>
                <option value="">Choose…</option>
                {[...(staffing?.assessors ?? [])].sort((a, b) => (a.inScope === true ? 0 : a.inScope === null ? 1 : 2) - (b.inScope === true ? 0 : b.inScope === null ? 1 : 2) || a.inFlight / a.cap - b.inFlight / b.cap).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.inFlight}/{a.cap} scripts{a.inScope === false ? " · NOT in scope" : a.inScope === null && paper ? " · scope not recorded" : ""}
                  </option>
                ))}
              </select>
              {assessorId && students > 0 && (() => { const a = staffing?.assessors.find((x) => x.id === assessorId); if (!a) return null; const after = a.inFlight + students; return <p className={"t-sub mt-1 " + (after > a.cap ? "!text-amber-700" : "")}>{a.name} would have {after} scripts in flight against a cap of {a.cap}{after > a.cap ? " — over the cap; split the marking across assessors per sitting below, or accept the warning." : "."}</p>; })()}
            </div>
            <label className="inline-flex items-center gap-2 text-[13px] cursor-pointer"><input type="checkbox" className="accent-brand-600" checked={independent} onChange={() => { setIndependent((v) => !v); setPreview(null); }} /> Requires independent (external) invigilation</label>
          </div>
          <div className="space-y-3.5">
            <div>
              <label className="field-lbl">Series name <span className="normal-case font-normal text-ink-faint">— optional</span></label>
              <input className="inp" value={name} onChange={(e) => setName(e.target.value)} placeholder={chosen.length ? `${chosen[0].name} · FISA` : "e.g. ND Payroll FISA · Oct 2026"} />
            </div>
            <div className="rounded-lg border border-line bg-surface-2/60 p-3 space-y-2">
              <div className="field-lbl">Quick plan</div>
              <div className="flex items-center gap-2 text-[13px]">
                <span>Room seats</span>
                <input className="inp !w-20 tabular" type="number" min={1} value={roomSize} onChange={(e) => setRoomSize(Number(e.target.value))} />
                <button type="button" className="btn-ghost btn-sm" disabled={!students} onClick={autoSlots}>Make {students && roomSize ? Math.ceil(students / roomSize) : ""} sittings</button>
              </div>
              <p className="t-sub">Two a day from next week; then adjust dates, venues and invigilators below.</p>
            </div>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="field-lbl">Sittings ({slots.length})</div>
            <button type="button" className="btn-ghost btn-sm" onClick={addSlot}>+ Add a sitting</button>
          </div>
          {slots.length === 0 ? (
            <p className="t-sub rounded-lg border border-dashed border-line p-4 text-center">Add sittings one by one, or use Quick plan.</p>
          ) : (
            <div className="space-y-2">
              {slots.map((s, i) => {
                const planRow = preview?.plan.find((p) => p.slot === i + 1);
                const need = planRow?.invigilatorsNeeded ?? (s.capacity ? Math.max(1, Math.ceil(Number(s.capacity) / 30)) : null);
                return (
                  <div key={i} className="rounded-lg border border-line p-3 grid grid-cols-[28px_1fr_90px_1fr_90px_2fr_28px] gap-3 items-start">
                    <div className="font-display font-bold text-ink-muted pt-2">{i + 1}</div>
                    <div><label className="field-lbl">Start</label><input className="inp" type="datetime-local" value={s.start} onChange={(e) => update(i, { start: e.target.value })} /></div>
                    <div><label className="field-lbl">Minutes</label><input className="inp tabular" type="number" min={15} value={s.durationMin} onChange={(e) => update(i, { durationMin: Number(e.target.value) })} /></div>
                    <div><label className="field-lbl">Venue / room</label><input className="inp" value={s.venue} onChange={(e) => update(i, { venue: e.target.value })} placeholder="e.g. Durban Lab 2" /></div>
                    <div><label className="field-lbl">Seats</label><input className="inp tabular" type="number" min={1} value={s.capacity} onChange={(e) => update(i, { capacity: e.target.value })} placeholder="even" /></div>
                    <div>
                      <label className="field-lbl">
                        Invigilators
                        {need != null && <span className={"normal-case font-normal ml-2 " + (s.invigilatorIds.length >= need ? "text-brand-700" : "text-amber-700")}>{s.invigilatorIds.length} of {need} needed{planRow ? ` for ${planRow.learners} students` : ""}</span>}
                      </label>
                      <div className="flex flex-wrap gap-1.5 items-center">
                        {s.invigilatorIds.map((id) => {
                          const inv = invigilatorsFor(s).find((x) => x.id === id);
                          return (
                            <span key={id} className={"inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12.5px] " + (inv?.clash ? "border-amber-300 bg-amber-50 text-amber-800" : "border-brand-600 bg-brand-50 text-brand-800")} title={inv?.clash ? "Already on another sitting at this time" : ""}>
                              {inv?.name ?? "…"}{inv?.clash ? " ⚠" : ""}
                              <button type="button" className="ml-0.5 opacity-60 hover:opacity-100" onClick={() => update(i, { invigilatorIds: s.invigilatorIds.filter((x) => x !== id) })}>✕</button>
                            </span>
                          );
                        })}
                        <select className="inp !w-auto !py-1 text-[12.5px]" value="" onChange={(e) => { if (e.target.value) update(i, { invigilatorIds: [...s.invigilatorIds, e.target.value] }); }}>
                          <option value="">+ Add invigilator…</option>
                          {invigilatorsFor(s).filter((inv) => !s.invigilatorIds.includes(inv.id)).sort((a, b) => Number(a.clash) - Number(b.clash) || a.name.localeCompare(b.name)).map((inv) => (
                            <option key={inv.id} value={inv.id}>{inv.name}{inv.clash ? " — busy at this time" : ""}{inv.employment === "external" ? " (external)" : ""}</option>
                          ))}
                        </select>
                        {s.invigilatorIds.length === 0 && need != null && need <= 8 && (
                          <button type="button" className="btn-ghost btn-sm" onClick={() => update(i, { invigilatorIds: invigilatorsFor(s).filter((x) => !x.clash).slice(0, need).map((x) => x.id) })}>
                            Fill {need} free
                          </button>
                        )}
                      </div>
                    </div>
                    <button type="button" className="text-ink-faint hover:text-ink pt-2" title="Remove this sitting" onClick={() => remove(i)}>✕</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {preview && (
          <div className={"rounded-lg border p-4 space-y-2 " + (blocking.length ? "border-red-200 bg-red-50/50" : warnings.length ? "border-amber-200 bg-amber-50/50" : "border-brand-200 bg-brand-50/50")}>
            <div className="font-display font-semibold text-[13.5px]">
              Plan: {preview.placed} of {preview.totalLearners} students across {preview.plan.length} sitting{preview.plan.length === 1 ? "" : "s"}
            </div>
            <ul className="text-[13px] space-y-0.5">
              {preview.plan.map((p) => <li key={p.slot}>Sitting {p.slot} · {fmtT(p.startTime)}{p.venue ? ` · ${p.venue}` : ""} — <span className="tabular">{p.learners}</span> students, {p.invigilators} of {p.invigilatorsNeeded} invigilators</li>)}
            </ul>
            {preview.problems.length > 0 && (
              <ul className="text-[13px] space-y-0.5 pt-1">
                {preview.problems.map((p, k) => <li key={k}><Badge tone={p.blocking ? "amber" : "gray"}>{p.blocking ? "must fix" : "note"}</Badge> {p.slot ? `Sitting ${p.slot}: ` : ""}{p.message}</li>)}
              </ul>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button type="button" className="btn-ghost" disabled={busy} onClick={check}>{busy ? "Checking…" : preview ? "Re-check the plan" : "Check the plan"}</button>
          <button type="button" className="btn" disabled={busy || !preview || blocking.length > 0} onClick={create}>
            {preview && warnings.length ? "Create with the notes above" : "Create the sittings"}
          </button>
          {preview && blocking.length > 0 && <span className="text-[13px] text-red-700">Fix the items marked "must fix" first.</span>}
        </div>
      </div>
    </Card>
  );
}
